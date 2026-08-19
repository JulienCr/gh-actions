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
  /**
   * Plafond de tokens de SORTIE d'une requête. `0` ou absent : rien n'est
   * envoyé, et le modèle garde le sien.
   *
   * Borne l'autre dimension que `timeoutMs` : un modèle qui part en boucle de
   * raisonnement ne dépasse pas le délai, il consomme son plafond à lui, et le
   * job le paie en entier avant d'apprendre qu'il n'y avait pas de réponse.
   */
  maxOutputTokens?: number;
  /** Sert aux tests, qui ne peuvent pas attendre vingt secondes. */
  retryDelayMs?: number;
  onRetry?: (reason: string) => void;
  /**
   * Prévient qu'une tentative est rejouée avec moins de raisonnement.
   *
   * Un événement et non une phrase : les trois causes ci-dessous mènent à trois
   * rejeux différents, et le point d'appel n'a aucun moyen de deviner lequel a
   * eu lieu. Il en a déjà écrit un faux (cf. `describeDowngrade`).
   */
  onDowngrade?: (event: Downgrade) => void;
}

/**
 * Pourquoi une tentative est rejouée avec moins de raisonnement.
 *
 * Trois causes distinctes, qu'un seul libellé confondait : un modèle qui a trop
 * raisonné n'est pas un modèle qui a refusé de raisonner, et un niveau mal
 * orthographié n'est pas un modèle sans raisonnement.
 */
export type DowngradeCause =
  /** Le raisonnement a mangé toute la génération, sans laisser de réponse. */
  | 'reasoning-exhausted'
  /** « invalid think value » : le niveau est refusé, pas la fonctionnalité. */
  | 'level-rejected'
  /** Le modèle ne sait pas raisonner sur demande. */
  | 'thinking-unsupported';

export interface Downgrade {
  cause: DowngradeCause;
  /** Le niveau demandé avant repli. */
  from: string;
  /** Ce qui repart : un niveau, `'true'`, ou `''` pour « sans raisonnement ». */
  to: string;
  /** Le message du provider, déjà passé par `scrub`. */
  reason: string;
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
  /**
   * Le raisonnement a consommé toute la génération, sans laisser de réponse.
   *
   * Distinct d'un refus : le modèle sait raisonner, il a même trop raisonné.
   * Rejouer d'un cran plus bas est la réponse, là où retirer le raisonnement
   * coûterait la profondeur qu'on paie précisément.
   */
  readonly reasoningExhausted: boolean;

  constructor(
    message: string,
    retryable = false,
    thinkingRejected = false,
    reasoningExhausted = false,
  ) {
    super(message);
    this.name = 'LlmError';
    this.retryable = retryable;
    this.thinkingRejected = thinkingRejected;
    this.reasoningExhausted = reasoningExhausted;
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
