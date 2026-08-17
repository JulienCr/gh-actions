/**
 * Mise en forme du commentaire posté sur la PR. Module **pur**.
 */

/** Permet de retrouver le commentaire de la review parmi les autres. */
export const MARKER = '<!-- aristarque -->';

/**
 * Le titre que porte tout commentaire posté, review réussie ou non.
 *
 * Écrit une fois : les trois rendus ci-dessous en portaient chacun leur copie
 * littérale, et trois copies d'un titre finissent par en faire trois. Le nom
 * d'abord, la fonction ensuite, parce qu'« Aristarque » seul ne dit rien à qui
 * croise le bot pour la première fois.
 */
const HEADING = '## Aristarque — review automatique';

/** Première rubrique du gabarit : c'est elle qui sépare la réflexion de la review. */
const FIRST_HEADING = '## Verdict';

/**
 * Plafond de sécurité, en caractères. Un commentaire GitHub plafonne à 65 536 ;
 * bien avant cela, personne ne lit. On garde la FIN, parce que la réflexion
 * précède toujours la conclusion.
 */
const MAX_LENGTH = 12_000;

/**
 * Extrait la review de la réponse brute.
 *
 * Mesuré en production : `glm-5.2:cloud` a rendu 27 490 caractères dont ~2 500
 * de review, le reste étant cinquante étapes de raisonnement numérotées écrites
 * **directement dans `content`**, sans aucune balise. Retirer les
 * `<think>…</think>` ne suffisait donc pas : le seul repère fiable est le
 * gabarit qu'on impose.
 *
 * On coupe à la DERNIÈRE occurrence du titre, pas à la première : le
 * raisonnement cite volontiers le gabarit avant de le remplir. Et la recherche
 * n'est pas ancrée en début de ligne, parce que le modèle a écrit
 * « OK, final review:## Verdict » d'un seul tenant.
 *
 * `heading` est paramétrable parce qu'une passe de review rend `## Trouvailles`
 * et non `## Verdict` : c'est le même raisonnement à couper au même endroit, il
 * n'y avait pas de raison d'en écrire une seconde version.
 */
export function extractReview(content: string, heading: string = FIRST_HEADING): string {
  const withoutTags = content.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '').trim();

  const start = withoutTags.lastIndexOf(heading);
  if (start !== -1) return withoutTags.slice(start).trim();

  // Sans repère, on ne peut pas distinguer la review du reste. Plutôt que de
  // tout poster, on garde la fin en le disant : mieux vaut un extrait annoncé
  // qu'un pavé qui se fait passer pour une review.
  if (withoutTags.length > MAX_LENGTH) {
    return `_Le modèle n'a pas suivi le gabarit. Fin de sa réponse, tronquée :_\n\n${withoutTags.slice(-MAX_LENGTH)}`;
  }
  return withoutTags;
}

export interface LinkifyOptions {
  /** `https://github.com/owner/repo` */
  repoUrl: string;
  headSha: string;
  /** Chemins réellement touchés par la PR. Tout le reste n'est pas lié. */
  knownPaths: Set<string>;
}

/**
 * Transforme les `chemin:ligne` en liens vers le code.
 *
 * Seuls les chemins réellement présents dans la PR sont liés : un modèle qui
 * invente un chemin ne doit pas hériter d'un lien d'apparence valide, qui lui
 * donnerait une crédibilité qu'il n'a pas. Le texte reste, seul le lien manque.
 *
 * Les blocs de code clôturés sont laissés intacts : y injecter du markdown
 * casserait un extrait que la review propose peut-être de copier.
 */
export function linkifyPaths(markdown: string, options: LinkifyOptions): string {
  return mapOutsideFences(markdown, (segment) =>
    segment.replace(/`([^`\n]+)`/g, (match, inner: string) => {
      const parsed = /^(.+?)(?::(\d+))?$/.exec(inner.trim());
      const path = parsed?.[1];
      const line = parsed?.[2];
      if (!path || !options.knownPaths.has(path)) return match;
      const anchor = line ? `#L${line}` : '';
      return `[${match}](${options.repoUrl}/blob/${options.headSha}/${path}${anchor})`;
    }),
  );
}

/** Applique une transformation hors des blocs ``` … ```. */
function mapOutsideFences(markdown: string, transform: (segment: string) => string): string {
  // La fermeture tolère une espace de fin : sans cela un bloc mal clos n'est pas
  // reconnu, et on injecterait des liens markdown au milieu d'un extrait de code.
  const parts = markdown.split(/(^```[\s\S]*?^```[ \t]*$)/gm);
  return parts.map((part) => (part.startsWith('```') ? part : transform(part))).join('');
}

