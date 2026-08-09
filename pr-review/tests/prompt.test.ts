import { describe, expect, it } from 'vitest';

import type { AssembledContext } from '../src/context';
import type { PrMeta } from '../src/gh';
import { buildSystemPrompt, buildUserPrompt, type SystemPromptOptions } from '../src/prompt';

const META: PrMeta = {
  number: 42,
  title: 'feat(admin): quelque chose',
  body: 'Pourquoi ce changement.',
  headSha: 'abc123',
  baseRefName: 'main',
  isDraft: false,
  files: [
    { path: 'src/app/page.tsx', additions: 12, deletions: 3, status: 'modified' },
    { path: 'pnpm-lock.yaml', additions: 400, deletions: 2, status: 'modified' },
  ],
};

const CONTEXT: AssembledContext = {
  diff: 'diff --git a/src/app/page.tsx b/src/app/page.tsx',
  files: [{ path: 'src/app/page.tsx', numbered: '1| export default function Page() {}' }],
  skipped: ['pnpm-lock.yaml'],
  omitted: [],
};

const system = (over: Partial<SystemPromptOptions> = {}) =>
  buildSystemPrompt({ repo: 'JulienCr/exemple', projectSummary: '', doctrine: [], maxFindings: 12, ...over });

describe('buildSystemPrompt', () => {
  it('injecte chaque fichier de doctrine avec son chemin, au lieu de recopier des règles en dur', () => {
    const prompt = system({
      doctrine: [
        { path: '.github/copilot-instructions.md', content: 'DOCTRINE_SENTINELLE' },
        { path: 'CLAUDE.md', content: 'CONVENTIONS_SENTINELLE' },
      ],
    });
    expect(prompt).toContain('DOCTRINE_SENTINELLE');
    expect(prompt).toContain('CONVENTIONS_SENTINELLE');
    expect(prompt).toContain('<doctrine path=".github/copilot-instructions.md">');
    expect(prompt).toContain('<doctrine path="CLAUDE.md">');
  });

  it('situe le dépôt relu, puisque plus aucun nom de projet n’est écrit dans le prompt', () => {
    expect(system()).toContain('`JulienCr/exemple`');
  });

  it('reprend le cadrage fourni par le dépôt, et n’en invente pas quand il manque', () => {
    expect(system({ projectSummary: 'Un escape game à Paris.' })).toContain('Un escape game à Paris.');
    // Sans cadrage, le prompt enchaîne directement : pas de ligne vide en trop
    // ni de gabarit resté vide, qui inviterait le modèle à combler le trou.
    expect(system()).toContain('repository.\n\nYou run when the PR is opened');
  });

  it('prévient le modèle quand aucune doctrine n’a été trouvée', () => {
    const prompt = system();
    expect(prompt).toContain('ships no review doctrine');
    expect(prompt).toContain('never present a remark as if it came from a project rule');
  });

  it('n’avertit pas de l’absence de doctrine quand il y en a une', () => {
    const prompt = system({ doctrine: [{ path: 'CLAUDE.md', content: 'x' }] });
    expect(prompt).not.toContain('ships no review doctrine');
  });

  it('impose les cinq rubriques, dont l’exutoire des doutes', () => {
    const prompt = system();
    for (const heading of [
      '## Verdict',
      '## Bloquant',
      '## À corriger',
      '## Suggestions',
      '## À vérifier',
    ]) {
      expect(prompt).toContain(heading);
    }
  });

  it('demande de la couverture, pas de la sélection', () => {
    const prompt = system();
    expect(prompt).toContain('coverage, not curation');
    // Le garde-fou qui a produit trois « Rien à signaler » sur quatre : le
    // modèle cherchait, trouvait, puis jetait faute de certitude.
    expect(prompt).not.toContain('Do not manufacture remarks to fill space');
    expect(prompt).toContain('Do not soften a finding into silence');
  });

  it('n’accepte « Rien à signaler » qu’accompagné de ce qui a été vérifié', () => {
    const prompt = system();
    expect(prompt).toContain('« Rien à signaler » is a claim, not a default');
  });

  it('donne les axes où se cachent les vrais bugs, qu’un diff ne montre pas', () => {
    const prompt = system();
    expect(prompt).toContain('Where the costly bugs hide');
    for (const axis of ["The caller's side", 'Error paths', 'Edge inputs', 'State and ordering']) {
      expect(prompt).toContain(axis);
    }
  });

  it('interdit la liste de numéros de ligne, qui a produit un numéro inventé sur quatre', () => {
    const prompt = system();
    expect(prompt).toContain('exactly one line number per finding');
    expect(prompt).toContain('Never state what a file contains unless that file was included');
  });

  it('donne ses consignes en anglais mais réclame une review en français', () => {
    const prompt = system();
    expect(prompt).toContain('The review itself is written');
    expect(prompt).toContain('Write in French');
  });

  it('reporte le plafond de puces demandé par le dépôt', () => {
    expect(system({ maxFindings: 5 })).toContain('5 bullets maximum');
  });

  it('présente le plafond comme un ordre de priorité, pas comme un permis de taire', () => {
    expect(system()).toContain('never to justify dropping one in silence');
  });
});

describe('buildUserPrompt', () => {
  it('liste les fichiers avec leurs volumes et marque ceux hors review', () => {
    const prompt = buildUserPrompt(META, CONTEXT);
    expect(prompt).toContain('- src/app/page.tsx (+12 / -3, modified)');
    expect(prompt).toContain('- pnpm-lock.yaml (+400 / -2, modified) (not reviewed)');
  });

  it('porte le diff et le contenu numéroté', () => {
    const prompt = buildUserPrompt(META, CONTEXT);
    expect(prompt).toContain('### src/app/page.tsx');
    expect(prompt).toContain('1| export default function Page() {}');
  });

  it('avertit le modèle des fichiers dont il n’a que le diff', () => {
    const prompt = buildUserPrompt(META, { ...CONTEXT, omitted: ['src/gros.ts'] });
    expect(prompt).toContain('No full content for these files');
    expect(prompt).toContain('- src/gros.ts');
  });

  it('rend une description vide lisible plutôt qu’un trou', () => {
    expect(buildUserPrompt({ ...META, body: '   ' }, CONTEXT)).toContain('(empty)');
  });
});
