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
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  ollama: {
    label: 'Ollama Cloud',
    client: ollamaClient,
    defaultBaseUrl: 'https://ollama.com',
    defaultModel: 'glm-5.2:cloud',
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
    defaultModel: 'deepseek-flash',
    prefixCache: true,
    supportsSeed: false,
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
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const isProvider = (value: string): boolean => value in PROVIDERS;

/**
 * Public pricing, in dollars per million tokens.
 *
 * Retrieved from api-docs.deepseek.com on 2026-09-15. `deepseek-flash` is the
 * recommended name for DeepSeek-V4.1-Flash; the legacy `deepseek-v4-flash` now
 * resolves to it, same price. `deepseek-v4-pro` remains distinct, billed
 * separately. Peak hours run 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri only;
 * the rest, weekends included, is half price. This table will age in turn.
 */
export interface Price {
  input: number;
  cachedInput: number;
  output: number;
}

/** Peak-hour pricing. Off-peak is half, cf. `priceFor`. */
export const PRICES: Record<string, Price> = {
  'deepseek/deepseek-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
  'deepseek/deepseek-v4-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
  'deepseek/deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
};

/**
 * Is this instant a DeepSeek peak hour?
 *
 * The date is injected rather than read: this module stays pure, and a test
 * doesn't pass or fail depending on the time of day it runs. Peak hours only
 * count Monday through Friday.
 */
export function isPeakHour(now: Date): boolean {
  const hour = now.getUTCHours();
  const day = now.getUTCDay();
  const isWeekday = day >= 1 && day <= 5;
  return isWeekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
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
  const ratio = peak ? 1 : OFF_PEAK_RATIO;
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
