import { describe, expect, it } from 'vitest';

import {
  assembleContext,
  filterDiff,
  hasContent,
  numberLines,
  splitDiffByFile,
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

const BUDGET: ContextBudget = { totalChars: 500_000, perFileChars: 80_000 };

const assemble = (over: Partial<AssembleOptions>) =>
  assembleContext({ rawDiff: '', prFiles: [], readFile: () => null, isSkipped, budget: BUDGET, ...over });

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
      budget: { totalChars: 1000, perFileChars: 100 },
    });
    expect(context.files).toHaveLength(0);
    expect(context.omitted).toEqual(['src/a.ts']);
  });

  it('remplit jusqu’au budget global puis omet le reste', () => {
    const context = assemble({
      prFiles: [file('a.ts', { additions: 1 }), file('b.ts', { additions: 2 })],
      readFile: () => 'y'.repeat(60),
      budget: { totalChars: 100, perFileChars: 100 },
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