export interface Footer {
  model: string;
  durationMs: number;
  promptTokens: number;
  evalTokens: number;
  /**
   * Taille du raisonnement, en caractères.
   *
   * Affiché parce que c'est la seule façon, depuis la PR, de voir si le modèle a
   * creusé ou expédié : une review courte après 40 Ko de raisonnement et la même
   * review après 2 Ko ne se corrigent pas de la même manière. Vaut 0 quand le
   * modèle mêle son raisonnement à sa réponse, et la ligne disparaît alors.
   */
  thinkingChars: number;
  /** Fichiers écartés d'office (générés, binaires, lockfiles). */
  skipped: string[];
  /** Fichiers dont seul le diff a été envoyé, faute de place. */
  omitted: string[];
  /**
   * Nombre de fichiers joints parce qu'un fichier touché les importe.
   *
   * Annoncé au même titre qu'une troncature : une review qui a vu plus que la PR
   * doit le dire, sans quoi le lecteur ne comprend pas d'où sort une affirmation
   * sur un fichier absent du diff.
   */
  imported: number;
  /** Passes qui n'ont pas abouti. Une review partielle doit se déclarer. */
  failedPasses: string[];
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

const count = (value: number) => value.toLocaleString('fr-FR');

function renderFooter(footer: Footer): string {
  const bits = [
    `${footer.model} via Ollama Cloud`,
    formatDuration(footer.durationMs),
    `${count(footer.promptTokens)} tokens en entrée, ${count(footer.evalTokens)} en sortie`,
  ];
  if (footer.thinkingChars > 0) {
    bits.push(`${count(Math.round(footer.thinkingChars / 1024))} Ko de raisonnement`);
  }
  if (footer.imported > 0) {
    bits.push(`${footer.imported} fichier(s) importés joints en contexte`);
  }
  if (footer.skipped.length > 0) {
    bits.push(`${footer.skipped.length} fichier(s) générés ignorés`);
  }
  if (footer.omitted.length > 0) {
    // Dit explicitement : une review partielle ne doit pas se lire comme une review complète.
    bits.push(`diff seul (sans contexte complet) pour ${footer.omitted.join(', ')}`);
  }
  if (footer.failedPasses.length > 0) {
    const quoted = footer.failedPasses.map((pass) => `« ${pass} »`);
    const plural = quoted.length > 1 ? 's' : '';
    bits.push(`⚠ passe${plural} ${enumerate(quoted)} non aboutie${plural}`);
  }
  return `<sub>${bits.join(' · ')}</sub>`;
}

/** Une énumération française : virgules, puis « et » devant le dernier terme. */
function enumerate(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} et ${items[items.length - 1]}`;
}

export interface CommentInput extends LinkifyOptions {
  review: string;
  footer: Footer;
}

export function renderComment(input: CommentInput): string {
  const body = linkifyPaths(extractReview(input.review), input);
  return `${MARKER}
${HEADING}

${body}

---

${renderFooter(input.footer)}`;
}

export interface PartialCommentInput extends LinkifyOptions {
  /** Les trouvailles brutes, une entrée par passe qui a abouti. */
  passes: { label: string; findings: string }[];
  reason: string;
  footer: Footer;
}

/**
 * Commentaire posté quand les passes ont abouti mais pas leur fusion.
 *
 * Trois lectures déjà payées ne sont pas jetées parce que le tri a échoué : on
 * les rend telles quelles, en disant qu'elles n'ont été ni dédupliquées ni
 * classées. C'est moins lisible qu'une review, et c'est très au-dessus du
 * silence, que ce programme refuse (cf. l'en-tête de `index.ts`).
 */
export function renderPartialComment(input: PartialCommentInput): string {
  const blocks = input.passes
    .map((pass) => `### ${pass.label}\n\n${linkifyPaths(pass.findings.trim(), input)}`)
    .join('\n\n');

  return `${MARKER}
${HEADING}

_La synthèse n'a pas pu être produite (${input.reason}). Voici les trouvailles brutes des passes qui
ont abouti : ni triées, ni dédupliquées, ni plafonnées._

${blocks}

---

${renderFooter(input.footer)}`;
}

/**
 * Commentaire posté quand la review n'a pas pu tourner.
 *
 * On préfère un échec visible à un silence : sans ce commentaire, une PR sans
 * review est indiscernable d'une PR jugée irréprochable.
 */
export function renderFailureComment(reason: string, model: string): string {
  return `${MARKER}
${HEADING}

La review n'a pas pu être produite : ${reason}

<sub>Modèle visé : ${model}. Le check reste vert, cette review n'est pas bloquante.</sub>`;
}
