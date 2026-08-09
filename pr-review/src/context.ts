/**
 * Ce que le modèle reçoit d'une PR, et ce qu'on lui épargne.
 *
 * Module **pur** : aucune E/S, la lecture des fichiers est injectée. C'est ce
 * qui le rend testable sans dépôt de fixtures.
 *
 * Deux partis pris :
 *
 * 1. On envoie le diff **et** le contenu intégral des fichiers touchés. Un diff
 *    seul ne montre pas le voisinage, et c'est le voisinage qui dit si une
 *    chaîne française est de l'éditorial en dur ou un libellé technique, ou si
 *    une requête franchit une frontière de rôle. Avec les contextes longs des
 *    modèles visés et des PR à ~2500 lignes, ça tient très largement.
 * 2. Toute troncature est déclarée dans le commentaire final. Une review
 *    silencieusement partielle se lit exactement comme une review complète,
 *    c'est le pire des deux mondes.
 */

import type { PrFile } from './gh';

/** Prédicat « ce chemin est-il hors review ». Vient de `compileMatcher`. */
export type SkipPredicate = (path: string) => boolean;

/** Fichiers dont on peut lire le contenu après changement : ni ignoré, ni supprimé. */
export function hasContent(file: PrFile, isSkipped: SkipPredicate): boolean {
  return !isSkipped(file.path) && file.status !== 'removed';
}

export interface DiffChunk {
  path: string;
  body: string;
}

/**
 * Découpe un diff unifié par fichier.
 *
 * Le chemin est lu sur `+++ b/…`, et sur `--- a/…` quand la cible est
 * `/dev/null` (suppression) : l'en-tête `diff --git a/x b/y` est ambigu dès
 * qu'un chemin contient une espace, les lignes `---`/`+++` ne le sont pas.
 */
export function splitDiffByFile(diff: string): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  const lines = diff.split('\n');
  let current: string[] | null = null;

  const flush = () => {
    if (!current) return;
    const body = current.join('\n');
    chunks.push({ path: pathOfChunk(current), body });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return chunks;
}

function pathOfChunk(lines: string[]): string {
  let fromA = '';
  for (const line of lines) {
    if (line.startsWith('+++ b/')) return line.slice('+++ b/'.length).trim();
    if (line.startsWith('--- a/') && !fromA) fromA = line.slice('--- a/'.length).trim();
    // Les en-têtes se lisent en tête de bloc ; inutile de balayer tout le corps.
    if (line.startsWith('@@')) break;
  }
  if (fromA) return fromA;
  // Repli : `diff --git a/x b/x` sur un fichier sans hunk (mode, binaire…).
  const header = lines[0] ?? '';
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  return match?.[2] ?? match?.[1] ?? '';
}

/** Retire du diff les blocs correspondant à des fichiers hors review. */
export function filterDiff(diff: string, isSkipped: SkipPredicate): { diff: string; skipped: string[] } {
  const chunks = splitDiffByFile(diff);
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const chunk of chunks) {
    if (isSkipped(chunk.path)) skipped.push(chunk.path);
    else kept.push(chunk.body);
  }
  return { diff: kept.join('\n'), skipped };
}

/** Numérote les lignes, pour que le modèle puisse citer un `chemin:ligne` juste. */
export function numberLines(content: string): string {
  const lines = content.split('\n');
  // Un fichier qui finit par un saut de ligne produit un dernier élément vide
  // qui n'est pas une ligne : l'afficher décalerait le compte d'une unité.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, ' ')}| ${line}`).join('\n');
}

export interface FileContent {
  path: string;
  numbered: string;
}

export interface ContextBudget {
  /** Plafond global du contenu intégral, en caractères (pas en octets : c'est
   *  `String.length` qui est comparé, et un accent y compte pour un). */
  totalChars: number;
  /** Plafond par fichier. Un gros fichier ne doit pas manger tout le budget. */
  perFileChars: number;
}

export interface AssembledContext {
  diff: string;
  files: FileContent[];
  /** Fichiers écartés du diff comme du contenu (générés, binaires, lockfiles). */
  skipped: string[];
  /** Fichiers relus dans le diff mais dont le contenu intégral n'a pas tenu. */
  omitted: string[];
}

export interface AssembleOptions {
  rawDiff: string;
  prFiles: PrFile[];
  readFile: (path: string) => string | null;
  isSkipped: SkipPredicate;
  budget: ContextBudget;
}

/**
 * Assemble le contexte à partir du diff brut et d'un lecteur de fichiers.
 *
 * `readFile` rend `null` pour un fichier absent du checkout (supprimé, ou
 * binaire illisible) : l'absence de contenu n'est pas une erreur, le diff seul
 * fait alors foi.
 */
export function assembleContext({
  rawDiff,
  prFiles,
  readFile,
  isSkipped,
  budget,
}: AssembleOptions): AssembledContext {
  const { diff, skipped } = filterDiff(rawDiff, isSkipped);

  const files: FileContent[] = [];
  const omitted: string[] = [];
  let used = 0;

  // Les plus petits d'abord : à budget égal, mieux vaut le contexte complet de
  // huit fichiers que celui d'un seul gros.
  const candidates = prFiles
    .filter((file) => hasContent(file, isSkipped))
    .sort((a, b) => a.additions + a.deletions - (b.additions + b.deletions));

  for (const file of candidates) {
    const content = readFile(file.path);
    if (content === null) continue;
    if (content.length > budget.perFileChars || used + content.length > budget.totalChars) {
      omitted.push(file.path);
      continue;
    }
    used += content.length;
    files.push({ path: file.path, numbered: numberLines(content) });
  }

  // Rendre les fichiers dans l'ordre de la PR, pas dans l'ordre de sélection :
  // le modèle lit mieux une PR présentée comme elle a été écrite.
  const order = new Map(prFiles.map((file, index) => [file.path, index]));
  files.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));

  return { diff, files, skipped, omitted };
}
