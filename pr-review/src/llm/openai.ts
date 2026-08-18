/**
 * Client pour toute API compatible OpenAI : DeepSeek aujourd'hui, Fireworks,
 * Z.ai ou OpenRouter demain, sans rien réécrire.
 *
 * Streamé, pour la même raison qu'Ollama (voir l'en-tête de `http.ts`), avec un
 * piège en plus : **en streaming, l'usage n'est pas rendu** sauf à demander
 * `stream_options: { include_usage: true }`. Sans ce champ, tous les compteurs
 * de ce module resteraient à zéro, et l'instrumentation qui justifie ce chantier
 * ne mesurerait rien.
 *
 * Le compteur qui compte est `prompt_cache_hit_tokens`. Deux passes qui
 * partagent un préfixe de quatre-vingt-dix kilo-octets ne le paient qu'une fois
 * si la seconde part **après** la première (le cache est écrit à la fin de
 * l'entrée) et si le préfixe est identique **octet pour octet**. Ces deux
 * conditions sont tenues ailleurs : le séquencement dans `index.ts`, la
 * stabilité du préfixe dans `prompt.ts` et `passes.ts`. Ici on se contente de
 * rapporter le résultat, ce qui est la seule façon de voir qu'il a été perdu.
 */

import {
  DEFAULT_TIMEOUT_MS,
  describeStatus,
  detail,
  scrub,
  streamLines,
  wantsNoThinking,
  transportError,
  withRetries,
  worthRetrying,
} from './http';
import { LlmError, type ChatRequest, type ChatResult, type Usage } from './types';

export interface OpenAiDialect {
  /** Nom affiché dans les messages d'erreur. */
  name: string;
  /**
   * Ce qu'il faut envoyer pour COUPER le raisonnement.
   *
   * Le seul endroit où les dialectes divergent vraiment : DeepSeek coupe par
   * `thinking: { type: 'disabled' }`, là où `reasoning_effort` ne connaît que
   * des niveaux. Un provider qui n'a pas d'équivalent laisse ce champ vide, et
   * « couper le raisonnement » revient alors à ne rien demander.
   */
  thinkingOff?: Record<string, unknown>;
}

interface Delta {
  content?: string;
  /** Convention des modèles de raisonnement : le raisonnement à part du texte. */
  reasoning_content?: string;
}

