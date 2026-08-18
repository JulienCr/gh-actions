import { describe, expect, it, vi } from 'vitest';

import {
  ALWAYS_SKIPPED,
  DEFAULT_DOCTRINE,
  DEFAULTS,
  isEnabled,
  readInput,
  resolveConfig,
  UsageError,
  type Env,
} from '../src/inputs';

const resolve = (env: Env = {}, argv: string[] = ['42']) => resolveConfig({ argv, env });

describe('readInput · convention du runner', () => {
  it('lit INPUT_<NOM> en capitales, traits d’union conservés', () => {
    // Contre-intuitif mais c'est ce que pose le runner : seuls les espaces
    // deviennent des tirets bas, pas les traits d'union.
    expect(readInput({ 'INPUT_OLLAMA-API-KEY': ' k ' }, 'ollama-api-key')).toBe('k');
    expect(readInput({}, 'ollama-api-key')).toBe('');
  });
});

describe('isEnabled · interrupteur', () => {
  it('est allumé quand l’input est absent ou vide', () => {
    // Le défaut compte plus que les autres : un dépôt qui branche l'action sans
    // renseigner « enable » doit obtenir une review, pas un silence.
    expect(isEnabled({})).toBe(true);
    expect(isEnabled({ INPUT_ENABLE: '  ' })).toBe(true);
    expect(isEnabled({ INPUT_ENABLE: 'true' })).toBe(true);
  });

  it('est éteint sur les quatre façons d’écrire « non »', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off']) {
      expect(isEnabled({ INPUT_ENABLE: value })).toBe(false);
    }
  });

  it('reste allumé sur une valeur qui ne veut rien dire', () => {
    // Une faute de frappe ne doit pas éteindre en silence : le sens de la panne
    // va vers la review qui tourne, pas vers la PR qu'on croit relue.
    expect(isEnabled({ INPUT_ENABLE: 'faux' })).toBe(true);
  });
});

describe('resolveConfig · numéro de PR', () => {
  it('accepte un positionnel, avec ou sans dièse', () => {
    expect(resolve({}, ['42']).pr).toBe(42);
    expect(resolve({}, ['#42']).pr).toBe(42);
  });

  it('se rabat sur l’input « pr » quand la ligne de commande est vide', () => {
    expect(resolve({ INPUT_PR: '7' }, []).pr).toBe(7);
  });

  it('échoue en UsageError quand il manque, plutôt que de relire au hasard', () => {
    expect(() => resolve({}, [])).toThrow(UsageError);
  });

  it('rejette un argument inconnu au lieu de l’ignorer', () => {
    expect(() => resolve({}, ['42', '--verbeux'])).toThrow(UsageError);
  });

  it('rejette un « --model » sans valeur, qui avalerait le drapeau suivant', () => {
    expect(() => resolve({}, ['42', '--model'])).toThrow(UsageError);
  });
});

describe('resolveConfig · précédence', () => {
  it('applique les défauts quand rien n’est configuré', () => {
    const config = resolve();
    expect(config.model).toBe(DEFAULTS.model);
    expect(config.maxFindings).toBe(DEFAULTS.maxFindings);
    expect(config.timeoutMs).toBe(DEFAULTS.timeoutMinutes * 60_000);
    expect(config.doctrine).toEqual([...DEFAULT_DOCTRINE]);
    expect(config.dryRun).toBe(false);
  });

  it('laisse la ligne de commande l’emporter sur l’input', () => {
    const config = resolve({ INPUT_MODEL: 'depuis-input' }, ['42', '--model', 'depuis-cli']);
    expect(config.model).toBe('depuis-cli');
  });

  it('accepte --dry-run, et l’input dry-run à true', () => {
    expect(resolve({}, ['42', '--dry-run']).dryRun).toBe(true);
    expect(resolve({ 'INPUT_DRY-RUN': 'true' }).dryRun).toBe(true);
    expect(resolve({ 'INPUT_DRY-RUN': 'false' }).dryRun).toBe(false);
  });

  it('prend la clé dans l’input, puis dans l’environnement', () => {
    expect(resolve({ 'INPUT_OLLAMA-API-KEY': 'depuis-input' }).apiKey).toBe('depuis-input');
    expect(resolve({ OLLAMA_API_KEY: 'depuis-env' }).apiKey).toBe('depuis-env');
    expect(resolve().apiKey).toBe('');
  });
});

describe('resolveConfig · doctrine et exclusions', () => {
  it('remplace la liste par défaut quand le dépôt en fournit une', () => {
    const config = resolve({ INPUT_DOCTRINE: '.github/regles.md\nCLAUDE.md\n' });
    expect(config.doctrine).toEqual(['.github/regles.md', 'CLAUDE.md']);
  });

  it('AJOUTE au plancher d’exclusions au lieu de le remplacer', () => {
    // Le plancher n'est pas désactivable : un dépôt qui écrit « skip » ne doit
    // pas se retrouver à faire relire son lockfile sans l'avoir demandé.
    const config = resolve({ INPUT_SKIP: 'src/generated/**' });
    expect(config.skip).toContain('src/generated/**');
    for (const floor of ALWAYS_SKIPPED) expect(config.skip).toContain(floor);
  });

  it('garde le plancher intact quand « skip » est vide', () => {
    expect(resolve().skip).toEqual([...ALWAYS_SKIPPED]);
  });
});

