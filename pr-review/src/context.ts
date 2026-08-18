/**
 * Ce que le modèle reçoit d'une PR, et ce qu'on lui épargne.
 *
 * Module **pur** : aucune E/S, la lecture des fichiers est injectée. C'est ce
 * qui le rend testable sans dépôt de fixtures.
 *
 * Trois partis pris :
 *
 * 1. On envoie le diff **et** le contenu intégral des fichiers touchés. Un diff
 *    seul ne montre pas le voisinage, et c'est le voisinage qui dit si une
 *    chaîne française est de l'éditorial en dur ou un libellé technique, ou si
 *    une requête franchit une frontière de rôle. Avec les contextes longs des
 *    modèles visés et des PR à ~2500 lignes, ça tient très largement.
 * 2. On y joint, en second rang, les fichiers que ceux-là importent. Mesuré sur
 *    une PR réelle : 92 000 tokens envoyés pour une fenêtre de 976 000. La place
 *    existait, et elle manquait exactement là où le modèle devait renoncer à
 *    trancher, faute d'avoir l'appelant ou l'enum sous les yeux.
 * 3. Toute troncature est déclarée dans le commentaire final. Une review
 *    silencieusement partielle se lit exactement comme une review complète,
 *    c'est le pire des deux mondes.
 */

import type { PrFile } from './gh';
import { collectImports, type ExistsPredicate } from './imports';

/** Prédicat « ce chemin est-il hors review ». Vient de `compileMatcher`. */
export type SkipPredicate = (path: string) => boolean;

/** Fichiers dont on peut lire le contenu après changement : ni ignoré, ni supprimé. */
export function hasContent(file: PrFile, isSkipped: SkipPredicate): boolean {
  return !isSkipped(file.path) && file.status !== 'removed';
}

/**
 * Ce fichier a-t-il une ligne de changée ?
 *
 * Un renommage pur ou un changement de mode arrive avec `+0 / -0` : son contenu
 * intégral est du code que la PR n'a pas touché, et il partait une fois par
 * passe. Sur un refactor qui déplace trente fichiers, c'était trente fichiers
 * entiers payés trois fois pour un diff qui ne dit que `rename from/to`.
 *
 * Rien à déclarer au lecteur : le diff porte déjà le renommage, et la liste des
 * fichiers modifiés annonce le `+0 / -0`. Un fichier neuf mais vide reste
 * fourni, parce que « vide » est justement ce qu'il faut pouvoir constater.
 */
