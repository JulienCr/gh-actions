import { describe, it, expect } from 'vitest';
import {
  MARKER,
  extractReview,
  linkifyPaths,
  renderComment,
  renderFailureComment,
  renderPartialComment,
} from '../src/render';

const OPTIONS = {
  repoUrl: 'https://github.com/JulienCr/ascory-website',
  headSha: 'abc123',
  knownPaths: new Set(['src/app/page.tsx', 'src/lib/content.ts']),
};

describe('extractReview', () => {
  it('retire un bloc de réflexion balisé', () => {
    expect(extractReview('<think>bla bla</think>\n## Verdict\nok')).toBe('## Verdict\nok');
  });

  it('laisse passer une réponse déjà propre', () => {
    expect(extractReview('## Verdict\nrien')).toBe('## Verdict\nrien');
  });

  /**
   * Le cas réellement rencontré en production sur la PR #158 : 27 490 caractères
   * de raisonnement non balisé, et le titre collé à la phrase qui le précède.
   */
  it('coupe le raisonnement non balisé collé au titre', () => {
    const raw = "1. Analysons le diff.\n2. Rien de bloquant.\nOK, final review:## Verdict\nSolide.\n\n## Bloquant\nRien.";
    expect(extractReview(raw)).toBe('## Verdict\nSolide.\n\n## Bloquant\nRien.');
  });

  it('coupe à la DERNIÈRE occurrence : le raisonnement cite le gabarit avant de le remplir', () => {
    const raw = 'Je dois produire ## Verdict puis Bloquant.\n\n## Verdict\nLa vraie.';
    expect(extractReview(raw)).toBe('## Verdict\nLa vraie.');
  });

  it('coupe au titre d’une passe, qui ne rend pas le gabarit final', () => {
    const raw = "Voyons les appelants.\n## Trouvailles\n- [doute] `src/a.ts:3` : à confirmer.";
    expect(extractReview(raw, '## Trouvailles')).toBe(
      '## Trouvailles\n- [doute] `src/a.ts:3` : à confirmer.',
    );
  });

  it('annonce la troncature quand le gabarit est absent, plutôt que de poster un pavé', () => {
    const out = extractReview('x'.repeat(20_000));
    expect(out).toContain("n'a pas suivi le gabarit");
    expect(out.length).toBeLessThan(13_000);
  });

  it('rend tel quel un hors-gabarit assez court pour être lu', () => {
    expect(extractReview('Je ne peux pas relire ce diff.')).toBe('Je ne peux pas relire ce diff.');
  });
});

describe('linkifyPaths', () => {
  it('lie un chemin connu avec son numéro de ligne', () => {
    expect(linkifyPaths('- `src/app/page.tsx:42` : souci', OPTIONS)).toBe(
      '- [`src/app/page.tsx:42`](https://github.com/JulienCr/ascory-website/blob/abc123/src/app/page.tsx#L42) : souci',
    );
  });

  it('lie un chemin connu sans numéro de ligne', () => {
    expect(linkifyPaths('`src/lib/content.ts`', OPTIONS)).toBe(
      '[`src/lib/content.ts`](https://github.com/JulienCr/ascory-website/blob/abc123/src/lib/content.ts)',
    );
  });

  it('laisse tel quel un chemin absent de la PR, pour ne pas crédibiliser une invention', () => {
    expect(linkifyPaths('`src/lib/inexistant.ts:3`', OPTIONS)).toBe('`src/lib/inexistant.ts:3`');
  });

  it('laisse tel quel un code inline qui n’est pas un chemin', () => {
    expect(linkifyPaths('utilise `getContent()`', OPTIONS)).toBe('utilise `getContent()`');
  });

  it('ne touche pas au contenu des blocs de code', () => {
    const markdown = '```ts\n// `src/app/page.tsx:1`\n```';
    expect(linkifyPaths(markdown, OPTIONS)).toBe(markdown);
  });
});

const FOOTER = {
  model: 'glm-5.2:cloud',
  durationMs: 134_000,
  promptTokens: 84_312,
  evalTokens: 1204,
  thinkingChars: 0,
  skipped: [],
  omitted: [],
  imported: 0,
  failedPasses: [],
};

