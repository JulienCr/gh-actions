/**
 * Les providers connus, et ce que leurs tokens coûtent. Module **pur**.
 *
 * Quatre entrées, et deux clients dessous : `ollama` parle le dialecte
 * d'Ollama, `deepseek`, `openai` et `aws` parlent celui d'OpenAI. Ajouter
 * Fireworks ou OpenRouter demain revient à ajouter une ligne ici, pas une couche.
 *
 * C'est aussi le seul endroit qui sait qu'un provider ignore la graine ou ne
 * rend aucun compteur de cache : le reste du programme n'a pas à connaître le
 * provider qu'il appelle.
 */

import { signRequest } from './sigv4';
import { ollamaClient } from './ollama';
import { createOpenAiClient } from './openai';
import { LlmError, type ChatRequest, type LlmClient, type Usage } from './types';

export * from './types';
// La phrase d'un repli se formule là où la décision se prend, pas au point
// d'appel : voir l'en-tête de `describeDowngrade`.
export { describeDowngrade } from './http';

export interface ProviderSpec {
  /** Nom lisible, pour les avertissements adressés à un humain. */
  label: string;
  client: LlmClient;
  /**
   * Base par défaut. Vide pour `openai`, qui n'existe que pour pointer vers un
   * endpoint qu'on lui donne : sans base configurée, ce provider est inutilisable
   * et le dire vaut mieux que viser api.openai.com par accident.
   */
  defaultBaseUrl: string;
  /**
   * Modèle servi quand le dépôt n'en nomme aucun.
   *
   * Vide pour le provider générique, qui n'a aucun catalogue connu : là, un
   * défaut serait une devinette, et l'appelant prévient plutôt que d'inventer.
   */
  defaultModel: string;
  /**
   * Enchaîner deux appels ici achète-t-il un préfixe en cache ?
   *
   * C'est la question qui décide si deux passes de même destination partent en
   * séquence ou ensemble. Ollama Cloud n'expose aucun compteur de cache et ses
   * utilisateurs mesurent un taux nul : les sérialiser tripleraiterait le mur du
   * job pour rien. Les endpoints OpenAI-compatibles visés font au contraire du
   * cache de préfixe automatique, et le facturent trente fois moins.
   */
  prefixCache: boolean;
  /**
   * Le provider honore-t-il `seed` ?
   *
   * DeepSeek ne le documente pas, et un paramètre inconnu se paie d'un 400 sur
   * les serveurs stricts : on ne l'envoie pas, et l'appelant prévient une fois
   * plutôt que de laisser croire à une review reproductible.
   */
  supportsSeed: boolean;
  /**
   * Comment le provider s'authentifie.
   *
   * `aws-sigv4` n'a pas de clé à exiger : c'est ce champ qui permet à
   * `endpointFor` de le déclarer utilisable sans relâcher la garde des autres.
   */
  auth: 'api-key' | 'aws-sigv4';
}

/**
 * Signe une requête Bedrock et y ajoute l'en-tête JSON.
 *
 * `signRequest` couvre déjà `content-type`, en minuscules, dans les en-têtes
 * signées : lui en ajouter un second sous une autre casse ferait diverger la
 * requête envoyée de celle qui a été signée.
 */
