import { describe, it, expect } from 'vitest';
import {
  isPendingComment,
  MARKER,
  renderAbortedComment,
  renderPendingComment,
  extractReview,
  linkifyPaths,
  renderComment,
  renderFailureComment,
  renderPartialComment,
  type Footer,
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

const FOOTER: Footer = {
  models: 'ollama/glm-5.2:cloud (régression fonctionnelle)',
  durationMs: 134_000,
  inputTokens: 84_312,
  cachedInputTokens: 0,
  outputTokens: 1204,
  costUsd: 0,
  costPartial: false,
  thinkingChars: 0,
  skipped: [],
  omitted: [],
  imported: 0,
  failedPasses: [],
  skippedPasses: [],
  windowed: [],
  effort: 'balanced',
  importsWithheld: [],
};

describe('renderComment', () => {
  it('porte le marqueur, le titre et le pied de page', () => {
    const comment = renderComment({ ...OPTIONS, review: '## Verdict\nok', footer: FOOTER });
    expect(comment.startsWith(MARKER)).toBe(true);
    expect(comment).toContain('## Aristarque — review automatique');
    expect(comment).toContain('ollama/glm-5.2:cloud (régression fonctionnelle)');
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

  it('accorde au pluriel quand deux passes manquent, et énumère à la française', () => {
    const comment = renderComment({
      ...OPTIONS,
      review: 'ok',
      footer: { ...FOOTER, failedPasses: ['doctrine du dépôt', 'données et accès'] },
    });
    expect(comment).toContain('⚠ passes « doctrine du dépôt » et « données et accès » non abouties');
  });

  it('sépare par des virgules au-delà de deux, plutôt que d’enchaîner les « et »', () => {
    const comment = renderComment({
      ...OPTIONS,
      review: 'ok',
      footer: { ...FOOTER, failedPasses: ['a', 'b', 'c'] },
    });
    expect(comment).toContain('⚠ passes « a », « b » et « c » non abouties');
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
    expect(comment).toContain('## Aristarque — review automatique');
    expect(comment).toContain("Ollama n'a pas répondu en 15 min");
    expect(comment).toContain('### régression fonctionnelle');
    expect(comment).toContain('### données et accès');
  });

  it('dit que ce n’est pas une review : ni triée, ni dédupliquée', () => {
    expect(comment).toContain('ni triées, ni dédupliquées, ni plafonnées');
  });

  it('pose quand même les liens et le pied de page', () => {
    expect(comment).toContain('/blob/abc123/src/lib/content.ts#L9');
    expect(comment).toContain('ollama/glm-5.2:cloud (régression fonctionnelle)');
    expect(comment).toContain('⚠ passe « doctrine du dépôt » non aboutie');
  });
});

describe('renderFailureComment', () => {
  it('dit pourquoi la review manque, plutôt que de rester muet', () => {
    const comment = renderFailureComment('HTTP 429 (quota atteint)', 'glm-5.2:cloud');
    expect(comment.startsWith(MARKER)).toBe(true);
    expect(comment).toContain('## Aristarque — review automatique');
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


describe('le pied de page distingue la décision de l’incident', () => {
  const footer = (over: Partial<Footer>) =>
    renderComment({ ...OPTIONS, review: '## Verdict\nok', footer: { ...FOOTER, ...over } });

  it('dit sans avertissement qu’une passe n’a pas été lancée, et pourquoi', () => {
    const comment = footer({
      skippedPasses: [{ label: 'régression fonctionnelle', reason: 'aucun fichier exécutable dans cette PR' }],
    });
    expect(comment).toContain('passe « régression fonctionnelle » non lancée (aucun fichier exécutable');
    expect(comment).not.toContain('⚠ passe');
  });

  /** Une passe qui échoue est un incident : elle garde son avertissement. */
  it('garde l’avertissement pour une passe lancée qui n’a pas abouti', () => {
    expect(footer({ failedPasses: ['données et accès'] })).toContain('⚠ passe');
  });
});


describe('le pied de page déclare ce que le cran a retiré', () => {
  const footer = (over: Partial<Footer>) =>
    renderComment({ ...OPTIONS, review: '## Verdict\nok', footer: { ...FOOTER, ...over } });

  it('nomme le cran, qui commande tout le reste', () => {
    expect(footer({ effort: 'lean' })).toContain('effort lean');
  });

  /**
   * Sans cette ligne, trois passes paraissent avoir jugé sur le même contexte
   * alors que l'une d'elles n'avait pas les appelants sous les yeux.
   */
  it('dit à quelles passes les imports n’ont pas été joints', () => {
    const comment = footer({ imported: 21, importsWithheld: ['doctrine du dépôt'] });
    expect(comment).toContain('21 fichier(s) importés joints en contexte (hors « doctrine du dépôt »)');
  });

  it('ne dit rien de tel quand les trois passes les ont eus', () => {
    const comment = footer({ imported: 21 });
    expect(comment).toContain('21 fichier(s) importés joints en contexte');
    expect(comment).not.toContain('hors «');
  });
});

describe('le pied de page rapporte le cache et le coût', () => {
  const footer = (over: Partial<Footer>) =>
    renderComment({ ...OPTIONS, review: '## Verdict\nok', footer: { ...FOOTER, ...over } });

  /** La seule mesure du levier : sans elle, un préfixe qui a divergé ne se voit pas. */
  it('dit la part d’entrée servie par le cache', () => {
    expect(footer({ cachedInputTokens: 141_694 })).toContain(
      `dont ${(141_694).toLocaleString('fr-FR')} en cache`,
    );
  });

  it('tait le cache quand il n’y en a pas eu', () => {
    expect(footer({ cachedInputTokens: 0 })).not.toContain('en cache');
  });

  /**
   * Un quota Ollama consommé n'est pas un appel gratuit : annoncer « ~ » sur un
   * total dont une part n'est pas chiffrable sous-estimerait la review de tout
   * son plus gros appel.
   */
  it('dit « au moins » quand une part du total n’a pas de tarif connu', () => {
    expect(footer({ costUsd: 0.0697, costPartial: true })).toContain('au moins 0,0697 $');
    expect(footer({ costUsd: 0.0697, costPartial: false })).toContain('~0,0697 $');
  });

  it('tait le coût quand rien n’est chiffrable', () => {
    expect(footer({ costUsd: 0 })).not.toContain('$');
  });

  /** Un arrondi à zéro se lit comme une mesure : mieux vaut le silence. */
  it('n’annonce pas « 0 Ko de raisonnement »', () => {
    expect(footer({ thinkingChars: 19 })).not.toContain('Ko de raisonnement');
    expect(footer({ thinkingChars: 40_960 })).toContain('40 Ko de raisonnement');
  });
});

/**
 * L'annonce et le rapport partagent le marqueur, et c'est tout l'intérêt : le
 * second remplace la première en place, si bien qu'une PR ne porte jamais deux
 * commentaires d'Aristarque.
 */
describe('l’annonce et l’interruption', () => {
  it('porte le marqueur, les passes prévues et le lien du run', () => {
    const comment = renderPendingComment({
      passes: ['régression fonctionnelle', 'doctrine du dépôt'],
      runUrl: 'https://example.test/run/1',
    });
    expect(comment.startsWith(MARKER)).toBe(true);
    expect(comment).toContain('Review en cours');
    expect(comment).toContain('- régression fonctionnelle');
    expect(comment).toContain('https://example.test/run/1');
  });

  /** En local il n'y a pas de run : l'annonce s'en passe plutôt que de mentir. */
  it('se passe du lien quand il n’y en a pas', () => {
    const comment = renderPendingComment({ passes: ['doctrine du dépôt'] });
    expect(comment).not.toContain('Suivre le run');
  });

  /** Sans elle, un run tué laisserait un « en cours » qui ne finit jamais. */
  it('dit qu’une review interrompue n’a pas relu la PR', () => {
    const comment = renderAbortedComment('https://example.test/run/2');
    expect(comment.startsWith(MARKER)).toBe(true);
    expect(comment).toContain('interrompue');
    expect(comment).toContain("n'a pas été relue");
    expect(comment).toContain('@aristarque review');
  });
});

/**
 * Le nettoyage d'un run tué doit savoir ce qu'il écrase. Un job annulé dans les
 * secondes qui suivent la pose du rapport ferait sinon disparaître une review
 * qui a abouti, sous un « interrompue » faux.
 */
describe('reconnaître une annonce', () => {
  it('distingue l’annonce du rapport et de l’échec', () => {
    expect(isPendingComment(renderPendingComment({ passes: ['doctrine du dépôt'] }))).toBe(true);
    expect(isPendingComment(renderFailureComment('quota épuisé', 'glm-5.2:cloud'))).toBe(false);
    expect(isPendingComment(renderAbortedComment())).toBe(false);
  });
});
