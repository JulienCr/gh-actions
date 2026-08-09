/**
 * Appel de chat à Ollama Cloud.
 *
 * `fetch` natif et rien d'autre : l'action tourne sans `node_modules`
 * (cf. l'en-tête de `exec.ts`).
 *
 * Pas de `format: <schéma>` ici, bien que l'API l'accepte en local : la doc
 * Ollama précise que **le cloud ne prend pas les structured outputs**. La sortie
 * est donc du markdown libre, cadré par le gabarit du prompt et rattrapé par
 * `render.ts`, plutôt qu'un JSON qu'on croirait garanti et qui casserait un
 * vendredi soir.
 */

const DEFAULT_HOST = 'https://ollama.com';
/**
 * 15 minutes par défaut, réglable par l'input `timeout-minutes`. Mesuré sur des
 * PR réelles (15 fichiers, ~107k tokens en entrée) : entre 1 min 30 et 8 min 15
 * selon la longueur du raisonnement. La marge est là pour la queue de
 * distribution, pas pour le cas moyen.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Une seule reprise : un quota épuisé ne se répare pas en insistant. */
const RETRY_DELAY_MS = 20_000;

export interface ChatOptions {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  timeoutMs?: number;
  /** Sert aux tests, qui ne peuvent pas attendre vingt secondes. */
  retryDelayMs?: number;
  onRetry?: (reason: string) => void;
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  evalTokens: number;
  durationMs: number;
}

export class OllamaError extends Error {
  /** Une seconde tentative a-t-elle une chance d'aboutir ? */
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'OllamaError';
    this.retryable = retryable;
  }
}

interface ChatPayload {
  message?: { content?: string; thinking?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 429 et 5xx valent une seconde tentative ; un 401 ou un 404 de modèle, non. */
const worthRetrying = (status: number) => status === 429 || status >= 500;

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const started = Date.now();
  try {
    const payload = await request(options);
    return {
      content: payload.message?.content ?? '',
      promptTokens: payload.prompt_eval_count ?? 0,
      evalTokens: payload.eval_count ?? 0,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    if (!(error instanceof OllamaError) || !error.retryable) throw error;
    options.onRetry?.(error.message);
    await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
    const payload = await request(options);
    return {
      content: payload.message?.content ?? '',
      promptTokens: payload.prompt_eval_count ?? 0,
      evalTokens: payload.eval_count ?? 0,
      durationMs: Date.now() - started,
    };
  }
}

async function request(options: ChatOptions): Promise<ChatPayload> {
  const host = (process.env.OLLAMA_HOST ?? DEFAULT_HOST).replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        // Une review doit être reproductible : deux lectures du même diff ne
        // doivent pas rendre deux verdicts différents.
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Ni l'URL ni les en-têtes ne sont repris ici : la clé ne doit jamais
    // atterrir dans un journal de CI.
    const reason = error instanceof Error ? error.message : String(error);
    // Un dépassement de délai ne se reprend pas : le même prompt reprendrait le
    // même temps, et deux tentatives dépasseraient le budget du job.
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new OllamaError(`Ollama n'a pas répondu en ${Math.round(timeoutMs / 60_000)} min`);
    }
    throw new OllamaError(`appel à Ollama impossible (${reason})`, true);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new OllamaError(
      `HTTP ${response.status} ${describeStatus(response.status)}${detail(text)}`,
      worthRetrying(response.status),
    );
  }

  let payload: ChatPayload;
  try {
    payload = JSON.parse(text) as ChatPayload;
  } catch {
    throw new OllamaError(`réponse illisible d'Ollama (${text.slice(0, 200)})`);
  }
  if (payload.error) throw new OllamaError(`Ollama a répondu une erreur : ${payload.error}`);
  if (!payload.message?.content?.trim()) {
    // Un contenu vide arrive quand tout est parti dans `thinking` : le dire
    // vaut mieux que poster un commentaire vide.
    throw new OllamaError('Ollama a rendu une réponse vide');
  }
  return payload;
}

function describeStatus(status: number): string {
  if (status === 401 || status === 403) return '(clé refusée)';
  if (status === 404) return '(modèle inconnu)';
  if (status === 429) return '(quota ou limite de débit atteinte)';
  if (status >= 500) return '(panne côté Ollama)';
  return '';
}

function detail(body: string): string {
  const trimmed = body.trim();
  return trimmed ? ` : ${trimmed.slice(0, 300)}` : '';
}