describe('resolveConfig · nombres illisibles', () => {
  it('garde le défaut et le dit, plutôt que de propager un NaN', () => {
    const warn = vi.fn();
    const config = resolveConfig({
      argv: ['42'],
      env: { 'INPUT_MAX-FINDINGS': 'beaucoup', 'INPUT_BUDGET-CHARS': '-1' },
      warn,
    });
    expect(config.maxFindings).toBe(DEFAULTS.maxFindings);
    expect(config.budgetChars).toBe(DEFAULTS.budgetChars);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('accepte une valeur valide', () => {
    const config = resolve({ 'INPUT_TIMEOUT-MINUTES': '20' });
    expect(config.timeoutMs).toBe(20 * 60_000);
  });

  it('accepte zéro là où il veut dire quelque chose : couper le contexte importé', () => {
    const warn = vi.fn();
    const config = resolveConfig({ argv: ['42'], env: { 'INPUT_IMPORTS-BUDGET-CHARS': '0' }, warn });
    expect(config.importsBudgetChars).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuse un budget d’imports négatif, qui ne veut rien dire', () => {
    const warn = vi.fn();
    const config = resolveConfig({ argv: ['42'], env: { 'INPUT_IMPORTS-BUDGET-CHARS': '-1' }, warn });
    expect(config.importsBudgetChars).toBe(DEFAULTS.importsBudgetChars);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('resolveConfig · réglages du modèle', () => {
  it('demande le raisonnement maximum par défaut : une review vaut par ce qu’elle trouve', () => {
    const config = resolve();
    expect(config.thinking).toBe('max');
    expect(config.temperature).toBe(1);
    expect(config.seed).toBe(1);
  });

  it('laisse le dépôt choisir un autre niveau, y compris aucun', () => {
    expect(resolve({ INPUT_THINKING: 'high' }).thinking).toBe('high');
    expect(resolve({ INPUT_THINKING: 'off' }).thinking).toBe('off');
  });

  it('règle la fusion plus bas que les passes : elle trie, elle ne relit pas', () => {
    expect(resolve().mergeThinking).toBe('high');
    expect(resolve({ 'INPUT_MERGE-THINKING': 'max' }).mergeThinking).toBe('max');
  });

  it('prévient quand on redemande le décodage glouton, sans l’interdire', () => {
    const warn = vi.fn();
    const config = resolveConfig({ argv: ['42'], env: { INPUT_TEMPERATURE: '0' }, warn });
    // Zéro reste une valeur : c'est un plafond qui ne peut pas être nul, pas
    // une température.
    expect(config.temperature).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('rend sa variance au modèle quand la graine est coupée', () => {
    expect(resolve({ INPUT_SEED: 'off' }).seed).toBeUndefined();
    expect(resolve({ INPUT_SEED: '7' }).seed).toBe(7);
  });
});


describe('le cran d’effort', () => {
  const config = (env: Record<string, string> = {}) =>
    resolveConfig({ argv: ['154'], env, warn: () => {} });

  it('vaut « balanced » quand personne ne le règle', () => {
    expect(config().effort).toBe('balanced');
  });

  it('accepte les trois crans, quelle que soit la casse', () => {
    expect(config({ INPUT_EFFORT: 'full' }).effort).toBe('full');
    expect(config({ INPUT_EFFORT: 'LEAN' }).effort).toBe('lean');
  });

  it('prévient et garde le défaut sur un cran inconnu, plutôt que d’annuler la review', () => {
    const warnings: string[] = [];
    const resolved = resolveConfig({
      argv: ['154'],
      env: { INPUT_EFFORT: 'high' },
      warn: (message) => warnings.push(message),
    });
    expect(resolved.effort).toBe('balanced');
    expect(warnings[0]).toContain('effort');
  });

  it('resserre le budget des imports au cran lean', () => {
    expect(config({ INPUT_EFFORT: 'lean' }).importsBudgetChars).toBe(120_000);
    expect(config({ INPUT_EFFORT: 'balanced' }).importsBudgetChars).toBe(300_000);
  });

  /** Régler un cran ne doit pas rendre inopérant un budget écrit à la main. */
  it('laisse un budget explicite l’emporter sur le cran', () => {
    expect(
      config({ INPUT_EFFORT: 'lean', 'INPUT_IMPORTS-BUDGET-CHARS': '50000' }).importsBudgetChars,
    ).toBe(50_000);
  });

  it('lit la liste de passes imposées', () => {
    expect(config({ INPUT_PASSES: 'regression\ndata' }).passes).toEqual(['regression', 'data']);
    expect(config().passes).toEqual([]);
  });
});

describe('les drapeaux de mesure', () => {
  const parse = (argv: string[]) => resolveConfig({ argv, env: {}, warn: () => {} });

  /** Compter ne doit jamais poster : une faute de frappe irait commenter une PR. */
  it('« --count-only » implique « --dry-run »', () => {
    const resolved = parse(['154', '--count-only']);
    expect(resolved.countOnly).toBe(true);
    expect(resolved.dryRun).toBe(true);
  });

  it('nomme le bras mesuré', () => {
    expect(parse(['154', '--variant', 'lean']).variant).toBe('lean');
    expect(parse(['154']).variant).toBe('default');
  });

  it('refuse « --variant » sans nom', () => {
    expect(() => parse(['154', '--variant'])).toThrow(UsageError);
  });
});
