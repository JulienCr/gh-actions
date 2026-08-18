/**
 * Ce que les deux clients partagent : lire un flux, nommer une panne, reprendre.
 *
 * Ces morceaux viennent de `ollama.ts`, où chacun a été écrit contre une panne
 * réelle. Les mettre en commun plutôt que les recopier dans le client
 * OpenAI-compatible : un correctif payé une fois ne se re-paie pas, et deux
 * copies d'une garde finissent par en faire une et demie.
 *
 * L'appel est **streamé** chez les deux providers, et ce n'est pas un choix
 * d'ergonomie : en `stream: false`, le serveur ne renvoie pas un octet, pas
 * même les en-têtes, avant d'avoir fini de générer, et le `fetch` de Node
 * abandonne au bout de 300 s d'attente d'en-têtes. Ce plafond est celui
 * d'undici (`headersTimeout`), il ne se règle pas depuis l'API publique de
 * Node, et il ignore l'`AbortSignal`. Mesuré sur wolfgangparis#578 : la passe
 * la plus bavarde (31 158 tokens de sortie) tombait à 300,8 s en `TypeError:
 * fetch failed`. En streaming, les en-têtes arrivent tout de suite et le délai
 * se réarme à chaque fragment.
 */

import { LlmError, type ChatRequest, type ChatResult } from './types';

/** 15 minutes par défaut, réglable par l'input `timeout-minutes`. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Une seule reprise : un quota épuisé ne se répare pas en insistant. */
const RETRY_DELAY_MS = 20_000;

/**
 * Découpe le corps de la réponse en lignes, au fil de l'eau.
 *
 * Un fragment TCP ne s'aligne pas sur les lignes : il peut en contenir trois, ou
 * couper la troisième en son milieu, y compris entre les deux octets d'un
 * caractère accentué. D'où le tampon, et le `stream: true` du décodeur.
 *
 * Sert au NDJSON d'Ollama comme au SSE d'OpenAI : les deux sont des formats à
 * une ligne par événement, seule l'enveloppe de la ligne diffère.
 */
export async function* streamLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.indexOf('\n');
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) yield line;
      cut = buffer.indexOf('\n');
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) yield rest;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 429 et 5xx valent une seconde tentative ; un 401 ou un 404 de modèle, non. */
export const worthRetrying = (status: number) => status === 429 || status >= 500;

/** Le raisonnement est-il coupé, plutôt que réglé à un niveau ? */
export const wantsNoThinking = (value: string) => /^(false|off|none|no|0)$/i.test(value.trim());

export function describeStatus(status: number): string {
  if (status === 401 || status === 403) return '(clé refusée)';
  if (status === 404) return '(modèle inconnu)';
  if (status === 402) return '(crédit épuisé)';
  if (status === 429) return '(quota ou limite de débit atteinte)';
  if (status >= 500) return '(panne côté provider)';
  return '';
}

export function detail(body: string): string {
  const trimmed = body.trim();
  return trimmed ? ` : ${redact(trimmed.slice(0, 300))}` : '';
}

/**
 * Traduit une panne de transport en erreur explicite.
 *
 * Rien de la requête n'est recopié ici. Ce qu'on ne maîtrise pas, en revanche,
 * c'est ce que le message d'undici contient de son côté : il cite volontiers
 * l'URL visée, d'où le masquage de `redact`. Les clés voyagent dans un en-tête
 * et n'apparaissent dans aucun de ces messages.
 */
export function transportError(error: unknown, timeoutMs: number, provider: string): LlmError {
  // Un dépassement de délai ne se reprend pas : le même prompt reprendrait le
  // même temps, et deux tentatives dépasseraient le budget du job.
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new LlmError(`${provider} n'a pas répondu en ${Math.round(timeoutMs / 60_000)} min`);
  }
  return new LlmError(`appel à ${provider} impossible (${describeCause(error)})`, true);
}

/**
 * Déplie la chaîne des causes.
 *
 * `fetch` rend un « fetch failed » et rien d'autre : tout ce qui sert au
 * diagnostic est rangé dans `cause`, parfois à deux niveaux. Le journal de CI
 * n'ayant que ce message pour tout témoignage, le tronquer revient à ne rien
 * journaliser.
 */
function describeCause(error: unknown): string {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    // Le code plutôt que le message quand les deux existent : « terminated » ne
    // se cherche pas, « UND_ERR_SOCKET » si.
    const code = (current as { code?: unknown }).code;
    chain.push(typeof code === 'string' ? `${current.message} [${code}]` : current.message);
    current = current.cause;
  }
  return redact(chain.length > 0 ? chain.join(' ← ') : String(error));
}

/**
 * Masque les identifiants qu'une URL trimballerait dans un message d'erreur.
 *
 * Mesuré : `fetch` refuse une URL qui en porte — « Request cannot be
 * constructed from a URL that includes credentials: … » — et cite l'URL
 * entière, mot de passe compris. Le refus garantit qu'aucune connexion n'a eu
 * lieu, mais le message, lui, part dans le journal d'un dépôt public. Ce sont
 * les bases URL configurables qui ouvrent ce chemin, les clés voyageant pour
 * leur part dans un en-tête, qui n'est jamais journalisé.
 */
export const redact = (text: string) => text.replace(/\/\/[^/\s@]+@/g, '//***@');

/**
 * Refus de la **valeur** de `think`, pas de la fonctionnalité.
 *
 * Mesuré chez Ollama : une valeur inconnue rend « invalid think value: … (must
 * be "high", "medium", "low", "max", true, or false) ». Le modèle sait donc
 * raisonner, seul le niveau est mauvais : retomber sur `true` garde le
 * raisonnement à son niveau par défaut, là où retirer le paramètre le
 * supprimerait. Une coquille dans un input ne doit pas coûter la profondeur de
 * la review.
 */
const rejectsThinkingValue = (body: string) => /invalid (think|reasoning_effort) value/i.test(body);

/**
 * La reprise et les deux replis, communs aux providers.
 *
 * Un modèle sans raisonnement explicite reste un modèle utilisable : on rejoue
 * sans `think` plutôt que de rendre l'action inutilisable dès que le dépôt
 * appelant change de modèle.
 */
export async function withRetries(
  attempt: (request: ChatRequest) => Promise<ChatResult>,
  request: ChatRequest,
): Promise<ChatResult> {
  try {
    return await attempt(request);
  } catch (error) {
    if (!(error instanceof LlmError)) throw error;
    if (error.thinkingRejected && request.think) {
      // Un niveau mal orthographié ne coûte que le niveau ; un modèle qui ne
      // raisonne pas coûte le raisonnement. Deux replis, pas un.
      const fallback = rejectsThinkingValue(error.message) ? 'true' : '';
      request.onDowngrade?.(error.message);
      return attempt({ ...request, think: fallback });
    }
    if (!error.retryable) throw error;
    request.onRetry?.(error.message);
    await sleep(request.retryDelayMs ?? RETRY_DELAY_MS);
    return attempt(request);
  }
}
