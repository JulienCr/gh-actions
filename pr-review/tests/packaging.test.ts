import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Les deux points d'entrée du bundle, et personne pour se plaindre quand ils
 * pointent à côté.
 *
 * Mesuré en v1.0.0 : `bin` désignait `dist/index.js` alors que le build produit
 * `dist/index.mjs`. **npm ignore silencieusement un bin dont la cible n'existe
 * pas** — l'installation réussit, `node_modules/.bin/` reste vide, et l'erreur
 * n'apparaît qu'à l'exécution, sous la forme d'un « command not found » qui ne
 * nomme même pas le fichier fautif. Le typecheck ne voit rien, les tests non
 * plus : ces chemins sont des chaînes dans deux fichiers de configuration.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface PackageJson {
  bin: Record<string, string>;
  files: string[];
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as PackageJson;

describe('les points d’entrée déclarés existent', () => {
  it('chaque « bin » du package.json désigne un fichier présent', () => {
    for (const [name, target] of Object.entries(packageJson.bin)) {
      expect(existsSync(join(root, target)), `bin « ${name} » → ${target}`).toBe(true);
    }
  });

  it('le « main » de chaque action.yml désigne un fichier présent', () => {
    for (const target of Object.keys(packageJson.bin)) {
      const actionDir = join(root, target.split('/')[0]!);
      const manifest = readFileSync(join(actionDir, 'action.yml'), 'utf-8');
      const main = /^\s*main:\s*['"]?([^'"\s]+)/m.exec(manifest)?.[1];
      expect(main, "action.yml sans « main »").toBeTruthy();
      expect(existsSync(join(actionDir, main!)), `main → ${main}`).toBe(true);
    }
  });

  it('le champ « files » embarque le dist de chaque bin', () => {
    // Sans cette entrée, `npm i github:…` installe un paquet sans son binaire,
    // et on retombe sur le « command not found » ci-dessus.
    for (const target of Object.values(packageJson.bin)) {
      const distDir = target.slice(0, target.lastIndexOf('/'));
      expect(packageJson.files).toContain(distDir);
    }
  });
});