export function touchesLines(file: PrFile): boolean {
  return file.additions + file.deletions > 0 || file.status === 'added';
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

/**
 * Le renvoi qui remplace le corps du diff d'un fichier neuf.
 *
 * En anglais, comme le reste des consignes : un prompt bilingue force le modèle
 * à changer de registre au milieu du contexte.
 */
const FOLDED_NOTE = '(entirely new file: every line is an addition, see its full numbered content below)';

/**
 * Remplace le corps du diff des fichiers neufs par un renvoi.
 *
 * Pour un fichier ajouté, le diff redonne chaque ligne préfixée `+` quand la
 * section suivante rend les mêmes lignes en mieux : numérotées, donc citables,
 * et sans le bruit du préfixe. C'est un doublon exact, payé une fois par passe.
 *
 * Ne s'applique qu'aux fichiers dont le contenu intégral part réellement. Un
 * fichier neuf trop gros pour le budget garde son diff entier, sans quoi la PR
 * l'aurait ajouté sans que personne ne puisse le lire.
 */
export function foldAddedFiles(diff: string, folded: Set<string>): string {
  if (folded.size === 0) return diff;

  return splitDiffByFile(diff)
    .map((chunk) => {
      if (!folded.has(chunk.path)) return chunk.body;
      const lines = chunk.body.split('\n');
      const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
      // Sans hunk, il n'y a rien à replier : on ne touche pas à ce qu'on ne
      // reconnaît pas.
      if (firstHunk === -1) return chunk.body;
      return [...lines.slice(0, firstHunk), FOLDED_NOTE].join('\n');
    })
    .join('\n');
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
  /**
   * Plafond des fichiers importés, distinct du précédent.
   *
   * Séparé plutôt que partagé pour que les fichiers touchés, qui sont l'objet de
   * la review, gardent leur budget quoi qu'il arrive : une grosse PR ne doit pas
   * se retrouver privée de son propre contenu parce qu'un module partagé aurait
   * été lu avant. `0` désactive le contexte importé.
   */
  importedChars: number;
}

export interface AssembledContext {
  diff: string;
  files: FileContent[];
  /**
   * Fichiers non touchés par la PR, joints parce qu'un fichier touché les
   * importe. Ils servent à juger le changement, pas à être jugés.
   */
  imported: FileContent[];
  /** Fichiers écartés du diff comme du contenu (générés, binaires, lockfiles). */
  skipped: string[];
  /** Fichiers relus dans le diff mais dont le contenu intégral n'a pas tenu. */
  omitted: string[];
}

export interface AssembleOptions {
  rawDiff: string;
  prFiles: PrFile[];
  readFile: (path: string) => string | null;
  /**
   * `readFile` rendrait le même service, mais la résolution d'un import essaie
   * jusqu'à vingt candidats : les tester par une lecture ferait vingt lectures
   * jetées par import. Un test d'existence est une syscall, pas un fichier.
   */
  exists: ExistsPredicate;
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
  exists,
  isSkipped,
  budget,
}: AssembleOptions): AssembledContext {
  const { diff, skipped } = filterDiff(rawDiff, isSkipped);

  const sources: { path: string; content: string }[] = [];
  const omitted: string[] = [];
  let used = 0;

  // Les plus petits d'abord : à budget égal, mieux vaut le contexte complet de
  // huit fichiers que celui d'un seul gros.
  const candidates = prFiles
    .filter((file) => hasContent(file, isSkipped) && touchesLines(file))
    .sort((a, b) => a.additions + a.deletions - (b.additions + b.deletions));

  for (const file of candidates) {
    const content = readFile(file.path);
    if (content === null) continue;
    if (content.length > budget.perFileChars || used + content.length > budget.totalChars) {
      omitted.push(file.path);
      continue;
    }
    used += content.length;
    sources.push({ path: file.path, content });
  }

  // Rendre les fichiers dans l'ordre de la PR, pas dans l'ordre de sélection :
  // le modèle lit mieux une PR présentée comme elle a été écrite.
  const order = new Map(prFiles.map((file, index) => [file.path, index]));
  sources.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));

  const files = sources.map((source) => ({
    path: source.path,
    numbered: numberLines(source.content),
  }));

  const imported = readImported({ sources, readFile, exists, isSkipped, budget });

  // Le repli du diff se décide APRÈS la sélection des contenus : seul un fichier
  // neuf dont le contenu part vraiment a un diff redondant.
  const supplied = new Set(sources.map((source) => source.path));
  const added = new Set(
    prFiles.filter((file) => file.status === 'added' && supplied.has(file.path)).map((file) => file.path),
  );

  return { diff: foldAddedFiles(diff, added), files, imported, skipped, omitted };
}

interface ImportedOptions {
  sources: { path: string; content: string }[];
  readFile: (path: string) => string | null;
  exists: ExistsPredicate;
  isSkipped: SkipPredicate;
  budget: ContextBudget;
}

/**
 * Lit les fichiers importés par ceux de la PR, dans la limite de leur budget.
 *
 * Ne sont candidats que les imports des fichiers **effectivement fournis** : un
 * fichier trop gros pour tenir n'a pas été montré au modèle, joindre ses
 * dépendances reviendrait à commenter un voisinage sans le voisin.
 *
 * Un fichier qui ne tient pas n'est pas déclaré au lecteur, à la différence des
 * fichiers touchés : le contexte importé est un bonus, on n'a jamais promis de
 * l'avoir lu en entier.
 */
function readImported({ sources, readFile, exists, isSkipped, budget }: ImportedOptions): FileContent[] {
  if (budget.importedChars <= 0) return [];

  const paths = collectImports(sources, { exists, isExcluded: isSkipped });
  const contents = new Map<string, string>();
  for (const path of paths) {
    const content = readFile(path);
    if (content !== null && content.length <= budget.perFileChars) contents.set(path, content);
  }

  // Mêmes plus-petits-d'abord que pour les fichiers touchés, et pour la même
  // raison : huit dépendances lues valent mieux qu'une seule énorme.
  const kept = new Set<string>();
  let used = 0;
  for (const [path, content] of [...contents].sort((a, b) => a[1].length - b[1].length)) {
    if (used + content.length > budget.importedChars) continue;
    used += content.length;
    kept.add(path);
  }

  return paths
    .filter((path) => kept.has(path))
    .map((path) => ({ path, numbered: numberLines(contents.get(path)!) }));
}