interface StreamChunk {
  choices?: { delta?: Delta; finish_reason?: string | null }[];
  usage?: RawUsage | null;
  error?: { message?: string } | string;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek. */
  prompt_cache_hit_tokens?: number;
  /** Convention OpenAI. */
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Traduit l'usage du provider dans le vocabulaire commun.
 *
 * Les deux conventions de cache sont lues, parce qu'aucune n'est standard et
 * qu'un provider ajouté demain suivra l'une ou l'autre. Un champ absent vaut
 * zéro : mieux vaut un compteur muet qu'un compteur inventé.
 */
function readUsage(raw: RawUsage | null | undefined): Usage {
  return {
    inputTokens: raw?.prompt_tokens ?? 0,
    cachedInputTokens:
      raw?.prompt_cache_hit_tokens ?? raw?.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: raw?.completion_tokens ?? 0,
    reasoningTokens: raw?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * Ce qu'on envoie pour régler le raisonnement.
 *
 * On transmet le niveau tel quel plutôt que de le valider : ce que chaque
 * modèle accepte lui appartient (DeepSeek prend `low`, `high`, `max` et ramène
 * `medium` sur `high`), et une liste écrite ici serait périmée au prochain
 * modèle. Un niveau refusé est rattrapé par le repli de `withRetries`.
 */
function reasoningBody(think: string | undefined, dialect: OpenAiDialect): Record<string, unknown> {
  const value = (think ?? '').trim();
  if (value === '') return {};
  if (wantsNoThinking(value)) return dialect.thinkingOff ?? {};
  // Un booléen vrai demande « raisonne », pas « raisonne à tel point » : ne rien
  // envoyer laisse au modèle son réglage par défaut, qui est exactement ça.
  if (/^(true|yes|on)$/i.test(value)) return {};
  return { reasoning_effort: value.toLowerCase() };
}

/**
 * Le serveur a-t-il rejeté la demande de raisonnement ?
 *
 * On teste le message et pas le seul code : un 400 vient aussi d'un prompt trop
 * long, et rejouer sans raisonnement n'y changerait rien.
 */
const rejectsThinking = (status: number, body: string) =>
  status === 400 && /reasoning|thinking/i.test(body);

export function createOpenAiClient(dialect: OpenAiDialect) {
  async function attempt(request: ChatRequest): Promise<ChatResult> {
    const started = Date.now();
    const collected = await send(request, dialect);
    return { ...collected, durationMs: Date.now() - started };
  }

  return (request: ChatRequest): Promise<ChatResult> => withRetries(attempt, request);
}

type Collected = Omit<ChatResult, 'durationMs'>;

async function send(request: ChatRequest, dialect: OpenAiDialect): Promise<Collected> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(`${request.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        // Sans ceci, aucun compteur n'arrive en streaming. Voir l'en-tête.
        stream_options: { include_usage: true },
        // `seed` n'est volontairement pas envoyé : il n'est documenté chez aucun
        // des dialectes visés, et un paramètre inconnu se paie d'un 400 sur les
        // serveurs stricts. La stabilité y repose sur la température seule.
        temperature: request.temperature ?? 1,
        ...reasoningBody(request.think, dialect),
        messages: request.messages,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw transportError(error, timeoutMs, dialect.name, request.apiKey);
  }

  try {
    if (!response.ok) {
      const text = await response.text();
      throw new LlmError(
        `HTTP ${response.status} ${describeStatus(response.status)}${detail(text, request.apiKey)}`,
        worthRetrying(response.status),
        rejectsThinking(response.status, text),
      );
    }
    return await collect(response, dialect, request.apiKey);
  } catch (error) {
    if (error instanceof LlmError) throw error;
    throw transportError(error, timeoutMs, dialect.name, request.apiKey);
  }
}

/** Recompose la réponse à partir des événements `data:` du flux. */
async function collect(
  response: Response,
  dialect: OpenAiDialect,
  apiKey: string,
): Promise<Collected> {
  let content = '';
  let thinking = '';
  let usage: Usage | null = null;
  let complete = false;
  let truncated = false;
  let fragments = 0;

  for await (const line of streamLines(response.body!)) {
    // Le SSE porte aussi des lignes `event:`, `id:` et des commentaires `:` que
    // rien n'oblige un provider à omettre : tout ce qui n'est pas une donnée
    // est ignoré, plutôt que traité comme un fragment illisible.
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      complete = true;
      continue;
    }

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      // Une ligne illisible APRÈS des fragments valides est le dernier fragment
      // coupé en son milieu : même panne que l'absence de `[DONE]`, donc même
      // traitement, plutôt qu'une review perdue sur un alignement d'octets.
      if (fragments > 0) break;
      throw new LlmError(
        `réponse illisible de ${dialect.name} (${scrub(payload.slice(0, 200), apiKey)})`,
      );
    }
    fragments += 1;

    if (chunk.error) {
      // Certaines erreurs arrivent en 200 avec un corps d'erreur.
      const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? '');
      throw new LlmError(
        `${dialect.name} a répondu une erreur : ${scrub(message, apiKey)}`,
        false,
        /reasoning|thinking/i.test(message),
      );
    }

    for (const choice of chunk.choices ?? []) {
      content += choice.delta?.content ?? '';
      thinking += choice.delta?.reasoning_content ?? '';
      if (choice.finish_reason) {
        complete = true;
        // Le modèle a tapé son plafond de sortie : ce qui suit manque, et rien
        // dans le texte ne le dira. Une review amputée postée avec l'aplomb
        // d'une review entière est pire que pas de review du tout.
        if (choice.finish_reason === 'length') truncated = true;
      }
    }
    // L'usage arrive sur un fragment final sans `choices`, mais rien n'interdit
    // à un provider de le poser ailleurs : on prend le dernier vu.
    if (chunk.usage) usage = readUsage(chunk.usage);
  }

  if (!complete) {
    throw new LlmError(`le flux de ${dialect.name} s'est interrompu avant la fin de la réponse`, true);
  }
  if (truncated) {
    throw new LlmError(`${dialect.name} a coupé sa réponse au plafond de tokens de sortie`);
  }
  if (!content.trim()) {
    // Un contenu vide arrive quand tout est parti dans le raisonnement : le
    // dire vaut mieux que poster un commentaire vide.
    throw new LlmError(`${dialect.name} a rendu une réponse vide`);
  }

  return {
    content,
    thinkingChars: thinking.length,
    // Un usage absent laisse des compteurs à zéro : le provider n'a pas honoré
    // `include_usage`, ce que la ligne de journal montrera. Ce n'est pas une
    // raison de perdre une review déjà payée.
    usage: usage ?? readUsage(null),
  };
}
