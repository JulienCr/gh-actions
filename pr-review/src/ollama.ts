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
  /**
   * Effort de raisonnement : `low`, `medium`, `high`, `max`, ou un booléen.
   * Vide : le paramètre n'est pas envoyé et le modèle garde son défaut.
   */
  think?: string;
  /**
   * Vaut 1 par défaut côté appelant, pas 0 : sur un modèle de raisonnement, le
   * décodage glouton appauvrit la chaîne de pensée et la fait tourner en rond.
   * C'est la valeur des exemples officiels de GLM-5.
   */
  temperature?: number;
  /** Rend deux lectures du même diff comparables, dans la mesure du possible. */
  seed?: number;
  timeoutMs?: number;
  /** Sert aux tests, qui ne peuvent pas attendre vingt secondes. */
  retryDelayMs?: number;
  onRetry?: (reason: string) => void;
  /** Prévient quand le modèle a refusé `think` et qu'on rejoue sans. */
  onDowngrade?: (reason: string) => void;
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  evalTokens: number;
  durationMs: number;
  /**
   * Taille du raisonnement rendu à part, en caractères.
   *
   * Reporté dans le pied de page du commentaire : c'est la seule mesure qui dit
   * si le modèle a creusé ou expédié, et donc si régler `think` a servi à
   * quelque chose. Vaut 0 quand le modèle mêle son raisonnement au contenu.
   */
  thinkingChars: number;
}

export class OllamaError extends Error {
  /** Une seconde tentative a-t-elle une chance d'aboutir ? */
  readonly retryable: boolean;
  /** Le modèle a refusé `think` : rejouer sans est la seule issue. */
  readonly thinkingRejected: boolean;
  constructor(message: string, retryable = false, thinkingRejected = false) {
    super(message);
    this.name = 'OllamaError';
    this.retryable = retryable;
    this.thinkingRejected = thinkingRejected;
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

/**
 * `think` accepte un niveau (`low`, `medium`, `high`, `max`) ou un booléen.
 *
 * On transmet la valeur telle quelle plutôt que de la valider contre une liste :
 * ce que chaque modèle accepte lui appartient, et une liste écrite ici serait
 * périmée au prochain modèle. Une valeur refusée est rattrapée par le repli de
 * `chat`, qui distingue les deux refus possibles.
 */
function parseThink(value: string): string | boolean {
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true') return true;
  if (/^(false|off|none)$/.test(normalised)) return false;
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
 * Refus de la **valeur**, pas de la fonctionnalité.
 *
 * Mesuré : une valeur inconnue rend « invalid think value: … (must be "high",
 * "medium", "low", "max", true, or false) ». Le modèle sait donc raisonner, seul
 * le niveau est mauvais : retomber sur `true` garde le raisonnement à son niveau
 * par défaut, là où retirer le paramètre le supprimerait. Une coquille dans un
 * input ne doit pas coûter la profondeur de la review.
 */
const rejectsThinkingValue = (body: string) => /invalid think value/i.test(body);

export async function chat(options: ChatOptions): Promise<ChatResult> {
  const started = Date.now();
  const done = (payload: ChatPayload): ChatResult => ({
    content: payload.message?.content ?? '',
    promptTokens: payload.prompt_eval_count ?? 0,
    evalTokens: payload.eval_count ?? 0,
    thinkingChars: payload.message?.thinking?.length ?? 0,
    durationMs: Date.now() - started,
  });

  try {
    return done(await request(options));
  } catch (error) {
    if (!(error instanceof OllamaError)) throw error;
    // Un modèle sans raisonnement explicite reste un modèle utilisable : on
    // rejoue sans `think` plutôt que de rendre une action inutilisable dès que
    // le dépôt appelant change de modèle.
    if (error.thinkingRejected && options.think) {
      // Un niveau mal orthographié ne coûte que le niveau ; un modèle qui ne
      // raisonne pas coûte le raisonnement. Deux replis, pas un.
      const fallback = rejectsThinkingValue(error.message) ? 'true' : '';
      options.onDowngrade?.(error.message);
      return done(await request({ ...options, think: fallback }));
    }
    if (!error.retryable) throw error;
    options.onRetry?.(error.message);
    await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
    return done(await request(options));
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
        ...(options.think ? { think: parseThink(options.think) } : {}),
        // Une review doit rester comparable d'un jour à l'autre : c'est la
        // graine qui s'en charge, pas une température nulle, qui sur un modèle
        // de raisonnement coûterait la moitié de sa profondeur d'analyse.
        options: {
          temperature: options.temperature ?? 1,
          ...(options.seed === undefined ? {} : { seed: options.seed }),
        },
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
      rejectsThinking(response.status, text),
    );
  }

  let payload: ChatPayload;
  try {
    payload = JSON.parse(text) as ChatPayload;
  } catch {
    throw new OllamaError(`réponse illisible d'Ollama (${text.slice(0, 200)})`);
  }
  if (payload.error) {
    // Certaines erreurs arrivent en 200 avec un corps d'erreur : le refus du
    // raisonnement en fait partie, d'où le même test que sur la voie 400.
    throw new OllamaError(
      `Ollama a répondu une erreur : ${payload.error}`,
      false,
      /think/i.test(payload.error),
    );
  }
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
