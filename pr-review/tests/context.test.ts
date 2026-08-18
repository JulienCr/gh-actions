import { describe, expect, it } from 'vitest';

import {
  assembleContext,
  contextFor,
  filterDiff,
  foldAddedFiles,
  hasContent,
  numberLines,
  splitDiffByFile,
  touchesLines,
  type AssembleOptions,
  type ContextBudget,
} from '../src/context';
import type { PrFile } from '../src/gh';
import { compileMatcher } from '../src/globs';
import { ALWAYS_SKIPPED } from '../src/inputs';

const file = (path: string, over: Partial<PrFile> = {}): PrFile => ({
  path,
  additions: 10,
  deletions: 0,
  status: 'modified',
  ...over,
});

/** Le plancher plus les motifs qu'un dépôt ajouterait par l'input « skip ». */
const isSkipped = compileMatcher([...ALWAYS_SKIPPED, 'src/generated/**', 'deploy/**']);

const BUDGET: ContextBudget = { totalChars: 500_000, perFileChars: 80_000, importedChars: 300_000 };

const assemble = (over: Partial<AssembleOptions>) =>
  assembleContext({
    rawDiff: '',
    prFiles: [],
    readFile: () => null,
    exists: () => false,
    isSkipped,
    budget: BUDGET,
    ...over,
  });

describe('le prédicat d’exclusion, une fois câblé sur les inputs', () => {
  it('garde le code, le contenu éditorial et la config', () => {
    expect(isSkipped('src/app/page.tsx')).toBe(false);
    expect(isSkipped('content/fr/sections/hero.md')).toBe(false);
    expect(isSkipped('.github/workflows/pr-review.yml')).toBe(false);
  });

  it('écarte les artefacts générés, les lockfiles et les binaires', () => {
    expect(isSkipped('pnpm-lock.yaml')).toBe(true);
    expect(isSkipped('src/generated/prisma/client.ts')).toBe(true);
    expect(isSkipped('deploy/app.js')).toBe(true);
    expect(isSkipped('public/images/hero.webp')).toBe(true);
    expect(isSkipped('public/fonts/inter.woff2')).toBe(true);
  });

  it('ne réclame pas le contenu d’un fichier supprimé', () => {
    expect(hasContent(file('src/a.ts', { status: 'removed' }), isSkipped)).toBe(false);
    expect(hasContent(file('src/a.ts', { status: 'added' }), isSkipped)).toBe(true);
  });
});

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
index 333..444 100644
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,1 +1,1 @@
-lockfileVersion: 1
+lockfileVersion: 2
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 555..000
--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`;

describe('splitDiffByFile', () => {
  it('découpe par fichier et retrouve chaque chemin', () => {
    const chunks = splitDiffByFile(DIFF);
    expect(chunks.map((chunk) => chunk.path)).toEqual(['src/a.ts', 'pnpm-lock.yaml', 'src/gone.ts']);
  });

  it('lit le chemin sur --- a/ quand la cible est /dev/null', () => {
    const [chunk] = splitDiffByFile(`diff --git a/x/y.ts b/x/y.ts
