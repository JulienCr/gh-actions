import { describe, expect, it } from 'vitest';

import { statusOf } from '../src/gh';

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
