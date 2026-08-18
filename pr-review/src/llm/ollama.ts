/**
 * Client Ollama Cloud.
 *
 * `fetch` natif et rien d'autre : l'action tourne sans `node_modules`
 * (cf. l'en-tête de `exec.ts`).
 *
 * Pas de `format: <schéma>` ici, bien que l'API l'accepte en local : la doc
 * Ollama précise que **le cloud ne prend pas les structured outputs**. La sortie
 * est donc du markdown libre, cadré par le gabarit du prompt et rattrapé par
 * `render.ts`, plutôt qu'un JSON qu'on croirait garanti et qui casserait un
 * vendredi soir.
 *
 * Ollama Cloud n'expose **aucun compteur de cache** : `usage.cachedInputTokens`
 * y vaut toujours zéro, et ce n'est pas une mesure à zéro mais une absence de
 * mesure. C'est la raison pour laquelle le gros contexte commun est envoyé
 * ailleurs (cf. `llm/index.ts`).
 */

import {
  DEFAULT_TIMEOUT_MS,
  describeStatus,
  detail,
  scrub,
  streamLines,
  transportError,
  wantsNoThinking,
  withRetries,
  worthRetrying,
} from './http';
import { LlmError, type ChatRequest, type ChatResult } from './types';

interface ChatPayload {
  message?: { content?: string; thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Un fragment du flux, tel qu'Ollama l'écrit : une ligne de JSON par salve de
 * tokens. Seul le dernier fragment (`done: true`) porte les compteurs.
 */
interface StreamChunk extends ChatPayload {
  done?: boolean;
}

/**
 * `think` accepte un niveau (`low`, `medium`, `high`, `max`) ou un booléen.
 *
 * On transmet la valeur telle quelle plutôt que de la valider contre une liste :
 * ce que chaque modèle accepte lui appartient, et une liste écrite ici serait
 * périmée au prochain modèle. Une valeur refusée est rattrapée par le repli de
 * `withRetries`, qui distingue les deux refus possibles.
 */
function parseThink(value: string): string | boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true') return true;
  // La même définition que le client OpenAI-compatible, et pas une seconde
  // écrite à côté : celle-ci ignorait « no » et « 0 », si bien qu'un
  // « thinking: no » coupait le raisonnement chez un provider et le laissait
  // à son défaut chez l'autre.
  if (wantsNoThinking(normalised)) return false;
  return normalised;
}

/**
 * Le serveur a-t-il rejeté la demande de raisonnement ?
 *
 * On teste le message et pas le seul code : un 400 vient aussi d'un prompt trop
 * long, et rejouer sans `think` n'y changerait rien.
 *
 * Le corps d'un refus de valeur n'est pas du JSON valide (Ollama n'échappe pas
 * les guillemets qu'il cite : `invalid think value: "nawak" (...)`), d'où le
 * test sur le texte brut, avant toute tentative d'analyse.
 */
const rejectsThinking = (status: number, body: string) => status === 400 && /think/i.test(body);

/**
 * Un aller-retour, chronométré pour lui seul.
 *
 * Le chrono vit ici et non dans `withRetries` : une durée qui engloberait la
 * tentative ratée et l'attente entre les deux ne mesurerait plus la génération,
 * qui est la seule chose que le pied de page prétend rapporter.
 */
async function attempt(request: ChatRequest): Promise<ChatResult> {
  const started = Date.now();
  const payload = await send(request);
  return {
    content: payload.message?.content ?? '',
    thinkingChars: payload.message?.thinking?.length ?? 0,
    usage: {
      inputTokens: payload.prompt_eval_count ?? 0,
      // Ollama Cloud ne dit rien de son cache. Voir l'en-tête du module.
      cachedInputTokens: 0,
      outputTokens: payload.eval_count ?? 0,
      // `eval_count` englobe le raisonnement sans le distinguer : le seul
      // rapport disponible est celui des tailles en caractères, que
      // `thinkingChars` porte déjà.
      reasoningTokens: 0,
    },
    durationMs: Date.now() - started,
  };
}

export const ollamaClient = (request: ChatRequest): Promise<ChatResult> =>
  withRetries(attempt, request);

async function send(request: ChatRequest): Promise<ChatPayload> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(`${request.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        ...(request.think ? { think: parseThink(request.think) } : {}),
        // Une review doit rester comparable d'un jour à l'autre : c'est la
        // graine qui s'en charge, pas une température nulle, qui sur un modèle
        // de raisonnement coûterait la moitié de sa profondeur d'analyse.
        options: {
          temperature: request.temperature ?? 1,
          ...(request.seed === undefined ? {} : { seed: request.seed }),
        },
        messages: request.messages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw transportError(error, timeoutMs, 'Ollama', request.apiKey);
  }

  // Toute lecture du corps est soumise au même traitement que l'appel : en
  // streaming, l'essentiel de l'attente se passe après que `fetch` a résolu sur
  // les seuls en-têtes. Une panne de transport y arrive donc bien plus souvent
  // que sur l'appel lui-même — y compris sur le corps d'un refus, court mais
  // pas garanti d'arriver.
  try {
    if (!response.ok) {
      const text = await response.text();
      throw new LlmError(
        `HTTP ${response.status} ${describeStatus(response.status)}${detail(text, request.apiKey)}`,
        worthRetrying(response.status),
        rejectsThinking(response.status, text),
      );
    }
    return await collect(response, request.apiKey);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw transportError(error, timeoutMs, 'Ollama', request.apiKey);
  }
}

/** Recompose la réponse complète à partir des fragments du flux. */
async function collect(response: Response, apiKey: string): Promise<ChatPayload> {
  let content = '';
  let thinking = '';
  let promptTokens = 0;
  let evalTokens = 0;
  let complete = false;
  let fragments = 0;

  for await (const line of streamLines(response.body!)) {
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(line) as StreamChunk;
    } catch {
      // Une ligne illisible APRÈS des fragments valides n'est pas un corps
      // étranger : c'est le dernier fragment, coupé en son milieu. La même
      // panne que l'absence de `done`, à un alignement d'octets près — d'où le
      // même traitement, plutôt qu'un « illisible » non reprisable qui perdrait
      // la review sur ce seul détail.
      if (fragments > 0) break;
      throw new LlmError(`réponse illisible d'Ollama (${scrub(line.slice(0, 200), apiKey)})`);
    }
    fragments += 1;
    if (chunk.error) {
      // Certaines erreurs arrivent en 200 avec un corps d'erreur : le refus du
      // raisonnement en fait partie, d'où le même test que sur la voie 400.
      throw new LlmError(
        `Ollama a répondu une erreur : ${scrub(chunk.error, apiKey)}`,
        false,
        /think/i.test(chunk.error),
      );
    }
    content += chunk.message?.content ?? '';
    thinking += chunk.message?.thinking ?? '';
    // Écrasement et non cumul : ces compteurs sont des totaux, pas des deltas.
    if (chunk.prompt_eval_count !== undefined) promptTokens = chunk.prompt_eval_count;
    if (chunk.eval_count !== undefined) evalTokens = chunk.eval_count;
    if (chunk.done) complete = true;
  }

  if (!complete) {
    // Le vice du streaming : un flux coupé en route laisse un contenu bien
    // formé mais amputé. Sans ce test, une review tronquée serait postée avec
    // l'aplomb d'une review entière — pire que pas de review du tout, parce que
    // le lecteur ne peut pas deviner ce qui manque.
    throw new LlmError("le flux d'Ollama s'est interrompu avant la fin de la réponse", true);
  }
  if (!content.trim()) {
    // Un contenu vide arrive quand tout est parti dans `thinking` : le dire
    // vaut mieux que poster un commentaire vide.
    //
    // Les compteurs sont RECOPIÉS dans le message, et ce n'est pas cosmétique :
    // sans eux, un « réponse vide » dans un journal de CI ne dit pas si le
    // modèle a rendu trois tokens ou brûlé trente mille à réfléchir sans
    // conclure. Ce sont deux pannes opposées, et on ne peut pas les distinguer
    // après coup, l'appel ayant été payé pour rien dans les deux cas.
    throw new LlmError(
      `Ollama a rendu une réponse vide (${evalTokens} tokens de sortie, ` +
        `dont ${thinking.length} caractères de raisonnement, sur ${promptTokens} en entrée)`,
      false,
      false,
      // Du raisonnement mais pas de réponse : la génération s'est arrêtée AVANT
      // de conclure. Un vide sans raisonnement, lui, n'a pas d'explication et
      // ne se rejoue pas plus bas.
      thinking.trim().length > 0,
    );
  }
  return {
    message: { content, thinking },
    prompt_eval_count: promptTokens,
    eval_count: evalTokens,
  };
}
