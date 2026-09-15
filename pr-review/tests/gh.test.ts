import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findMarkedComment,
  minimizeOtherReports,
  postStatus,
  statusOf,
  updateComment,
  upsertComment,
} from '../src/gh';
import { run, runWithStdin } from '../src/exec';

vi.mock('../src/exec', () => ({
  run: vi.fn(),
  runWithStdin: vi.fn(),
}));

const runMock = vi.mocked(run);
const stdinMock = vi.mocked(runWithStdin);

beforeEach(() => {
  runMock.mockReset().mockResolvedValue('');
  stdinMock.mockReset().mockResolvedValue('');
});

const MARKER = '<!-- aristarque -->';
const TAG = '<!-- aristarque-run: 42.1 -->';

/**
 * `gh pr view --json files` rend « changeType », jamais « status ». Lire le
 * mauvais champ ne casse rien de visible : tout devient « modified », et le
 * programme continue en croyant qu'une PR n'a que des retouches.
 */
describe('le statut d’un fichier, lu sur changeType', () => {
  it('reconnaît les trois statuts dont le programme se sert', () => {
    expect(statusOf('ADDED')).toBe('added');
    expect(statusOf('DELETED')).toBe('removed');
    expect(statusOf('RENAMED')).toBe('renamed');
  });

  it('range les autres changements avec les retouches', () => {
    expect(statusOf('MODIFIED')).toBe('modified');
    expect(statusOf('COPIED')).toBe('modified');
    expect(statusOf('CHANGED')).toBe('modified');
  });

  /** Un `gh` qui ne rendrait pas le champ doit dégrader, pas faire échouer. */
  it('retombe sur « modified », le cas le plus prudent, quand le champ manque', () => {
    expect(statusOf(undefined)).toBe('modified');
    expect(statusOf('')).toBe('modified');
  });
});


/**
 * `marker` finds every Aristarque comment across every run; `tag` narrows that
 * to one run's own — the pair is what lets several runs coexist on a PR.
 */
describe('retrouver le commentaire d’Aristarque', () => {
  it('interroge l’API en filtrant sur le marqueur et le tag de run, et garde le dernier', async () => {
    runMock.mockResolvedValue('{"id":11,"body":"vieux"}\n{"id":42,"body":"récent"}\n');
    expect(await findMarkedComment('o/r', 7, MARKER, TAG)).toEqual({ id: 42, body: 'récent' });

    const [command, args] = runMock.mock.calls[0]!;
    expect(command).toBe('gh');
    expect(args).toContain('repos/o/r/issues/7/comments');
    expect(args).toContain('--paginate');
    // Marker and tag go as JSON literals: they carry angle brackets and
    // dashes jq would read differently if pasted in raw.
    expect(args.at(-1)).toBe(
      `.[] | select((.body | startswith("${MARKER}")) and (.body | contains("${TAG}"))) | {id, body} | tojson`,
    );
  });

  it('rend null quand la PR n’en porte aucun', async () => {
    runMock.mockResolvedValue('\n');
    expect(await findMarkedComment('o/r', 7, MARKER, TAG)).toBeNull();
  });
});

/**
 * Le corps part en JSON par stdin. En argv il serait exposé aux limites de
 * taille et à la réinterprétation des backticks, dont un rapport est plein.
 */
describe('réécrire un commentaire', () => {
  it('PATCH l’identifiant donné, corps sur stdin', async () => {
    await updateComment('o/r', 42, 'coucou');
    const [command, args, input] = stdinMock.mock.calls[0]!;
    expect(command).toBe('gh');
    expect(args).toEqual(['api', '--method', 'PATCH', 'repos/o/r/issues/comments/42', '--input', '-']);
    expect(JSON.parse(input)).toEqual({ body: 'coucou' });
  });
});

