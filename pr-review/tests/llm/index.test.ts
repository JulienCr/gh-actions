import { describe, expect, it } from 'vitest';

import { estimateCost, isProvider, PRICES, PROVIDERS } from '../../src/llm';

describe('les providers connus', () => {
  it('couvre Ollama, DeepSeek et un endpoint OpenAI-compatible générique', () => {
    expect(Object.keys(PROVIDERS).sort()).toEqual(['deepseek', 'ollama', 'openai']);
    expect(isProvider('deepseek')).toBe(true);
    expect(isProvider('nawak')).toBe(false);
  });

  /**
   * Sans base par défaut, le provider générique viserait api.openai.com par
   * accident. Le déclarer inutilisable tant qu'on ne lui donne pas d'adresse
   * vaut mieux que d'envoyer quatre-vingt-dix kilo-octets au mauvais endroit.
   */
  it('ne donne pas d’adresse par défaut au provider générique', () => {
    expect(PROVIDERS.openai!.defaultBaseUrl).toBe('');
    expect(PROVIDERS.deepseek!.defaultBaseUrl).toBe('https://api.deepseek.com');
  });

  it('sait quels providers ignorent la graine', () => {
    expect(PROVIDERS.ollama!.supportsSeed).toBe(true);
    expect(PROVIDERS.deepseek!.supportsSeed).toBe(false);
  });
});

describe('l’estimation de coût', () => {
  const usage = (over: Record<string, number> = {}) => ({
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    ...over,
  });

  it('facture un million de tokens d’entrée au tarif du modèle', () => {
    expect(estimateCost('deepseek', 'deepseek-v4-flash', usage())).toBeCloseTo(
      PRICES['deepseek/deepseek-v4-flash']!.input,
      6,
    );
  });

  /**
   * `inputTokens` inclut la part servie par le cache : la facturer au plein
   * tarif la compterait deux fois et effacerait précisément l'économie qu'on
   * cherche à mesurer.
   */
  it('ne facture pas deux fois la part servie par le cache', () => {
    const cost = estimateCost(
      'deepseek',
      'deepseek-v4-flash',
      usage({ cachedInputTokens: 1_000_000 }),
    );
    expect(cost).toBeCloseTo(PRICES['deepseek/deepseek-v4-flash']!.cachedInput, 6);
  });

  it('rend un coût trente fois moindre quand tout le préfixe est en cache', () => {
    const froid = estimateCost('deepseek', 'deepseek-v4-flash', usage())!;
    const chaud = estimateCost(
      'deepseek',
      'deepseek-v4-flash',
      usage({ cachedInputTokens: 1_000_000 }),
    )!;
    expect(froid / chaud).toBeGreaterThan(30);
  });

  /**
   * `null` et non zéro : un quota Ollama consommé n'est pas un appel gratuit,
   * et additionner des zéros produirait un total qui ment sur ce qu'il
   * additionne.
   */
  it('rend null pour un modèle hors table, plutôt qu’un zéro trompeur', () => {
    expect(estimateCost('ollama', 'glm-5.2:cloud', usage())).toBeNull();
    expect(estimateCost('deepseek', 'modele-de-demain', usage())).toBeNull();
  });
});
