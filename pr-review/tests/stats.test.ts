import { describe, it, expect } from 'vitest';

import {
  CHARS_PER_TOKEN,
  describeCall,
  estimateTokens,
  reasoningShare,
  renderBreakdown,
  statsLine,
  totals,
  type CallStat,
  type InputBreakdown,
} from '../src/stats';

const call = (over: Partial<CallStat> = {}): CallStat => ({
  id: 'regression',
  label: 'passe régression fonctionnelle',
  think: 'max',
  systemChars: 11_204,
  userChars: 318_442,
  promptTokens: 92_900,
  evalTokens: 6_402,
  thinkingChars: 24_000,
  contentChars: 6_000,
  durationMs: 96_000,
  ok: true,
  ...over,
});

const BLOCKS: InputBreakdown = {
  system: 11_204,
  diff: 26_000,
  touched: 178_000,
  imported: 102_000,
  meta: 12_442,
};

describe('les totaux du pied de page', () => {
  it('additionne les appels aboutis', () => {
    const sum = totals([call(), call({ promptTokens: 58_400, evalTokens: 2_000, thinkingChars: 8_000 })]);
    expect(sum).toEqual({ promptTokens: 151_300, evalTokens: 8_402, thinkingChars: 32_000 });
  });

  it('rend des zéros sur une liste vide, plutôt que de rater', () => {
    expect(totals([])).toEqual({ promptTokens: 0, evalTokens: 0, thinkingChars: 0 });
  });
});

describe('la part de raisonnement, déduite des tailles', () => {
  it('rapporte le raisonnement à la sortie totale', () => {
    expect(reasoningShare(call({ thinkingChars: 30_000, contentChars: 10_000 }))).toBeCloseTo(0.75);
  });

  /** Le modèle a mêlé son raisonnement à sa réponse : il n'y a rien à déduire. */
  it('rend null quand le raisonnement n’est pas rendu à part', () => {
    expect(reasoningShare(call({ thinkingChars: 0 }))).toBeNull();
  });

  it('rend null plutôt que de diviser par zéro sur une réponse vide', () => {
    expect(reasoningShare(call({ thinkingChars: 0, contentChars: 0 }))).toBeNull();
  });
});

describe('la ligne de journal d’un appel', () => {
  it('dit l’entrée, la sortie, la part de raisonnement et le niveau demandé', () => {
    const line = describeCall(call());
    expect(line).toContain('en 96 s');
    // Le séparateur de milliers de « fr-FR » est une espace fine insécable
    // (U+202F), pas une espace : l'attendu se construit comme le rendu.
    expect(line).toContain(`${(92_900).toLocaleString('fr-FR')} tokens en entrée`);
    expect(line).toContain(`${(6_402).toLocaleString('fr-FR')} en sortie`);
    expect(line).toContain('~80 % de raisonnement');
    expect(line).toContain('think=max');
  });

  it('n’annonce pas une part de raisonnement que le modèle n’a pas séparée', () => {
    expect(describeCall(call({ thinkingChars: 0 }))).not.toContain('raisonnement');
  });

  /** `think` vide veut dire « le défaut du modèle », pas « aucun raisonnement ». */
  it('tait le niveau quand aucun n’a été demandé', () => {
    expect(describeCall(call({ think: '' }))).not.toContain('think=');
  });
});

describe('l’estimation en tokens', () => {
  it('divise les caractères par la constante annoncée', () => {
    expect(estimateTokens(35_000)).toBe(Math.round(35_000 / CHARS_PER_TOKEN));
  });
});

describe('le tableau de --count-only', () => {
  const table = renderBreakdown(
    [call(), call({ id: 'doctrine', label: 'passe doctrine du dépôt', userChars: 196_118 })],
    BLOCKS,
  );

  it('donne une ligne par appel, et leur total', () => {
    expect(table).toContain('passe régression fonctionnelle');
    expect(table).toContain('passe doctrine du dépôt');
    expect(table).toContain('total entrée');
  });

  it('ventile l’entrée par bloc, ce qui est la décision que le tableau sert', () => {
    expect(table).toContain('fichiers touchés 54 %');
    expect(table).toContain('imports 31 %');
  });

  /**
   * Sur la somme des quatre appels, un bloc envoyé à une seule passe paraîtrait
   * trois fois plus petit qu'il ne l'est pour elle : on couperait ailleurs qu'où
   * il faut. La ventilation porte donc sur un prompt.
   */
  it('ventile sur un prompt et non sur la somme des appels', () => {
    const solo = renderBreakdown([call()], BLOCKS);
    expect(solo).toContain('fichiers touchés 54 %');
  });

  it('annonce que les tokens sont estimés, quand les caractères sont exacts', () => {
    expect(table).toContain('Tokens estimés');
    expect(table).toContain('Les caractères, eux, sont exacts');
  });
});

describe('la ligne ::stats::', () => {
  const line = statsLine({
    pr: 154,
    model: 'glm-5.2:cloud',
    variant: 'balanced',
    calls: [call()],
    blocks: BLOCKS,
    findings: { regression: '## Trouvailles\n- [rien] : chemins d’erreur relus.' },
  });

  it('tient sur une ligne, pour se greper dans un journal de CI', () => {
    expect(line.split('\n')).toHaveLength(1);
    expect(line.startsWith('::stats::')).toBe(true);
  });

  /**
   * Comparer deux réglages sur leurs tokens dit lequel est le moins cher, jamais
   * lequel a perdu une trouvaille. C'est pourtant la seule question qui annule
   * un levier, d'où les trouvailles brutes dans la charge utile.
   */
  it('emporte les trouvailles brutes, et pas seulement les compteurs', () => {
    const parsed = JSON.parse(line.slice('::stats::'.length));
    expect(parsed.findings.regression).toContain('[rien]');
    expect(parsed.variant).toBe('balanced');
  });
});
