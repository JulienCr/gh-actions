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
  files: { path: string; additions: number; deletions: number; status?: string }[] | null;
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
      status: file.status ?? 'modified',
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
