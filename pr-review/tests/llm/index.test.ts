import { describe, expect, it } from 'vitest';

import { estimateCost, isPeakHour, isProvider, PRICES, PROVIDERS } from '../../src/llm';

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

/**
 * DeepSeek est passé le 16 août 2026 d'un tarif plat à un tarif horaire. Une
 * review m'a proposé les anciens chiffres, plus bas d'un facteur trois ; la
 * table vérifiée à la source est celle-ci, et c'est le régime horaire qui fait
 * la différence, pas le tarif.
 */
describe('le régime horaire', () => {
  it('reconnaît les deux fenêtres d’heures pleines, en UTC', () => {
    expect(isPeakHour(new Date('2026-08-18T02:30:00Z'))).toBe(true);
    expect(isPeakHour(new Date('2026-08-18T07:00:00Z'))).toBe(true);
    expect(isPeakHour(new Date('2026-08-18T05:00:00Z'))).toBe(false);
    expect(isPeakHour(new Date('2026-08-18T20:00:00Z'))).toBe(false);
    // Bornes : 04:00 et 10:00 sont déjà creuses, 01:00 et 06:00 déjà pleines.
    expect(isPeakHour(new Date('2026-08-18T04:00:00Z'))).toBe(false);
    expect(isPeakHour(new Date('2026-08-18T10:00:00Z'))).toBe(false);
    expect(isPeakHour(new Date('2026-08-18T01:00:00Z'))).toBe(true);
    expect(isPeakHour(new Date('2026-08-18T06:00:00Z'))).toBe(true);
  });

  it('facture l’heure creuse à moitié prix', () => {
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    const plein = estimateCost('deepseek', 'deepseek-v4-flash', usage, true)!;
    const creux = estimateCost('deepseek', 'deepseek-v4-flash', usage, false)!;
    expect(creux).toBeCloseTo(plein / 2, 6);
  });
});

describe('les défauts par provider', () => {
  /** Un nom Ollama envoyé à DeepSeek, c'était un 404 sur les quatre appels. */
  it('donne un modèle par défaut aux providers qui ont un catalogue connu', () => {
    expect(PROVIDERS.ollama!.defaultModel).toBe('glm-5.2:cloud');
    expect(PROVIDERS.deepseek!.defaultModel).toBe('deepseek-v4-flash');
  });

  /** Deviner le catalogue d'un endpoint inconnu serait pire que de le dire. */
  it('n’en invente pas un pour l’endpoint générique', () => {
    expect(PROVIDERS.openai!.defaultModel).toBe('');
  });

  /** « OpenAI-compatible » décrit un protocole, pas une garantie de cache. */
  it('ne présume pas de cache de préfixe sur l’endpoint générique', () => {
    expect(PROVIDERS.openai!.prefixCache).toBe(false);
    expect(PROVIDERS.deepseek!.prefixCache).toBe(true);
    expect(PROVIDERS.ollama!.prefixCache).toBe(false);
  });
});
