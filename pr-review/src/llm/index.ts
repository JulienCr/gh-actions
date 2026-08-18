/**
 * Les providers connus, et ce que leurs tokens coûtent. Module **pur**.
 *
 * Trois entrées seulement, et deux clients dessous : `ollama` parle le dialecte
 * d'Ollama, `deepseek` et `openai` parlent celui d'OpenAI. Ajouter Fireworks,
 * Z.ai ou OpenRouter demain revient à ajouter une ligne ici, pas une couche.
 *
 * C'est aussi le seul endroit qui sait qu'un provider ignore la graine ou ne
 * rend aucun compteur de cache : le reste du programme n'a pas à connaître le
 * provider qu'il appelle.
 */

import { ollamaClient } from './ollama';
import { createOpenAiClient } from './openai';
import type { LlmClient, Usage } from './types';

export * from './types';

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
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  ollama: {
    label: 'Ollama Cloud',
    client: ollamaClient,
    defaultBaseUrl: 'https://ollama.com',
    prefixCache: false,
    supportsSeed: true,
  },
  deepseek: {
    label: 'DeepSeek',
    client: createOpenAiClient({
      name: 'DeepSeek',
      // Le seul dialecte qui coupe le raisonnement autrement que par un niveau.
      thinkingOff: { thinking: { type: 'disabled' } },
    }),
    defaultBaseUrl: 'https://api.deepseek.com',
    prefixCache: true,
    supportsSeed: false,
  },
  openai: {
    label: 'endpoint OpenAI-compatible',
    client: createOpenAiClient({ name: 'le provider' }),
    defaultBaseUrl: '',
    // Le cache de préfixe automatique est la norme chez les endpoints
    // OpenAI-compatibles. Un endpoint qui n'en ferait pas ne perdrait qu'un peu
    // de parallélisme, là où l'inverse perdrait l'économie tout entière.
    prefixCache: true,
    supportsSeed: false,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const isProvider = (value: string): boolean => value in PROVIDERS;

/**
 * Tarif public, en dollars par million de tokens.
 *
 * Le tarif **plein** de DeepSeek est retenu, pas le tarif creux : une
 * estimation doit pouvoir décevoir vers le bas, jamais vers le haut. Un modèle
 * absent de cette table n'est pas chiffré du tout, ce qui est le cas d'Ollama
 * Cloud, vendu au quota et non au token.
 *
 * Cette table vieillira. C'est assumé : elle sert à situer un ordre de grandeur
 * dans un journal de CI, pas à tenir une comptabilité. Les tokens, eux, sont
 * rapportés bruts et ne vieillissent pas.
 */
export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

export const PRICES: Record<string, Price> = {
  'deepseek/deepseek-v4-flash': { input: 0.44, cachedInput: 0.014, output: 1.32 },
  'deepseek/deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
};

/**
 * Ce qu'un appel a coûté, ou `null` quand on ne sait pas.
 *
 * `null` et non zéro : un quota Ollama consommé n'est pas un appel gratuit, et
 * additionner des zéros produirait un total qui ment sur ce qu'il additionne.
 */
export function estimateCost(provider: string, model: string, usage: Usage): number | null {
  const price = PRICES[`${provider}/${model}`];
  if (!price) return null;
  // `inputTokens` inclut la part servie par le cache : la facturer au plein
  // tarif la compterait deux fois et effacerait précisément l'économie qu'on
  // cherche à mesurer.
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (fresh * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output) /
    1_000_000
  );
}
