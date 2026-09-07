/**
 * Filtrage de chemins par motifs, façon `.gitignore`. Module **pur**.
 *
 * Écrit à la main plutôt qu'emprunté : le bundle ne doit tirer aucune dépendance
 * runtime (cf. l'en-tête de `gh.ts`), et `path.matchesGlob` est encore marqué
 * expérimental, donc capable d'écrire un avertissement dans un job dont tout
 * l'intérêt est de rester lisible.
 *
 * Sémantique retenue, celle que les gens écrivent spontanément dans un
 * `.gitignore` :
 *
 * - un motif SANS barre oblique porte sur le **nom de fichier** seul, à
 *   n'importe quelle profondeur : `*.png` attrape `src/img/a.png` ;
 * - un motif AVEC barre oblique porte sur le chemin complet, ancré à la racine
 *   du dépôt : `src/generated/**` n'attrape que ce qui est sous ce dossier ;
 * - un motif qui finit par `/` vaut pour tout son contenu ;
 * - `*` ne franchit pas une barre oblique, `**` la franchit.
 */

/** Caractères à neutraliser hors des jokers. */
const SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Traduit un motif en source d'expression régulière.
 *
 * Le balayage est fait caractère par caractère : un `replace` global sur `**`
 * puis sur `*` réécrirait les jokers déjà traduits.
 */
function translate(pattern: string): string {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index]!;

    if (char === '*') {
      const isDouble = pattern[index + 1] === '*';
      if (isDouble) {
        // `a/**/b` doit aussi matcher `a/b` : le segment intermédiaire est
        // facultatif, sinon un motif de dossier raterait son propre contenu direct.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 3;
          continue;
        }
        source += '.*';
        index += 2;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += char.replace(SPECIAL, '\\$&');
    index += 1;
  }

  return source;
}

export interface CompiledGlob {
  regexp: RegExp;
  /** Le motif porte sur le nom de fichier seul (aucune barre oblique écrite). */
  basenameOnly: boolean;
}

/** Compile un motif, ou rend `null` pour une ligne vide ou un commentaire. */
export function compileGlob(raw: string): CompiledGlob | null {
  let pattern = raw.trim();
  if (pattern === '' || pattern.startsWith('#')) return null;

  // `./x`, `/x` et `x` désignent la même chose : un chemin relatif à la racine.
  pattern = pattern.replace(/^\.\//, '').replace(/^\/+/, '');
  if (pattern === '') return null;

  const basenameOnly = !pattern.includes('/');
  // Un dossier vaut pour tout son contenu. Testé avant l'ajout du `**` pour que
  // `dist/` et `dist/**` compilent vers la même chose.
  if (pattern.endsWith('/')) pattern += '**';

  return { regexp: new RegExp(`^${translate(pattern)}$`), basenameOnly };
}

/**
 * Compile une liste de motifs en un prédicat.
 *
 * Les motifs sont compilés une fois pour toutes : le prédicat est appelé une
 * fois par fichier de la PR et une fois par bloc du diff.
 */
export function compileMatcher(patterns: readonly string[]): (path: string) => boolean {
  const compiled = patterns.map(compileGlob).filter((entry): entry is CompiledGlob => entry !== null);
  if (compiled.length === 0) return () => false;

  return (path: string) => {
    const normalized = path.replace(/^\.\//, '');
    const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
    return compiled.some((entry) => entry.regexp.test(entry.basenameOnly ? basename : normalized));
  };
}

/** Découpe un input multi-ligne en motifs. Les lignes vides ne comptent pas. */
export function parseList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}
