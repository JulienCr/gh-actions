import { describe, expect, it } from 'vitest';

import type { PrMeta } from '../src/gh';
import {
  buildMergeSystemPrompt,
  buildMergeUserPrompt,
  buildPassSystemPrompt,
  PASSES,
  PASS_HEADING,
  type Pass,
} from '../src/passes';
import type { PromptOptions } from '../src/prompt';

const OPTIONS: PromptOptions = {
  repo: 'JulienCr/exemple',
  projectSummary: '',
  doctrine: [{ path: 'CLAUDE.md', content: 'DOCTRINE_SENTINELLE' }],
};

const META: PrMeta = {
  number: 42,
  title: 'feat(admin): quelque chose',
  body: '',
  headSha: 'abc123',
  baseRefName: 'main',
  isDraft: false,
  files: [{ path: 'src/app/page.tsx', additions: 12, deletions: 3, status: 'modified' }],
};

const pass = (id: string) => PASSES.find((entry) => entry.id === id)!;

describe('les trois passes', () => {
  it('couvrent les trois familles, une seule chacune', () => {
    expect(PASSES.map((entry) => entry.id)).toEqual(['regression', 'doctrine', 'data']);
  });

  it('donnent la doctrine à toutes, pas seulement à celle qui la juge', () => {
    // Une passe qui ne l'aurait pas signalerait comme défaut ce que le dépôt impose.
    for (const entry of PASSES) {
      expect(buildPassSystemPrompt(entry, OPTIONS)).toContain('DOCTRINE_SENTINELLE');
    }
  });

  it('disent à chacune de laisser les autres axes aux autres', () => {
    expect(buildPassSystemPrompt(pass('regression'), OPTIONS)).toContain('Another pass covers those');
    expect(buildPassSystemPrompt(pass('doctrine'), OPTIONS)).toContain('Other passes cover');
    expect(buildPassSystemPrompt(pass('data'), OPTIONS)).toContain('Not runtime bugs, not conventions');
  });

  it('gardent les axes où se cachent les vrais bugs, qu’un diff ne montre pas', () => {
    const prompt = buildPassSystemPrompt(pass('regression'), OPTIONS);
    for (const axis of ["The caller's side", 'Error paths', 'Edge inputs', 'State and ordering']) {
      expect(prompt).toContain(axis);
    }
  });

  it('réclament le repère que le rendu ira chercher, et rien d’autre', () => {
    const prompt = buildPassSystemPrompt(pass('data'), OPTIONS);
    expect(prompt).toContain(PASS_HEADING);
    // Le gabarit final appartient à la fusion : une passe qui le rendrait
    // ferait croire à une review complète sur un seul axe.
    expect(prompt).not.toContain('## Verdict');
  });

  it('n’imposent aucun plafond par passe, sans quoi trois passes rendraient trois plafonds', () => {
    expect(buildPassSystemPrompt(pass('regression'), OPTIONS)).toContain('No ceiling on this pass');
  });

  it('refusent une section vide et réclament ce qui a été vérifié', () => {
    expect(buildPassSystemPrompt(pass('doctrine'), OPTIONS)).toContain('Never an empty section');
  });

  it('portent les règles de forme que la fusion ne corrigera pas à leur place', () => {
    // La fusion a consigne de ne pas réécrire une trouvaille : ce qu'une passe
    // écrit arrive tel quel dans le commentaire posté.
    expect(buildPassSystemPrompt(pass('regression'), OPTIONS)).toContain('Never use an em dash');
  });

  it('renvoient un doute que les fichiers de contexte tranchent à sa conclusion', () => {
    expect(buildPassSystemPrompt(pass('data'), OPTIONS)).toContain(
      'A doubt that the context files above DO settle is not a doubt',
    );
  });
});

describe('buildMergeSystemPrompt', () => {
  const merge = (maxFindings = 20, passes: readonly Pass[] = PASSES) =>
    buildMergeSystemPrompt({ repo: 'JulienCr/exemple', maxFindings, passes });

  it('impose les cinq rubriques, dont l’exutoire des doutes', () => {
    const prompt = merge();
    for (const heading of ['## Verdict', '## Bloquant', '## À corriger', '## Suggestions', '## À vérifier']) {
      expect(prompt).toContain(heading);
    }
  });

  it('dit à la fusion qu’elle n’a pas le code, et lui interdit de compléter', () => {
    const prompt = merge();
    expect(prompt).toContain('**You do not have the code.**');
    expect(prompt).toContain('Never add a finding');
    expect(prompt).toContain('Do not complete it');
  });

  it('lui confie la déduplication et l’arbitrage des sévérités', () => {
    const prompt = merge();
    expect(prompt).toContain('Deduplicate');
    expect(prompt).toContain('Arbitrate the label');
  });

  it('porte le plafond, qui n’a de sens qu’ici', () => {
    expect(merge(5)).toContain('5 bullets maximum');
  });

  it('présente le plafond comme un ordre de priorité, pas comme un permis de taire', () => {
    expect(merge()).toContain('it never justifies\n   dropping one in silence');
  });

  it('réclame une review en français, sans tiret cadratin', () => {
    expect(merge()).toContain('Write in French. Never use an em dash.');
  });
});

describe('buildMergeUserPrompt', () => {
  const prompt = buildMergeUserPrompt(META, [
    { pass: pass('regression'), findings: `${PASS_HEADING}\n- [bloquant] \`src/app/page.tsx:12\` : casse.` },
    { pass: pass('data'), findings: `${PASS_HEADING}\n- [rien] : requêtes et journaux relus.` },
  ]);

  it('nomme le relecteur de chaque bloc, pour que la fusion sache d’où vient quoi', () => {
    expect(prompt).toContain('## Reviewer: régression fonctionnelle');
    expect(prompt).toContain('## Reviewer: données et accès');
  });

  it('porte les trouvailles telles quelles', () => {
    expect(prompt).toContain('- [bloquant] `src/app/page.tsx:12` : casse.');
  });

  it('liste les fichiers de la PR, pour écarter une trouvaille tombée sur un fichier de contexte', () => {
    expect(prompt).toContain('- src/app/page.tsx (+12 / -3, modified)');
    expect(prompt).toContain('drop that finding');
  });

  it('n’attend pas les trois passes pour rendre un prompt utilisable', () => {
    expect(prompt).not.toContain('## Reviewer: doctrine du dépôt');
  });
});


describe('l’ouverture de la fusion, accordée à ce qui a réellement été lu', () => {
  const merge = (passes: readonly Pass[]) =>
    buildMergeSystemPrompt({ repo: 'JulienCr/exemple', maxFindings: 20, passes });

  it('annonce trois relecteurs et leurs trois axes quand les trois ont abouti', () => {
    const prompt = merge(PASSES);
    expect(prompt).toContain('Three reviewers have just read');
    expect(prompt).toContain("functional regressions, the repository's own conventions and data access");
  });

  /**
   * Le cas qui mentait déjà avant toute optimisation : une passe qui échoue
   * laissait la fusion chercher un axe qu'on ne lui avait pas donné.
   */
  it('n’annonce que deux relecteurs quand une passe n’a pas abouti', () => {
    const prompt = merge(PASSES.filter((pass) => pass.id !== 'data'));
    expect(prompt).toContain('Two reviewers have just read');
    expect(prompt).not.toContain('data access');
  });

  it('accorde le singulier quand une seule passe a lu', () => {
    const prompt = merge(PASSES.filter((pass) => pass.id === 'doctrine'));
    expect(prompt).toContain('One reviewer has just read');
    expect(prompt).not.toContain('reviewers have');
  });
});
