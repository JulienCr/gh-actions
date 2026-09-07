/**
 * Accès GitHub par le CLI `gh`.
 *
 * Le CLI plutôt qu'octokit : il est déjà là sur les runners, il est authentifié
 * par `GH_TOKEN`, et c'est le même chemin qu'en local. Voir `exec.ts` pour la
 * raison de fond, qui est de n'avoir aucune dépendance npm au runtime.
 */

import { run, runWithStdin } from './exec';

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
  /** `added` | `modified` | `removed` | `renamed`, tel que rendu par l'API GitHub. */
  status: string;
}

export interface PrMeta {
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseRefName: string;
  isDraft: boolean;
  files: PrFile[];
}

interface RawPrView {
  number: number;
  title: string;
  body: string | null;
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
  files: { path: string; additions: number; deletions: number; changeType?: string }[] | null;
}

/**
 * Traduit le `changeType` de l'API en statut de fichier.
 *
 * `gh pr view --json files` ne rend PAS de champ `status` : il rend
 * `changeType`, en capitales (`ADDED`, `MODIFIED`, `DELETED`, `RENAMED`,
 * `COPIED`, `CHANGED`). Lire `status` rendait donc `undefined` sur chaque
 * fichier, et le repli faisait passer toute une PR pour « modified » :
 * un fichier supprimé n'était écarté que parce que sa lecture ratait, et un
 * fichier neuf ne se distinguait pas d'un fichier retouché.
 *
 * Le repli reste « modified », qui est le cas le plus prudent : on lit le
 * contenu et on le donne au modèle. Un `gh` trop ancien dégrade, il n'échoue pas.
 */
export function statusOf(changeType: string | undefined): string {
  switch (changeType?.toUpperCase()) {
    case 'ADDED':
      return 'added';
    case 'DELETED':
      return 'removed';
    case 'RENAMED':
      return 'renamed';
    default:
      return 'modified';
  }
}

export async function fetchPrMeta(pr: number): Promise<PrMeta> {
  const stdout = await run('gh', [
    'pr',
    'view',
    String(pr),
    '--json',
    'number,title,body,headRefOid,baseRefName,isDraft,files',
  ]);
  const raw = JSON.parse(stdout) as RawPrView;
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    headSha: raw.headRefOid,
    baseRefName: raw.baseRefName,
    isDraft: raw.isDraft,
    files: (raw.files ?? []).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      status: statusOf(file.changeType),
    })),
  };
}

export function fetchPrDiff(pr: number): Promise<string> {
  return run('gh', ['pr', 'diff', String(pr)]);
}

export async function postComment(pr: number, body: string): Promise<void> {
  await runWithStdin('gh', ['pr', 'comment', String(pr), '--body-file', '-'], body);
}

/** SHA du HEAD courant, ou null hors dépôt git. */
export async function currentHeadSha(): Promise<string | null> {
  try {
    return (await run('git', ['rev-parse', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

/** `owner/repo`, depuis l'environnement Actions ou, en local, depuis le remote. */
export async function resolveRepo(): Promise<string> {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  const stdout = await run('gh', ['repo', 'view', '--json', 'nameWithOwner']);
  return (JSON.parse(stdout) as { nameWithOwner: string }).nameWithOwner;
}

/**
 * Identifiant du commentaire d'Aristarque sur cette PR, s'il y en a un.
 *
 * Le marqueur est en tête de corps depuis toujours (`MARKER` dans `render.ts`),
 * mais personne ne le relisait : chaque run posait un commentaire neuf, si bien
 * qu'une PR relue trois fois portait trois rapports dont deux périmés. On prend
 * le DERNIER trouvé : si un run ancien en a laissé un que le nettoyage a raté,
 * c'est le plus récent qui fait foi.
 */
export interface MarkedComment {
  id: number;
  body: string;
}

export async function findMarkedComment(
  repo: string,
  pr: number,
  marker: string,
): Promise<MarkedComment | null> {
  const stdout = await run('gh', [
    'api',
    `repos/${repo}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    // Une ligne de JSON compact par commentaire : le corps porte des retours à
    // la ligne, donc `\(.id) \(.body)` en collerait plusieurs sur une seule.
    `.[] | select(.body | startswith(${JSON.stringify(marker)})) | {id, body} | tojson`,
  ]);
  const found = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as MarkedComment);
  return found.at(-1) ?? null;
}

/**
 * Réécrit un commentaire existant.
 *
 * Le corps part en JSON par stdin plutôt qu'en `-f body=…` : un rapport de
 * review fait plusieurs kilo-octets, contient des backticks et des retours à la
 * ligne, et `-f` le passerait en argv. Même raison que `--body-file -` pour
 * `gh pr comment` (cf. `runWithStdin` dans `exec.ts`).
 */
export async function updateComment(repo: string, id: number, body: string): Promise<void> {
  await runWithStdin(
    'gh',
    ['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${id}`, '--input', '-'],
    JSON.stringify({ body }),
  );
}

/**
 * Pose le rapport là où il est déjà, ou le crée.
 *
 * C'est ce qui rend l'annonce possible : le commentaire « review en cours »
 * posté au démarrage EST celui que le rapport final vient remplir. Un lecteur
 * n'a donc jamais à se demander si l'absence de rapport veut dire « pas encore »
 * ou « pas déclenché ».
 *
 * Une réécriture qui échoue (commentaire supprimé à la main entre-temps)
 * retombe sur un commentaire neuf : perdre le rapport vaudrait moins que perdre
 * l'unicité.
 */
export async function upsertComment(
  repo: string,
  pr: number,
  marker: string,
  body: string,
): Promise<void> {
  const existing = await findMarkedComment(repo, pr, marker).catch(() => null);
  if (existing === null) {
    await postComment(pr, body);
    return;
  }
  try {
    await updateComment(repo, existing.id, body);
  } catch {
    await postComment(pr, body);
  }
}

/** Les états qu'accepte l'API des statuts de commit. */
export type StatusState = 'pending' | 'success' | 'failure' | 'error';

/**
 * Pose un statut de commit sur la tête de la PR.
 *
 * C'est le seul mécanisme qui fait *attendre* une review. Un commentaire ne
 * gate rien : `mergeStateStatus` ne le voit pas, et un auto-merge armé part
 * par-dessus une review encore en cours. Un statut, lui, se déclare requis dans
 * la protection de branche.
 *
 * Et il couvre le cas plus vicieux de l'événement qui n'arrive jamais : un
 * statut requis mais ABSENT bloque aussi le merge, là où un commentaire absent
 * ne se distingue pas d'une PR jugée irréprochable.
 */
export async function postStatus(
  repo: string,
  sha: string,
  status: { state: StatusState; context: string; description: string; targetUrl?: string },
): Promise<void> {
  await runWithStdin(
    'gh',
    ['api', '--method', 'POST', `repos/${repo}/statuses/${sha}`, '--input', '-'],
    JSON.stringify({
      state: status.state,
      context: status.context,
      // L'API tronque au-delà de 140 caractères ; le faire ici garde le message
      // lisible plutôt que coupé au milieu d'un mot par GitHub.
      description: status.description.slice(0, 140),
      ...(status.targetUrl ? { target_url: status.targetUrl } : {}),
    }),
  );
}