describe('renderComment', () => {
  it('porte le marqueur, le titre et le pied de page', () => {
    const comment = renderComment({ ...OPTIONS, review: '## Verdict\nok', footer: FOOTER });
    expect(comment.startsWith(MARKER)).toBe(true);
    expect(comment).toContain('## Review automatique');
    expect(comment).toContain('glm-5.2:cloud via Ollama Cloud');
    expect(comment).toContain('2 min 14 s');
  });

  it('affiche la taille du raisonnement, seul indice qu’une review courte a été creusée', () => {
    const comment = renderComment({
      ...OPTIONS,
      review: '## Verdict\nok',
      footer: { ...FOOTER, thinkingChars: 40_960 },
    });
    expect(comment).toContain('40 Ko de raisonnement');
  });

  it('tait la ligne de raisonnement quand le modèle n’en rend pas à part', () => {
    const comment = renderComment({ ...OPTIONS, review: '## Verdict\nok', footer: FOOTER });
    expect(comment).not.toContain('de raisonnement');
  });

  it('annonce une review partielle plutôt que de la laisser passer pour complète', () => {
    const comment = renderComment({
      ...OPTIONS,
      review: 'ok',
      footer: { ...FOOTER, skipped: ['pnpm-lock.yaml'], omitted: ['src/gros.ts'] },
    });
    expect(comment).toContain('1 fichier(s) générés ignorés');
    expect(comment).toContain('diff seul (sans contexte complet) pour src/gros.ts');
  });

  it('annonce le contexte lu au-delà de la PR, qu’une review honnête doit déclarer', () => {
    const comment = renderComment({ ...OPTIONS, review: 'ok', footer: { ...FOOTER, imported: 7 } });
    expect(comment).toContain('7 fichier(s) importés joints en contexte');
  });

  it('dit quelle passe manque, plutôt que de rendre deux tiers de review sans le dire', () => {
    const comment = renderComment({
      ...OPTIONS,
      review: 'ok',
      footer: { ...FOOTER, failedPasses: ['données et accès'] },
    });
    expect(comment).toContain('⚠ passe « données et accès » non aboutie');
  });

  it('nettoie la réflexion et pose les liens en une passe', () => {
    const comment = renderComment({
      ...OPTIONS,
      review: '<think>hmm</think>- `src/lib/content.ts:9` : souci',
      footer: FOOTER,
    });
    expect(comment).not.toContain('hmm');
    expect(comment).toContain('/blob/abc123/src/lib/content.ts#L9');
  });
});

describe('renderPartialComment', () => {
  const comment = renderPartialComment({
    ...OPTIONS,
    reason: "Ollama n'a pas répondu en 15 min",
    passes: [
      { label: 'régression fonctionnelle', findings: '- `src/lib/content.ts:9` : souci' },
      { label: 'données et accès', findings: '- [rien] : requêtes relues.' },
    ],
    footer: { ...FOOTER, failedPasses: ['doctrine du dépôt'] },
  });

  it('rend les trouvailles déjà payées plutôt que de les jeter avec la fusion', () => {
    expect(comment.startsWith(MARKER)).toBe(true);
    expect(comment).toContain("Ollama n'a pas répondu en 15 min");
    expect(comment).toContain('### régression fonctionnelle');
    expect(comment).toContain('### données et accès');
  });

  it('dit que ce n’est pas une review : ni triée, ni dédupliquée', () => {
    expect(comment).toContain('ni triées, ni dédupliquées, ni plafonnées');
  });

  it('pose quand même les liens et le pied de page', () => {
    expect(comment).toContain('/blob/abc123/src/lib/content.ts#L9');
    expect(comment).toContain('glm-5.2:cloud via Ollama Cloud');
    expect(comment).toContain('⚠ passe « doctrine du dépôt » non aboutie');
  });
});

describe('renderFailureComment', () => {
  it('dit pourquoi la review manque, plutôt que de rester muet', () => {
    const comment = renderFailureComment('HTTP 429 (quota atteint)', 'glm-5.2:cloud');
    expect(comment.startsWith(MARKER)).toBe(true);
    expect(comment).toContain('HTTP 429');
    expect(comment).toContain("n'est pas bloquante");
  });
});

describe('linkifyPaths · blocs de code mal clos', () => {
  it('respecte un bloc dont la fermeture porte une espace de fin', () => {
    const markdown = '```ts\n// `src/app/page.tsx:1`\n``` ';
    expect(linkifyPaths(markdown, OPTIONS)).toBe(markdown);
  });
});