function bedrockHeaders(request: ChatRequest, body: string): Record<string, string> {
  if (!request.aws) {
    // Ne devrait pas arriver : `endpointFor` ne construit cette destination
    // qu'avec des credentials. Le test reste, faute de quoi un appel non signé
    // partirait en 403 après avoir envoyé quatre-vingt-dix kilo-octets.
    throw new LlmError('appel Bedrock sans credentials AWS résolues');
  }
  return signRequest({
    method: 'POST',
    url: `${request.baseUrl}/chat/completions`,
    body,
    region: request.aws.region,
    service: 'bedrock',
    credentials: request.aws.credentials,
    now: new Date(),
  });
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  ollama: {
    label: 'Ollama Cloud',
    client: ollamaClient,
    defaultBaseUrl: 'https://ollama.com',
    defaultModel: 'glm-5.2:cloud',
    prefixCache: false,
    supportsSeed: true,
    auth: 'api-key',
  },
  deepseek: {
    label: 'DeepSeek',
    client: createOpenAiClient({
      name: 'DeepSeek',
      // Le seul dialecte qui coupe le raisonnement autrement que par un niveau.
      thinkingOff: { thinking: { type: 'disabled' } },
    }),
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    prefixCache: true,
    supportsSeed: false,
    auth: 'api-key',
  },
  openai: {
    label: 'endpoint OpenAI-compatible',
    client: createOpenAiClient({ name: 'le provider' }),
    defaultBaseUrl: '',
    defaultModel: '',
    // « OpenAI-compatible » décrit un protocole, pas une garantie de cache. On
    // ne présume donc rien : sérialiser deux passes chez un endpoint qui ne
    // cache pas coûte du temps contre rien. L'input « openai-prefix-cache »
    // l'active pour qui sait que son endpoint le fait.
    prefixCache: false,
    supportsSeed: false,
    auth: 'api-key',
  },
  aws: {
    label: 'AWS Bedrock',
    client: createOpenAiClient({
      name: 'Bedrock',
      authorize: bedrockHeaders,
      emptyMeansReasoning: true,
      // Mesuré sur les trois modèles : le raisonnement fuit dans `content`
      // entre balises `<reasoning>` à `high` (jamais à `low` ni sans réglage),
      // et `max` y rend un 400 alors que `high` est le vrai plafond.
      stripsReasoningTags: true,
      levelAliases: { max: 'high' },
    }),
    // La base dépend de la région, que ce module ne connaît pas : c'est
    // `endpointFor` qui la compose.
    defaultBaseUrl: '',
    defaultModel: 'zai.glm-5',
    // Aucun compteur de cache n'est rendu par cet endpoint : mesuré.
    prefixCache: false,
    supportsSeed: false,
    auth: 'aws-sigv4',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const isProvider = (value: string): boolean => value in PROVIDERS;

/**
 * Tarif public, en dollars par million de tokens.
 *
 * Relevé sur api-docs.deepseek.com le 2026-08-18. ⚠️ DeepSeek est passé le
 * **16 août 2026** d'un tarif plat à un tarif horaire : toute table écrite
 * avant cette date est périmée d'un facteur trois, et une review a bien failli
 * m'en faire adopter une. Les heures pleines vont de 01:00 à 04:00 et de 06:00
 * à 10:00 UTC ; le reste est à moitié prix.
 *
 * Cette table vieillira à son tour. C'est assumé : elle sert à situer un ordre
 * de grandeur dans un journal de CI, pas à tenir une comptabilité. Les tokens,
 * eux, sont rapportés bruts et ne vieillissent pas.
 */
export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

/**
 * Tarif on-demand standard de Bedrock en `eu-north-1`, relevé le 2026-09-07 via
 * `aws pricing get-products --service-code AmazonBedrock --filters
 * Type=TERM_MATCH,Field=regionCode,Value=eu-north-1` (usagetypes
 * `EUN1-zai.glm5-{input,output}-tokens` et
 * `EUN1-zai.glm-4.7-flash-{input,output}-tokens`, hors variantes batch/flex/
 * priority/mantle). `cachedInput` vaut le tarif d'entrée : aucun compteur de
 * cache n'existe pour ces modèles sur Bedrock, ce champ ne sera donc jamais
 * multiplié que par zéro.
 */
const bedrockPrice = (input: number, output: number): Price => ({ input, cachedInput: input, output });

/** Tarif d'heure pleine. L'heure creuse vaut la moitié, cf. `priceFor`. */
export const PRICES: Record<string, Price> = {
  'deepseek/deepseek-v4-flash': { input: 0.44, cachedInput: 0.014, output: 1.32 },
  'deepseek/deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
  'aws/zai.glm-5': bedrockPrice(1.2, 3.84),
  'aws/zai.glm-4.7-flash': bedrockPrice(0.08, 0.48),
};

/**
 * L'instant est-il en heure pleine chez DeepSeek ?
 *
 * La date est injectée plutôt que lue : ce module reste pur, et un test qui
 * dépendrait de l'heure qu'il est passerait ou non selon le moment du jour.
 */
export function isPeakHour(now: Date): boolean {
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

const OFF_PEAK_RATIO = 0.5;

/**
 * Ce qu'un appel a coûté, ou `null` quand on ne sait pas.
 *
 * `null` et non zéro : un quota Ollama consommé n'est pas un appel gratuit, et
 * additionner des zéros produirait un total qui ment sur ce qu'il additionne.
 */
export function estimateCost(
  provider: string,
  model: string,
  usage: Usage,
  peak = true,
): number | null {
  const price = PRICES[`${provider}/${model}`];
  if (!price) return null;
  // Le tarif horaire n'existe que chez DeepSeek : l'appliquer à un autre
  // provider diviserait son coût par deux hors heures pleines sans aucune base
  // réelle. Latent tant qu'aws n'avait pas de tarif, ce test l'a rendu réel.
  const ratio = !peak && provider === 'deepseek' ? OFF_PEAK_RATIO : 1;
  // `inputTokens` inclut la part servie par le cache : la facturer au plein
  // tarif la compterait deux fois et effacerait précisément l'économie qu'on
  // cherche à mesurer.
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (ratio *
      (fresh * price.input +
        usage.cachedInputTokens * price.cachedInput +
        usage.outputTokens * price.output)) /
    1_000_000
  );
}
