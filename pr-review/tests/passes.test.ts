import { describe, expect, it } from 'vitest';

import type { PrMeta } from '../src/gh';
import {
  buildMergeSystemPrompt,
  buildMergeUserPrompt,
  buildPassSystemPrompt,
  PASSES,
  PASS_HEADING,
  selectPasses,
  stepDown,
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
      expect(buildPassSystemPrompt(entry, OPTIONS, true)).toContain('DOCTRINE_SENTINELLE');
    }
  });

  it('disent à chacune de laisser les autres axes aux autres', () => {
    expect(buildPassSystemPrompt(pass('regression'), OPTIONS, true)).toContain('Another pass covers those');
    expect(buildPassSystemPrompt(pass('doctrine'), OPTIONS, true)).toContain('Other passes cover');
    expect(buildPassSystemPrompt(pass('data'), OPTIONS, true)).toContain('Not runtime bugs, not conventions');
  });

  it('gardent les axes où se cachent les vrais bugs, qu’un diff ne montre pas', () => {
    const prompt = buildPassSystemPrompt(pass('regression'), OPTIONS, true);
    for (const axis of ["The caller's side", 'Error paths', 'Edge inputs', 'State and ordering']) {
      expect(prompt).toContain(axis);
    }
  });

  it('réclament le repère que le rendu ira chercher, et rien d’autre', () => {
    const prompt = buildPassSystemPrompt(pass('data'), OPTIONS, true);
    expect(prompt).toContain(PASS_HEADING);
    // Le gabarit final appartient à la fusion : une passe qui le rendrait
    // ferait croire à une review complète sur un seul axe.
    expect(prompt).not.toContain('## Verdict');
  });

  it('n’imposent aucun plafond par passe, sans quoi trois passes rendraient trois plafonds', () => {
    expect(buildPassSystemPrompt(pass('regression'), OPTIONS, true)).toContain('No ceiling on this pass');
  });

  it('refusent une section vide et réclament ce qui a été vérifié', () => {
    expect(buildPassSystemPrompt(pass('doctrine'), OPTIONS, true)).toContain('Never an empty section');
  });

  it('portent les règles de forme que la fusion ne corrigera pas à leur place', () => {
    // La fusion a consigne de ne pas réécrire une trouvaille : ce qu'une passe
    // écrit arrive tel quel dans le commentaire posté.
    expect(buildPassSystemPrompt(pass('regression'), OPTIONS, true)).toContain('Never use an em dash');
  });

  it('renvoient un doute que les fichiers de contexte tranchent à sa conclusion', () => {
    expect(buildPassSystemPrompt(pass('data'), OPTIONS, true)).toContain(
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


const prFile = (path: string) => ({ path, additions: 5, deletions: 1, status: 'modified' });
const ids = (passes: readonly Pass[]) => passes.map((pass) => pass.id);

describe('le raisonnement, descendu d’un cran plutôt que fixé', () => {
  it('descend dans l’échelle', () => {
    expect(stepDown('max', 1)).toBe('high');
    expect(stepDown('max', 2)).toBe('medium');
    expect(stepDown('high', 1)).toBe('medium');
  });

  /**
   * Relatif et non absolu : un dépôt qui écrit « thinking: low » doit l'obtenir
   * partout, au lieu de se faire remonter par une passe au niveau écrit en dur.
   */
  it('ne remonte jamais au-dessus de ce que le dépôt a demandé', () => {
    expect(stepDown('low', 2)).toBe('low');
    expect(stepDown('medium', 5)).toBe('low');
  });

  it('ne touche à rien sans cran à descendre', () => {
    expect(stepDown('max', 0)).toBe('max');
  });

  /** Un booléen, ou le niveau d'un modèle inconnu, n'a pas à être deviné ici. */
  it('rend telle quelle une valeur hors échelle', () => {
    expect(stepDown('true', 2)).toBe('true');
    expect(stepDown('', 1)).toBe('');
  });
});

describe('le choix des passes à lancer', () => {
  const auto = (over: { files?: ReturnType<typeof prFile>[]; hasDoctrine?: boolean } = {}) =>
    selectPasses(
      { files: over.files ?? [prFile('src/a.ts')], hasDoctrine: over.hasDoctrine ?? true },
      { auto: true, forced: [] },
    );

  it('lance les trois sur une PR de code d’un dépôt qui a sa doctrine', () => {
    expect(ids(auto().run)).toEqual(['regression', 'doctrine', 'data']);
    expect(auto().skipped).toEqual([]);
  });

  it('n’ouvre pas la passe régression sur une PR de pure prose', () => {
    const selection = auto({ files: [prFile('README.md'), prFile('docs/guide.txt')] });
    expect(ids(selection.run)).toEqual(['doctrine', 'data']);
    expect(selection.skipped).toEqual([
      { label: 'régression fonctionnelle', reason: 'aucun fichier exécutable dans cette PR' },
    ]);
  });

  /**
   * Une liste positive d'extensions de code raterait le langage du prochain
   * dépôt et supprimerait la passe en silence. La liste est donc négative, et
   * la configuration reste du code exécuté.
   */
  it('tient un .json, un .yml et un .toml pour du code', () => {
    for (const path of ['package.json', '.github/workflows/ci.yml', 'Cargo.toml']) {
      expect(ids(auto({ files: [prFile(path)] }).run)).toContain('regression');
    }
  });

  /**
   * `.mdx` ressemble à `.md` et n'en est pas : il porte des imports, des
   * expressions et du JSX évalués au rendu. Le ranger dans la prose retirerait
   * à ces PR le seul axe qui pouvait relire ce code.
   */
  it('tient un .mdx pour du code, malgré son air de markdown', () => {
    expect(ids(auto({ files: [prFile('docs/guide.mdx')] }).run)).toContain('regression');
  });

  it('n’ouvre pas la passe doctrine quand le dépôt n’en fournit aucune', () => {
    const selection = auto({ hasDoctrine: false });
    expect(ids(selection.run)).toEqual(['regression', 'data']);
    expect(selection.skipped[0]?.reason).toContain('aucun fichier de doctrine');
  });

  /**
   * Un README fuit une clé aussi bien qu'un .ts. Le coût d'une fuite dépasse de
   * plusieurs ordres celui d'une passe.
   */
  it('lance la passe données même sur une PR de pure prose, et sans doctrine', () => {
    const selection = auto({ files: [prFile('README.md')], hasDoctrine: false });
    expect(ids(selection.run)).toEqual(['data']);
  });

  it('lance tout au cran full, sauf la doctrine d’un dépôt qui n’en a pas', () => {
    const complet = selectPasses(
      { files: [prFile('README.md')], hasDoctrine: true },
      { auto: false, forced: [] },
    );
    expect(ids(complet.run)).toEqual(['regression', 'doctrine', 'data']);

    const sansDoctrine = selectPasses(
      { files: [prFile('src/a.ts')], hasDoctrine: false },
      { auto: false, forced: [] },
    );
    expect(ids(sansDoctrine.run)).toEqual(['regression', 'data']);
  });

  it('obéit à une liste imposée, sans lui appliquer aucune règle', () => {
    const selection = selectPasses(
      { files: [prFile('README.md')], hasDoctrine: false },
      { auto: true, forced: ['regression', 'doctrine'] },
    );
    expect(ids(selection.run)).toEqual(['regression', 'doctrine']);
    expect(selection.skipped).toEqual([]);
  });

  it('prévient et lance les trois quand la liste imposée ne dit rien de connu', () => {
    const warnings: string[] = [];
    const selection = selectPasses(
      { files: [prFile('src/a.ts')], hasDoctrine: true },
      { auto: true, forced: ['nawak'], warn: (message) => warnings.push(message) },
    );
    expect(ids(selection.run)).toEqual(['regression', 'doctrine', 'data']);
    expect(warnings.join('\n')).toContain('inconnu(s) : nawak');
  });

  /** Une optimisation ne doit jamais produire une review muette. */
  it('ne rend jamais une liste vide', () => {
    expect(auto({ files: [], hasDoctrine: false }).run.length).toBeGreaterThan(0);
  });
});

describe('le contexte importé, selon le cran', () => {
  const pick = (id: string) => PASSES.find((entry) => entry.id === id)!;

  it('part aux trois passes au cran full', () => {
    for (const entry of PASSES) expect(entry.imports.full).toBe(true);
  });

  it('épargne la doctrine dès le cran équilibré', () => {
    expect(pick('doctrine').imports.balanced).toBe(false);
    expect(pick('regression').imports.balanced).toBe(true);
    expect(pick('data').imports.balanced).toBe(true);
  });

  it('ne reste qu’à la régression au cran lean', () => {
    expect(pick('regression').imports.lean).toBe(true);
    expect(pick('data').imports.lean).toBe(false);
  });

  /** L'axe qui trace un appelant garde son raisonnement à tous les crans. */
  it('ne retire jamais de raisonnement à la passe régression', () => {
    expect(pick('regression').thinkingSteps.lean).toBe(0);
  });
});

describe('la consigne sur les doutes, quand il n’y a pas de fichiers de contexte', () => {
  it('renvoie aux fichiers de contexte quand la passe en reçoit', () => {
    expect(buildPassSystemPrompt(PASSES[0]!, OPTIONS, true)).toContain(
      'A doubt that the context files above DO settle',
    );
  });

  it('n’envoie pas le modèle chercher une section qu’il n’a pas', () => {
    expect(buildPassSystemPrompt(PASSES[0]!, OPTIONS, false)).not.toContain('context files above');
  });
});


describe('une liste de passes partiellement fautive', () => {
  const forced = (list: string[]) => {
    const warnings: string[] = [];
    const selection = selectPasses(
      { files: [prFile('src/a.ts')], hasDoctrine: true },
      { auto: true, forced: list, warn: (message) => warnings.push(message) },
    );
    return { ids: ids(selection.run), warnings };
  };

  /**
   * Le cas qui coûtait cher : « datta » au lieu de « data » laissait tourner
   * la seule passe régression, sans un mot. C'est le seul chemin par lequel
   * l'axe des fuites peut disparaître, il ne peut pas être muet.
   */
  it('nomme l’identifiant fautif au lieu de l’avaler', () => {
    const { ids: run, warnings } = forced(['regression', 'datta']);
    expect(run).toEqual(['regression']);
    expect(warnings.join('\n')).toContain('datta');
  });

  it('ne dit rien quand tout est reconnu', () => {
    expect(forced(['regression', 'data']).warnings).toEqual([]);
  });

  it('lance les trois quand rien n’est reconnu', () => {
    expect(forced(['nawak']).ids).toEqual(['regression', 'doctrine', 'data']);
  });
});
