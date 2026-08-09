import { describe, expect, it } from 'vitest';

import { collectImports, extractImports, normalizePath, resolveImport } from '../src/imports';

/** Un dépôt imaginaire, réduit à la liste de ses fichiers. */
const REPO = new Set([
  'src/app/page.tsx',
  'src/lib/format.ts',
  'src/lib/schemas/index.ts',
  'src/components/Button.tsx',
  'src/styles/app.css',
  'app/legacy/util.js',
  'scripts/build.mjs',
]);

const exists = (path: string) => REPO.has(path);

describe('extractImports', () => {
  it('lit les quatre formes d’import et écarte les paquets npm', () => {
    const found = extractImports(`
      import { readFileSync } from 'node:fs';
      import React from 'react';
      import { format } from './lib/format';
      import type { Schema } from '../schemas';
      export { Button } from './components/Button';
      import './styles/app.css';
      const lazy = await import('@/lib/lazy');
      const legacy = require('../legacy/util');
    `);
    // Dans l'ordre du fichier, et non par forme d'import : c'est celui-là que le
    // modèle retrouvera dans la section de contexte.
    expect(found).toEqual([
      './lib/format',
      '../schemas',
      './components/Button',
      './styles/app.css',
      '@/lib/lazy',
      '../legacy/util',
    ]);
  });

  it('lit un import dynamique porteur d’attributs, dont la chaîne n’est pas suivie de « ) »', () => {
    expect(extractImports("const data = await import('./data.json', { with: { type: 'json' } });")).toEqual([
      './data.json',
    ]);
  });

  it('ne rend qu’une fois un chemin importé deux fois', () => {
    const found = extractImports("import a from './x';\nimport b from './x';");
    expect(found).toEqual(['./x']);
  });

  it('rend une liste vide sur un fichier sans import interne', () => {
    expect(extractImports('export const a = 1;')).toEqual([]);
  });
});

describe('normalizePath', () => {
  it('applique les . et les ..', () => {
    expect(normalizePath('src/lib/../app/./page.tsx')).toBe('src/app/page.tsx');
  });

  it('refuse un chemin qui remonte au-dessus de la racine', () => {
    // Le lecteur injecté fait readFileSync(join(root, chemin)) : sans ce refus,
    // un import écrit ainsi ferait lire un fichier hors du dépôt.
    expect(normalizePath('../../../etc/passwd')).toBeNull();
    expect(normalizePath('src/../../secrets.env')).toBeNull();
  });

  it('rend null plutôt qu’une chaîne vide sur un chemin qui ne désigne rien', () => {
    expect(normalizePath('./')).toBeNull();
  });
});

describe('resolveImport', () => {
  it('résout un chemin relatif en ajoutant l’extension', () => {
    expect(resolveImport('src/app/page.tsx', '../lib/format', exists)).toBe('src/lib/format.ts');
  });

  it('résout un dossier vers son index', () => {
    expect(resolveImport('src/lib/format.ts', './schemas', exists)).toBe('src/lib/schemas/index.ts');
  });

  it('garde le chemin tel quel quand il porte déjà son extension', () => {
    expect(resolveImport('src/app/page.tsx', '../styles/app.css', exists)).toBe('src/styles/app.css');
  });

  it('retente en .ts un import écrit en .js, comme le veut NodeNext', () => {
    expect(resolveImport('src/app/page.tsx', '../lib/format.js', exists)).toBe('src/lib/format.ts');
  });

  it('essaie les bases connues de l’alias @/', () => {
    expect(resolveImport('scripts/build.mjs', '@/lib/format', exists)).toBe('src/lib/format.ts');
    // Rien sous src/ : c'est la base « app/ » qui tombe juste.
    expect(resolveImport('scripts/build.mjs', '@/legacy/util', exists)).toBe('app/legacy/util.js');
  });

  it('rend null sur un paquet npm, sans le chercher dans le dépôt', () => {
    expect(resolveImport('src/app/page.tsx', 'react', exists)).toBeNull();
    expect(resolveImport('src/app/page.tsx', 'node:fs', exists)).toBeNull();
  });

  it('rend null sur un alias qui ne résout nulle part, sans bruit', () => {
    expect(resolveImport('src/app/page.tsx', '@/inexistant/module', exists)).toBeNull();
  });

  it('ne sort pas du dépôt, même si le fichier visé existe', () => {
    expect(resolveImport('src/app/page.tsx', '../../../../etc/passwd', () => true)).toBeNull();
  });
});

describe('collectImports', () => {
  const source = (path: string, content: string) => ({ path, content });

  it('rend les fichiers importés, sans ceux déjà fournis au modèle', () => {
    const collected = collectImports(
      [
        source('src/app/page.tsx', "import { format } from '../lib/format';\nimport { Button } from '../components/Button';"),
        source('src/lib/format.ts', "import { z } from 'zod';"),
      ],
      { exists, isExcluded: () => false },
    );
    // format.ts est un fichier de la PR : il est déjà en contexte, pas deux fois.
    expect(collected).toEqual(['src/components/Button.tsx']);
  });

  it('ne rend pas deux fois un module importé par deux fichiers', () => {
    const collected = collectImports(
      [
        source('src/a.ts', "import { format } from './lib/format';"),
        source('src/b.ts', "import { format } from './lib/format';"),
      ],
      { exists: (path) => path === 'src/lib/format.ts', isExcluded: () => false },
    );
    expect(collected).toEqual(['src/lib/format.ts']);
  });

  it('respecte les exclusions du dépôt', () => {
    const collected = collectImports(
      [source('src/app/page.tsx', "import { format } from '../lib/format';")],
      { exists, isExcluded: (path) => path.startsWith('src/lib/') },
    );
    expect(collected).toEqual([]);
  });

  it('n’explore qu’un seul niveau : les imports des imports ne comptent pas', () => {
    const collected = collectImports(
      [source('src/app/page.tsx', "import { format } from '../lib/format';")],
      { exists, isExcluded: () => false },
    );
    // format.ts importe schemas/, mais on ne lit pas ses imports : un deuxième
    // niveau ramènerait la moitié du dépôt.
    expect(collected).toEqual(['src/lib/format.ts']);
  });
});