describe('poser le rapport là où est déjà l’annonce de ce run', () => {
  it('réécrit quand le marqueur ET le tag de run sont trouvés', async () => {
    runMock.mockResolvedValue('{"id":42,"body":"annonce"}\n');
    await upsertComment('o/r', 7, MARKER, TAG, 'rapport');
    expect(stdinMock.mock.calls.some(([, args]) => args.includes('PATCH'))).toBe(true);
  });

  it('crée un commentaire quand il n’y en a pas', async () => {
    runMock.mockResolvedValue('');
    await upsertComment('o/r', 7, MARKER, TAG, 'rapport');
    const [, args] = stdinMock.mock.calls[0]!;
    expect(args).toEqual(['pr', 'comment', '7', '--body-file', '-']);
  });

  /** Commentaire supprimé à la main entre-temps : perdre le rapport coûterait plus. */
  it('retombe sur un commentaire neuf quand la réécriture échoue', async () => {
    runMock.mockResolvedValue('{"id":42,"body":"annonce"}\n');
    stdinMock.mockRejectedValueOnce(new Error('404'));
    await upsertComment('o/r', 7, MARKER, TAG, 'rapport');
    const [, args] = stdinMock.mock.calls[1]!;
    expect(args).toEqual(['pr', 'comment', '7', '--body-file', '-']);
  });
});

/**
 * The listing goes through GraphQL (REST has no "does not contain" filter),
 * then one `minimizeComment` mutation per stale id.
 */
describe('replier les anciens rapports', () => {
  it('liste par GraphQL paginé, filtre sur marqueur/tag/isMinimized, puis minimise chaque id trouvé', async () => {
    runMock.mockResolvedValue('gid1\ngid2\n');
    const collapsed = await minimizeOtherReports('o/r', 7, MARKER, TAG);

    const [command, args] = runMock.mock.calls[0]!;
    expect(command).toBe('gh');
    expect(args).toEqual(
      expect.arrayContaining([
        'graphql',
        '--paginate',
        '-F',
        'owner=o',
        '-F',
        'name=r',
        '-F',
        'number=7',
      ]),
    );
    const query = args[args.indexOf('-f') + 1];
    expect(query).toContain('query=query($owner:String!,$name:String!,$number:Int!,$endCursor:String)');
    expect(query).toContain('$endCursor');
    const jqFilter = args.at(-1)!;
    expect(jqFilter).toContain(`startswith("${MARKER}")`);
    expect(jqFilter).toContain(`contains("${TAG}") | not`);
    expect(jqFilter).toContain('.isMinimized == false');

    expect(stdinMock).toHaveBeenCalledTimes(2);
    const [, mutationArgs, mutationInput] = stdinMock.mock.calls[0]!;
    expect(mutationArgs).toEqual(['api', 'graphql', '--input', '-']);
    const parsed = JSON.parse(mutationInput) as { query: string; variables: { id: string } };
    expect(parsed.query).toContain('minimizeComment(input:{subjectId:$id, classifier:OUTDATED})');
    expect(parsed.variables).toEqual({ id: 'gid1' });
    expect(collapsed).toBe(2);
  });

  it('ne minimise rien, et rend 0, quand la liste est vide', async () => {
    runMock.mockResolvedValue('\n');
    expect(await minimizeOtherReports('o/r', 7, MARKER, TAG)).toBe(0);
    expect(stdinMock).not.toHaveBeenCalled();
  });
});

/** Le statut est le seul mécanisme qui fait attendre la review. */
describe('le statut de commit', () => {
  it('POST sur la tête de la PR, contexte et lien compris', async () => {
    await postStatus('o/r', 'abc123', {
      state: 'pending',
      context: 'aristarque/review',
      description: 'review en cours',
      targetUrl: 'https://example.test/run/1',
    });
    const [, args, input] = stdinMock.mock.calls[0]!;
    expect(args).toEqual(['api', '--method', 'POST', 'repos/o/r/statuses/abc123', '--input', '-']);
    expect(JSON.parse(input)).toEqual({
      state: 'pending',
      context: 'aristarque/review',
      description: 'review en cours',
      target_url: 'https://example.test/run/1',
    });
  });

  /** GitHub tronque à 140 ; le faire ici garde la coupe lisible. */
  it('tronque la description à 140 caractères', async () => {
    await postStatus('o/r', 'abc', { state: 'failure', context: 'c', description: 'x'.repeat(200) });
    const body = JSON.parse(stdinMock.mock.calls[0]![2]) as { description: string; target_url?: string };
    expect(body.description).toHaveLength(140);
    // Pas de « target_url » vide : GitHub refuse une URL qui n'en est pas une.
    expect(body.target_url).toBeUndefined();
  });
});
