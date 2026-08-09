/**
 * Bundle des actions vers `dist/`, avec esbuild.
 *
 * Le bundle est COMMITTÉ. Une action JavaScript est exécutée telle quelle par le
 * runner, qui ne fait ni `npm install` ni build : le seul moyen de livrer du
 * TypeScript est de livrer sa sortie. La CI vérifie que `dist/` correspond bien
 * à `src/` (voir .github/workflows/ci.yml) ; sans cette garde, un tag `v1`
 * distribuerait silencieusement l'ancien bundle.
 *
 * Extension `.mjs` plutôt que `.js` : le format est ESM, et un `.js` dépendrait
 * du `type` du package.json le plus proche, donc de la façon dont le fichier a
 * été déployé. `.mjs` ne dépend de rien.
 */

import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ACTIONS = ['pr-review'];

for (const action of ACTIONS) {
  const outfile = join(root, action, 'dist', 'index.mjs');
  await build({
    entryPoints: [join(root, action, 'src', 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // Le runner GitHub exécute node 24 (`runs.using: node24`). En local, le même
    // fichier sert de CLI, sous le node du poste.
    target: 'node20',
    // Sert au double usage : `main:` de l'action, et `bin:` du package.
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'none',
    // Le bundle n'a aucune dépendance runtime : uniquement des builtins Node,
    // plus les CLI `gh` et `op`, appelés en sous-processus.
    packages: 'bundle',
  });
  await chmod(outfile, 0o755);
  console.log(`✓ ${action}/dist/index.mjs`);
}