--- a/x/y.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`);
    expect(chunk?.path).toBe('x/y.ts');
  });

  it('se rabat sur l’en-tête pour un bloc sans hunk', () => {
    const [chunk] = splitDiffByFile('diff --git a/mode.sh b/mode.sh\nold mode 100644\nnew mode 100755\n');
    expect(chunk?.path).toBe('mode.sh');
  });

  it('rend une liste vide sur un diff vide', () => {
    expect(splitDiffByFile('')).toEqual([]);
  });
});

describe('filterDiff', () => {
  it('retire le lockfile du diff et le signale', () => {
    const { diff, skipped } = filterDiff(DIFF, isSkipped);
    expect(skipped).toEqual(['pnpm-lock.yaml']);
    expect(diff).toContain('src/a.ts');
    expect(diff).toContain('src/gone.ts');
    expect(diff).not.toContain('lockfileVersion');
  });
});

describe('numberLines', () => {
  it('numérote à partir de 1, alignées à droite', () => {
    expect(numberLines('a\nb')).toBe('1| a\n2| b');
  });

  it('ne compte pas de ligne fantôme après le saut final', () => {
    expect(numberLines('a\nb\n')).toBe('1| a\n2| b');
  });

  it('aligne la largeur sur le plus grand numéro', () => {
    const numbered = numberLines(Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n'));
    expect(numbered.split('\n')[0]).toBe(' 1| l0');
    expect(numbered.split('\n')[9]).toBe('10| l9');
  });
});

describe('assembleContext', () => {
  const prFiles = [file('src/a.ts'), file('pnpm-lock.yaml'), file('src/gone.ts', { status: 'removed' })];
  const readFile = (path: string) => (path === 'src/a.ts' ? 'const a = 2;\n' : null);

  it('joint le diff filtré et le contenu des seuls fichiers relisibles', () => {
    const context = assemble({ rawDiff: DIFF, prFiles, readFile });
    expect(context.files.map((entry) => entry.path)).toEqual(['src/a.ts']);
    expect(context.files[0]?.numbered).toBe('1| const a = 2;');
    expect(context.skipped).toEqual(['pnpm-lock.yaml']);
    expect(context.diff).not.toContain('lockfileVersion');
  });

  it('déclare en « omitted » le fichier trop gros pour le budget', () => {
    const context = assemble({
      rawDiff: DIFF,
      prFiles: [file('src/a.ts')],
      readFile: () => 'x'.repeat(500),
      budget: { ...BUDGET, totalChars: 1000, perFileChars: 100 },
    });
    expect(context.files).toHaveLength(0);
    expect(context.omitted).toEqual(['src/a.ts']);
  });

  it('remplit jusqu’au budget global puis omet le reste', () => {
    const context = assemble({
      prFiles: [file('a.ts', { additions: 1 }), file('b.ts', { additions: 2 })],
      readFile: () => 'y'.repeat(60),
      budget: { ...BUDGET, totalChars: 100, perFileChars: 100 },
    });
    expect(context.files.map((entry) => entry.path)).toEqual(['a.ts']);
    expect(context.omitted).toEqual(['b.ts']);
  });

  it('rend les fichiers dans l’ordre de la PR, pas dans l’ordre de sélection', () => {
    const context = assemble({
      prFiles: [file('gros.ts', { additions: 900 }), file('petit.ts', { additions: 1 })],
      readFile: () => 'z',
    });
    expect(context.files.map((entry) => entry.path)).toEqual(['gros.ts', 'petit.ts']);
  });
});

describe('les fichiers importés, joints en second rang', () => {
  /** Une PR d'un fichier qui importe un helper et un schéma du dépôt. */
  const REPO: Record<string, string> = {
    'src/app/page.tsx': "import { truncate } from '@/lib/format';\nimport { STATUS } from './status';\n",
    'src/lib/format.ts': 'export const truncate = (s: string) => s.slice(0, 10);\n',
    'src/app/status.ts': 'export const STATUS = ["draft"];\n',
    'src/generated/prisma.ts': 'export const client = {};\n',
  };

  const imported = (over: Partial<AssembleOptions> = {}) =>
    assemble({
      prFiles: [file('src/app/page.tsx')],
      readFile: (path) => REPO[path] ?? null,
      exists: (path) => path in REPO,
      ...over,
    }).imported.map((entry) => entry.path);

  it('joint ce que les fichiers touchés importent, alias compris', () => {
    expect(imported()).toEqual(['src/lib/format.ts', 'src/app/status.ts']);
  });

  it('numérote les lignes, pour que le modèle puisse citer un chemin:ligne juste', () => {
    const context = assemble({
      prFiles: [file('src/app/page.tsx')],
      readFile: (path) => REPO[path] ?? null,
      exists: (path) => path in REPO,
    });
    expect(context.imported[0]?.numbered).toBe('1| export const truncate = (s: string) => s.slice(0, 10);');
  });

  it('ne joint rien quand le budget est à zéro', () => {
    expect(imported({ budget: { ...BUDGET, importedChars: 0 } })).toEqual([]);
  });

  it('laisse au contexte importé un budget à lui, que la PR ne peut pas manger', () => {
    // Le budget des fichiers touchés est épuisé ; celui des imports ne l'est pas.
    const context = assemble({
      prFiles: [file('src/app/page.tsx')],
      readFile: (path) => REPO[path] ?? null,
      exists: (path) => path in REPO,
      budget: { ...BUDGET, totalChars: 10_000, importedChars: 60 },
    });
    // 55 caractères tiennent, le second dépasse : pas de liste des recalés, le
    // contexte importé n'a jamais été promis au lecteur.
    expect(context.imported.map((entry) => entry.path)).toEqual(['src/app/status.ts']);
  });

  it('respecte les exclusions du dépôt', () => {
    expect(
      imported({
        readFile: (path) => (path === 'src/app/page.tsx' ? "import x from '@/generated/prisma';" : REPO[path] ?? null),
      }),
    ).toEqual([]);
  });

  it('ne rejoint pas un fichier déjà fourni parce qu’il est dans la PR', () => {
    expect(imported({ prFiles: [file('src/app/page.tsx'), file('src/lib/format.ts')] })).toEqual([
      'src/app/status.ts',
    ]);
  });
});


describe('les fichiers dont pas une ligne ne bouge', () => {
  it('écarte un renommage pur : son contenu est du code que la PR n’a pas touché', () => {
    expect(touchesLines(file('src/b.ts', { additions: 0, deletions: 0, status: 'renamed' }))).toBe(false);
  });

  it('garde un renommage assorti d’une retouche', () => {
    expect(touchesLines(file('src/b.ts', { additions: 3, deletions: 1, status: 'renamed' }))).toBe(true);
  });

  /** « Vide » est justement ce que la review doit pouvoir constater. */
  it('garde un fichier neuf mais vide', () => {
    expect(touchesLines(file('src/vide.ts', { additions: 0, deletions: 0, status: 'added' }))).toBe(true);
  });

  it('ne lit pas le contenu d’un fichier seulement déplacé', () => {
    const context = assemble({
      rawDiff: 'diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts',
      prFiles: [file('src/b.ts', { additions: 0, deletions: 0, status: 'renamed' })],
      readFile: () => 'const nonLu = 1;',
    });
    expect(context.files).toEqual([]);
    // Ni une troncature ni un oubli : le diff porte déjà le renommage.
    expect(context.omitted).toEqual([]);
  });
});

describe('le diff d’un fichier neuf, doublon de son contenu numéroté', () => {
  const diff = [
    'diff --git a/src/neuf.ts b/src/neuf.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/neuf.ts',
    '@@ -0,0 +1,2 @@',
    '+const a = 1;',
    '+const b = 2;',
  ].join('\n');

  it('remplace le corps par un renvoi, en gardant les en-têtes', () => {
    const folded = foldAddedFiles(diff, new Set(['src/neuf.ts']));
    expect(folded).toContain('+++ b/src/neuf.ts');
    expect(folded).toContain('see its full numbered content below');
    expect(folded).not.toContain('+const a = 1;');
  });

  it('laisse intact un fichier qu’on ne lui a pas désigné', () => {
    expect(foldAddedFiles(diff, new Set(['src/autre.ts']))).toBe(diff);
  });

  it('rend le diff tel quel quand il n’y a rien à replier', () => {
    expect(foldAddedFiles(diff, new Set())).toBe(diff);
  });

  /** Sans hunk, il n'y a pas de corps à replier : on ne touche pas à l'inconnu. */
  it('ne touche pas à un bloc sans hunk', () => {
    const sansHunk = 'diff --git a/src/neuf.ts b/src/neuf.ts\nnew file mode 100644';
    expect(foldAddedFiles(sansHunk, new Set(['src/neuf.ts']))).toBe(sansHunk);
  });

  it('replie à l’assemblage quand le contenu intégral part bien', () => {
    const context = assemble({
      rawDiff: diff,
      prFiles: [file('src/neuf.ts', { additions: 2, deletions: 0, status: 'added' })],
      readFile: () => 'const a = 1;\nconst b = 2;',
    });
    expect(context.diff).toContain('see its full numbered content below');
    expect(context.files[0]?.numbered).toContain('const a = 1;');
  });

  /**
   * Un fichier neuf trop gros pour le budget garde son diff entier : sans quoi
   * la PR l'aurait ajouté sans que personne ne puisse le lire.
   */
  it('garde le diff entier d’un fichier neuf que le budget a écarté', () => {
    const context = assemble({
      rawDiff: diff,
      prFiles: [file('src/neuf.ts', { additions: 2, deletions: 0, status: 'added' })],
      readFile: () => 'x'.repeat(200),
      budget: { totalChars: 10, perFileChars: 10, importedChars: 0 },
    });
    expect(context.omitted).toEqual(['src/neuf.ts']);
    expect(context.diff).toContain('+const a = 1;');
  });
});


describe('le contexte tel qu’une passe le voit', () => {
  const base = {
    diff: 'd',
    files: [{ path: 'src/a.ts', numbered: '1| a' }],
    imported: [{ path: 'src/b.ts', numbered: '1| b' }],
    skipped: [],
    omitted: [],
  };

  it('laisse tout passer à une passe qui se sert des imports', () => {
    expect(contextFor(base, true)).toBe(base);
  });

  it('retire les imports à une passe qui n’en tire rien, et rien d’autre', () => {
    const seen = contextFor(base, false);
    expect(seen.imported).toEqual([]);
    expect(seen.files).toBe(base.files);
    expect(seen.diff).toBe(base.diff);
  });
});
