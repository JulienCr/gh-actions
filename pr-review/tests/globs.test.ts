import { describe, expect, it } from 'vitest';

import { compileGlob, compileMatcher, parseList } from '../src/globs';

const matches = (pattern: string, path: string) => compileMatcher([pattern])(path);

describe('un motif sans barre oblique porte sur le nom de fichier', () => {
  it('attrape le fichier à n’importe quelle profondeur', () => {
    expect(matches('*.png', 'hero.png')).toBe(true);
    expect(matches('*.png', 'public/images/hero.png')).toBe(true);
  });

  it('n’attrape pas une autre extension, ni le nom dans un dossier', () => {
    expect(matches('*.png', 'hero.png.ts')).toBe(false);
    expect(matches('*.png', 'png/index.ts')).toBe(false);
  });

  it('accepte un nom exact', () => {
    expect(matches('pnpm-lock.yaml', 'pnpm-lock.yaml')).toBe(true);
    // Le nom seul vaut à toute profondeur, comme dans un .gitignore.
    expect(matches('pnpm-lock.yaml', 'apps/web/pnpm-lock.yaml')).toBe(true);
  });
});

describe('un motif avec barre oblique est ancré à la racine du dépôt', () => {
  it('attrape ce qui est sous le dossier visé', () => {
    expect(matches('src/generated/**', 'src/generated/prisma/client.ts')).toBe(true);
    expect(matches('src/generated/**', 'src/generated/a.ts')).toBe(true);
  });

  it('n’attrape pas le même dossier ailleurs dans l’arborescence', () => {
    expect(matches('src/generated/**', 'packages/x/src/generated/a.ts')).toBe(false);
  });

  it('n’attrape pas un dossier voisin dont le nom commence pareil', () => {
    expect(matches('deploy/**', 'deployment/notes.md')).toBe(false);
  });

  it('traite un motif finissant par une barre comme son contenu entier', () => {
    expect(matches('deploy/', 'deploy/app.js')).toBe(true);
    expect(matches('deploy/', 'deploy/nested/deep/app.js')).toBe(true);
  });

  it('laisse `**` franchir les barres et `*` s’arrêter à la première', () => {
    expect(matches('src/**/*.test.ts', 'src/a/b/c.test.ts')).toBe(true);
    // `**/` doit rester facultatif, sinon un motif de dossier raterait son
    // propre contenu direct.
    expect(matches('src/**/*.test.ts', 'src/c.test.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/a/b.ts')).toBe(false);
  });
});

describe('compileGlob', () => {
  it('ignore une ligne vide ou un commentaire', () => {
    expect(compileGlob('')).toBeNull();
    expect(compileGlob('   ')).toBeNull();
    expect(compileGlob('# les binaires')).toBeNull();
  });

  it('normalise les préfixes équivalents', () => {
    for (const pattern of ['deploy/**', './deploy/**', '/deploy/**']) {
      expect(matches(pattern, 'deploy/app.js')).toBe(true);
    }
  });

  it('neutralise les caractères d’expression régulière contenus dans un nom', () => {
    expect(matches('a+b.ts', 'a+b.ts')).toBe(true);
    // Sans échappement, `a+b.ts` matcherait « aab.ts » et « ab.ts » par le
    // quantificateur, et n'importe quel caractère à la place du point.
    expect(matches('a+b.ts', 'aab.ts')).toBe(false);
    expect(matches('a+b.ts', 'aXb.ts')).toBe(false);
  });
});

describe('compileMatcher', () => {
  it('rend un prédicat toujours faux sur une liste vide', () => {
    const none = compileMatcher([]);
    expect(none('n’importe quoi')).toBe(false);
  });

  it('suffit qu’un seul motif corresponde', () => {
    const skip = compileMatcher(['*.png', 'src/generated/**']);
    expect(skip('src/generated/a.ts')).toBe(true);
    expect(skip('a.png')).toBe(true);
    expect(skip('src/a.ts')).toBe(false);
  });
});

describe('parseList', () => {
  it('découpe un input multi-ligne en ignorant le vide et les commentaires', () => {
    expect(parseList('  a/**  \n\n# commentaire\nb.ts\n')).toEqual(['a/**', 'b.ts']);
  });

  it('rend une liste vide sur un input vide', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList('\n  \n')).toEqual([]);
  });
});
