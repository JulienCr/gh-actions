/**
 * Ce que les fichiers touchés importent, pour que le modèle tranche au lieu de
 * douter. Module **pur** : l'existence d'un fichier est injectée.
 *
 * Le modèle ne recevait que les fichiers de la PR, et le prompt lui interdit de
 * décrire un fichier qu'il n'a pas reçu. Un doute légitime sur un appelant ne
 * pouvait donc que finir sous « À vérifier » : « l'enum OrderStatus couvre-t-il
 * bien ces six valeurs ? ». Avec le fichier sous les yeux, c'est une trouvaille
 * ou ce n'est rien.
 *
 * Ce n'est pas un résolveur de modules, et ça n'essaie pas de l'être. Il n'y a
 * ni lecture de `tsconfig.json`, ni `exports` de `package.json`, ni conditions
 * d'export. **Une résolution ratée dégrade la review, elle ne doit jamais
 * l'annuler** : tout ce qui ne tombe pas juste est ignoré en silence.
 */

/** Ce qu'on tente d'ajouter à un chemin sans extension, dans cet ordre. */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];

/**
 * Bases essayées pour l'alias `@/`, dans cet ordre.
 *
 * Couvre Next.js avec et sans `src/`. Le vrai mapping vit dans
 * `compilerOptions.paths`, mais un tsconfig est du JSON à commentaires, souvent
 * avec un `extends` : le parser pour gagner les alias exotiques coûterait plus
 * que ça ne rapporte, et échouerait sur les dépôts qu'on ne connaît pas.
 */
const ALIAS_BASES = ['src/', '', 'app/'];

/**
 * Les quatre formes d'import, cherchées à la regex plutôt qu'à l'analyse
 * syntaxique.
 *
 * Un `from '…'` dans un commentaire ou dans une chaîne produit un faux positif,
 * et c'est sans conséquence : soit il ne résout pas et il est écarté, soit il
 * résout et c'est un vrai fichier du dépôt, donc du contexte légitime.
 */
const PATTERNS = [
  // import x from 'y' ; export { a } from 'y' ; export * from 'y'
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  // import 'y' (effet de bord : feuille de style, polyfill)
  /\bimport\s+['"]([^'"\n]+)['"]/g,
  // import('y')
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  // require('y')
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** Un spécificateur qui désigne un fichier du dépôt, par opposition à un paquet npm. */
function isInternal(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('@/');
}

/**
 * Les spécificateurs internes d'un fichier, dédupliqués, dans l'ordre de lecture.
 *
 * Les paquets npm sont écartés ici et pas plus loin : ils n'ont aucune chance de
 * résoudre vers un fichier du dépôt, et les garder ferait tourner la résolution
 * sur la moitié des lignes d'un fichier moderne.
 */
export function extractImports(content: string): string[] {
  const found = new Map<string, number>();
  for (const pattern of PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || !isInternal(specifier) || found.has(specifier)) continue;
      found.set(specifier, match.index);
    }
  }
  // Par position dans le fichier, et non par forme d'import : les motifs sont
  // essayés l'un après l'autre, ce qui rangerait tous les `require` après tous
  // les `import` et présenterait au modèle un ordre que le fichier n'a pas.
  return [...found].sort((a, b) => a[1] - b[1]).map(([specifier]) => specifier);
}

/**
 * Applique les `.` et `..` d'un chemin, et rend `null` s'il sort du dépôt.
 *
 * Écrit à la main plutôt qu'avec `node:path` : les chemins manipulés ici sont
 * ceux de git, toujours séparés par `/`, là où `path.join` produirait des
 * antislashs sous Windows et casserait la comparaison avec les chemins de la PR.
 *
 * Le refus de remonter au-dessus de la racine n'est pas cosmétique : le lecteur
 * injecté fait `readFileSync(join(root, chemin))`, donc un `../../../etc/passwd`
 * écrit dans un import serait lu et envoyé au modèle.
 */
export function normalizePath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment !== '..') {
      segments.push(segment);
      continue;
    }
    if (segments.length === 0) return null;
    segments.pop();
  }
  return segments.length > 0 ? segments.join('/') : null;
}

/** Le dossier d'un chemin de fichier, `''` à la racine. */
function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * Les fichiers que pourrait désigner un chemin sans extension, dans l'ordre de
 * préférence.
 *
 * Le chemin nu vient en premier, ce qui couvre `./styles.css` et `./data.json`.
 * Le cas NodeNext ensuite : un import écrit `./x.js` désigne `x.ts` dans un
 * dépôt TypeScript moderne, et sans cette reprise on raterait tout un projet.
 */
function candidates(base: string): string[] {
  const list = [base];

  const jsToTs = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsToTs) {
    const stem = base.slice(0, -jsToTs[0].length);
    list.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }

  for (const extension of EXTENSIONS) list.push(`${base}${extension}`);
  for (const extension of EXTENSIONS) list.push(`${base}/index${extension}`);
  return list;
}

/** Ce chemin désigne-t-il un fichier lisible du dépôt ? */
export type ExistsPredicate = (path: string) => boolean;

/**
 * Résout un spécificateur vers un chemin du dépôt, ou rend `null`.
 *
 * `fromPath` est le fichier qui écrit l'import, relatif à la racine du dépôt.
 */
export function resolveImport(
  fromPath: string,
  specifier: string,
  exists: ExistsPredicate,
): string | null {
  const bases: string[] = [];

  if (specifier.startsWith('@/')) {
    const rest = specifier.slice('@/'.length);
    for (const base of ALIAS_BASES) bases.push(`${base}${rest}`);
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    bases.push(`${dirOf(fromPath)}/${specifier}`);
  } else {
    return null;
  }

  for (const base of bases) {
    const normalized = normalizePath(base);
    if (normalized === null) continue;
    for (const candidate of candidates(normalized)) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Les fichiers importés par un lot de fichiers, dédupliqués et dans l'ordre.
 *
 * Un seul niveau, délibérément : le deuxième ramène la moitié du dépôt, pour un
 * gain qui décroît vite. Les fichiers déjà fournis au modèle sont écartés ici
 * plutôt que par l'appelant, pour que le compte rendu ne promette pas un
 * contexte que la PR contenait déjà.
 */
export function collectImports(
  sources: { path: string; content: string }[],
  options: { exists: ExistsPredicate; isExcluded: (path: string) => boolean },
): string[] {
  const seen = new Set(sources.map((source) => source.path));
  const collected: string[] = [];

  for (const source of sources) {
    for (const specifier of extractImports(source.content)) {
      const resolved = resolveImport(source.path, specifier, options.exists);
      if (resolved === null || seen.has(resolved)) continue;
      seen.add(resolved);
      if (options.isExcluded(resolved)) continue;
      collected.push(resolved);
    }
  }
  return collected;
}
