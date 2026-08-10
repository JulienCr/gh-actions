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
 *
 * L'appel est **streamé**, et ce n'est pas un choix d'ergonomie : en
 * `stream: false`, Ollama ne renvoie pas un octet — pas même les en-têtes —
 * avant d'avoir fini de générer, et le `fetch` de Node abandonne au bout de
 * 300 s d'attente d'en-têtes. Ce plafond est celui d'undici (`headersTimeout`),
 * il ne se règle pas depuis l'API publique de Node, et il ignore
 * l'`AbortSignal` posé plus bas. Mesuré sur wolfgangparis#578 : la passe la plus
 * bavarde (31 158 tokens de sortie) tombait à 300,8 s en `TypeError: fetch
 * failed`, était reprise, et ne passait qu'à ~290 s — dix secondes sous le mur.
 * En streaming, les en-têtes arrivent tout de suite et le délai se réarme à
 * chaque fragment : la durée totale de génération n'a plus de plafond implicite.
 */

const DEFAULT_HOST = 'https://ollama.com';
/**
 * 15 minutes par défaut, réglable par l'input `timeout-minutes`.
 *
 * Depuis le passage au streaming, cette valeur est le vrai plafond : elle porte
 * sur l'appel **et** sur la lecture du flux. Auparavant elle ne s'appliquait
 * qu'à l'attente des en-têtes, derrière un plafond d'undici trois fois plus bas
 * qui la rendait décorative.
 *
 * Mesuré sur des PR réelles (15 fichiers, ~107k tokens en entrée) : entre
 * 1 min 30 et 8 min 15 selon la longueur du raisonnement. La marge est là pour
 * la queue de distribution, pas pour le cas moyen.
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

/**
 * Un fragment du flux, tel qu'Ollama l'écrit : une ligne de JSON par salve de
 * tokens. Seul le dernier fragment (`done: true`) porte les compteurs.
 */
interface StreamChunk extends ChatPayload {
  done?: boolean;
}

/**
 * Découpe le corps de la réponse en lignes, au fil de l'eau.
 *
 * Un fragment TCP ne s'aligne pas sur les lignes : il peut en contenir trois, ou
 * couper la troisième en son milieu, y compris entre les deux octets d'un
 * caractère accentué. D'où le tampon, et le `stream: true` du décodeur.
 */
async function* streamLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

/**
 * Un aller-retour, chronométré pour lui seul.
 *
 * Le chrono vit ici et non dans `chat` : une durée qui engloberait la tentative
 * ratée et l'attente entre les deux ne mesurerait plus la génération, qui est la
 * seule chose que le pied de page prétend rapporter.
 */
async function attempt(options: ChatOptions): Promise<ChatResult> {
  const started = Date.now();
  const payload = await request(options);
  return {
    content: payload.message?.content ?? '',
    promptTokens: payload.prompt_eval_count ?? 0,
    evalTokens: payload.eval_count ?? 0,
    thinkingChars: payload.message?.thinking?.length ?? 0,
    durationMs: Date.now() - started,
  };
}

export async function chat(options: ChatOptions): Promise<ChatResult> {
  try {
    return await attempt(options);
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
      return attempt({ ...options, think: fallback });
    }
    if (!error.retryable) throw error;
    options.onRetry?.(error.message);
    await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
    return attempt(options);
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
        stream: true,
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
    throw transportError(error, timeoutMs);
  }

  // Toute lecture du corps est soumise au même traitement que l'appel : en
  // streaming, l'essentiel de l'attente se passe après que `fetch` a résolu sur
  // les seuls en-têtes. Une panne de transport y arrive donc bien plus souvent
  // que sur l'appel lui-même — y compris sur le corps d'un refus, court mais
  // pas garanti d'arriver.
  try {
    if (!response.ok) {
      const text = await response.text();
      throw new OllamaError(
        `HTTP ${response.status} ${describeStatus(response.status)}${detail(text)}`,
        worthRetrying(response.status),
        rejectsThinking(response.status, text),
      );
    }
    return await collect(response);
  } catch (error) {
    if (error instanceof OllamaError) throw error;
    throw transportError(error, timeoutMs);
  }
}

/**
 * Traduit une panne de transport en erreur explicite.
 *
 * Rien de la requête n'est recopié ici. Ce qu'on ne maîtrise pas, en revanche,
 * c'est ce que le message d'undici contient de son côté : il cite volontiers
 * l'URL visée, d'où le masquage de `redact`. La clé de l'API, elle, voyage dans
 * un en-tête et n'apparaît dans aucun de ces messages.
 */
function transportError(error: unknown, timeoutMs: number): OllamaError {
  // Un dépassement de délai ne se reprend pas : le même prompt reprendrait le
  // même temps, et deux tentatives dépasseraient le budget du job.
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new OllamaError(`Ollama n'a pas répondu en ${Math.round(timeoutMs / 60_000)} min`);
  }
  return new OllamaError(`appel à Ollama impossible (${describeCause(error)})`, true);
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
 * lieu, mais le message, lui, part dans le journal d'un dépôt public. C'est
 * `OLLAMA_HOST` qui ouvre ce chemin, la clé de l'API voyageant pour sa part
 * dans un en-tête, qui n'est jamais journalisé.
 */
const redact = (text: string) => text.replace(/\/\/[^/\s@]+@/g, '//***@');

/** Recompose la réponse complète à partir des fragments du flux. */
async function collect(response: Response): Promise<ChatPayload> {
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
      throw new OllamaError(`réponse illisible d'Ollama (${line.slice(0, 200)})`);
    }
    fragments += 1;
    if (chunk.error) {
      // Certaines erreurs arrivent en 200 avec un corps d'erreur : le refus du
      // raisonnement en fait partie, d'où le même test que sur la voie 400.
      throw new OllamaError(
        `Ollama a répondu une erreur : ${chunk.error}`,
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
    throw new OllamaError("le flux d'Ollama s'est interrompu avant la fin de la réponse", true);
  }
  if (!content.trim()) {
    // Un contenu vide arrive quand tout est parti dans `thinking` : le dire
    // vaut mieux que poster un commentaire vide.
    throw new OllamaError('Ollama a rendu une réponse vide');
  }
  return {
    message: { content, thinking },
    prompt_eval_count: promptTokens,
    eval_count: evalTokens,
  };
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
