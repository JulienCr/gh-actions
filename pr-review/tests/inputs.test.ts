import { describe, expect, it, vi } from 'vitest';

import {
  ALWAYS_SKIPPED,
  DEFAULT_DOCTRINE,
  DEFAULTS,
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
});
