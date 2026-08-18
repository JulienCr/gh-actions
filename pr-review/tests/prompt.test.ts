import { describe, expect, it } from 'vitest';

import type { AssembledContext } from '../src/context';
import type { PrMeta } from '../src/gh';
import { buildPreamble, buildUserPrompt, type PromptOptions } from '../src/prompt';

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
  imported: [],
  skipped: ['pnpm-lock.yaml'],
  omitted: [],
    windowed: [],
};

const preamble = (over: Partial<PromptOptions> = {}) =>
  buildPreamble({ repo: 'JulienCr/exemple', projectSummary: '', doctrine: [], ...over });

describe('buildPreamble', () => {
  it('injecte chaque fichier de doctrine avec son chemin, au lieu de recopier des règles en dur', () => {
    const prompt = preamble({
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
    expect(preamble()).toContain('`JulienCr/exemple`');
  });

  it('reprend le cadrage fourni par le dépôt, et n’en invente pas quand il manque', () => {
    expect(preamble({ projectSummary: 'Un escape game à Paris.' })).toContain('Un escape game à Paris.');
    // Sans cadrage, le prompt enchaîne directement : pas de ligne vide en trop
    // ni de gabarit resté vide, qui inviterait le modèle à combler le trou.
    expect(preamble()).toContain('repository.\n\nYou run when the PR is opened');
  });

  it('prévient le modèle quand aucune doctrine n’a été trouvée', () => {
    const prompt = preamble();
    expect(prompt).toContain('ships no review doctrine');
    expect(prompt).toContain('never present a remark as if it came from a project rule');
  });

  it('n’avertit pas de l’absence de doctrine quand il y en a une', () => {
    expect(preamble({ doctrine: [{ path: 'CLAUDE.md', content: 'x' }] })).not.toContain(
      'ships no review doctrine',
    );
  });

  it('demande de la couverture, pas de la sélection', () => {
    const prompt = preamble();
    expect(prompt).toContain('coverage, not curation');
    // Le garde-fou qui a produit trois « Rien à signaler » sur quatre : le
    // modèle cherchait, trouvait, puis jetait faute de certitude.
    expect(prompt).toContain('Do not soften a finding into silence');
    expect(prompt).toContain('Finding nothing is a claim, not a default');
  });

  it('interdit la liste de numéros de ligne, qui a produit un numéro inventé sur quatre', () => {
    const prompt = preamble();
    expect(prompt).toContain('exactly one line number per finding');
    expect(prompt).toContain('Never state what a file contains unless that file was included');
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

  it('range les fichiers importés dans une section à part, et dit de ne pas les relire', () => {
    const prompt = buildUserPrompt(META, {
      ...CONTEXT,
      imported: [{ path: 'src/lib/format.ts', numbered: '1| export const truncate = 1;' }],
    });
    expect(prompt).toContain('## Context files, NOT modified by this PR');
    expect(prompt).toContain('### src/lib/format.ts');
    // Sans cette consigne, le modèle relève des défauts dans du code que la PR
    // ne touche pas, et la review devient inutilisable pour son auteur.
    expect(prompt).toContain('**Do not review them.**');
    expect(prompt).toContain('Every finding must be about a changed file listed above');
  });

  it('n’ouvre pas de section de contexte quand aucun import n’a été résolu', () => {
    expect(buildUserPrompt(META, CONTEXT)).not.toContain('Context files');
  });
});


describe('la phrase qui désigne les sections fournies', () => {
  const build = (imported: { path: string; numbered: string }[]) =>
    buildUserPrompt(META, { diff: 'd', files: [], imported, skipped: [], omitted: [], windowed: [] });

  it('annonce deux sections quand des fichiers de contexte suivent', () => {
    expect(build([{ path: 'src/b.ts', numbered: '1| b' }])).toContain(
      'absent from this section and from the next one',
    );
  });

  /** Sans section suivante, la phrase désignerait du vide. */
  it('n’en annonce qu’une quand la passe ne reçoit pas d’imports', () => {
    const prompt = build([]);
    expect(prompt).toContain('absent from this section was not given to you');
    expect(prompt).not.toContain('from the next one');
  });
});
