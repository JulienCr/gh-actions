/**
 * Le contrat commun aux providers. Module **pur**, sans E/S.
 *
 * L'abstraction est délibérément petite : un type de requête, un type de
 * résultat, une erreur. Pas de registre d'outils, pas de middleware, pas de
 * notion de conversation. `pr-review` fait quatre appels sans état, et une
 * couche plus riche que ça serait une couche à maintenir pour rien.
 *
 * Ce qu'elle doit garantir, en revanche, est l'uniformité de l'**usage** rendu :
 * c'est sur ces compteurs que se décide où couper, et un provider qui rendrait
 * ses tokens sous un autre nom obligerait chaque appelant à connaître le
 * provider, ce que toute l'abstraction sert précisément à éviter.
 */

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * Ce qu'un appel a consommé, dans un vocabulaire unique.
 *
 * Un champ à `0` veut dire « ce provider ne l'expose pas » aussi bien que
 * « il valait zéro ». Les deux se confondent volontairement : distinguer un
 * inconnu d'un zéro obligerait tout le reste du programme à traiter des
 * `null`, pour une différence qui ne change aucune décision. Ce qui compte est
 * qu'un compteur absent ne soit jamais rendu comme une mesure inventée.
 */
export interface Usage {
  inputTokens: number;
  /**
   * Part de l'entrée servie depuis le cache de préfixe du provider.
   *
   * C'est LA mesure du levier principal de ce module : deux passes qui
   * partagent un préfixe de quatre-vingt-dix kilo-octets ne le paient qu'une
   * fois si ce compteur monte. À zéro alors qu'on l'attendait plein, le
   * préfixe a divergé et le réglage est à revoir.
   */
  cachedInputTokens: number;
  outputTokens: number;
  /** Part de la sortie passée en raisonnement. `0` : non exposé. */
  reasoningTokens: number;
}

export interface ChatResult {
  content: string;
  /**
   * Taille du raisonnement rendu à part, en caractères.
   *
   * Doublonne `usage.reasoningTokens` là où le provider le donne, et le
   * remplace là où il ne le donne pas (Ollama). Voir `stats.ts`.
   */
  thinkingChars: number;
  usage: Usage;
  durationMs: number;
}

export interface ChatRequest {
  apiKey: string;
  /** Sans barre oblique finale. Le client y ajoute son chemin. */
  baseUrl: string;
  model: string;
  /**
   * Les messages dans l'ordre. Le préfixe partagé entre deux passes se joue
   * ici : voir `buildPassMessages` dans `passes.ts`.
   */
  messages: ChatMessage[];
  /**
   * Effort de raisonnement : `low`, `medium`, `high`, `max`, un booléen, ou
   * vide pour laisser au modèle son défaut. Ce que chaque provider en fait lui
   * appartient.
   */
  think?: string;
  temperature?: number;
  /** Ignoré par les providers qui ne le prennent pas, sans que ce soit une erreur. */
  seed?: number;
  timeoutMs?: number;
  /** Sert aux tests, qui ne peuvent pas attendre vingt secondes. */
  retryDelayMs?: number;
  onRetry?: (reason: string) => void;
  /** Prévient quand le modèle a refusé `think` et qu'on rejoue sans. */
  onDowngrade?: (reason: string) => void;
}

/**
 * Une panne d'appel, quel que soit le provider.
 *
 * Les deux drapeaux valent plus que le message : ils décident du repli, et ce
 * sont les seuls que `index.ts` regarde.
 */
export class LlmError extends Error {
  /** Une seconde tentative a-t-elle une chance d'aboutir ? */
  readonly retryable: boolean;
  /** Le modèle a refusé `think` : rejouer sans est la seule issue. */
  readonly thinkingRejected: boolean;

  constructor(message: string, retryable = false, thinkingRejected = false) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
    this.thinkingRejected = thinkingRejected;
  }
}

export type LlmClient = (request: ChatRequest) => Promise<ChatResult>;

/** Un usage vide, pour les chemins où le provider n'a rien rendu. */
export const NO_USAGE: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};
