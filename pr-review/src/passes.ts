/**
 * Les trois passes de review et la fusion qui les rassemble. Module **pur**.
 *
 * Une review tenait auparavant en un seul appel : six axes de recherche, la
 * doctrine du dépôt, les règles de rédaction et le gabarit de sortie, tout ça
 * pendant que le modèle lit quatre-vingt-dix kilo-octets de code. Les axes cités
 * en dernier étaient ceux qu'il honorait le moins. Ici chaque passe n'a qu'un
 * objectif, sans concurrence interne, et voit le même contexte.
 *
 * La fusion arrive après, quand toutes les trouvailles sont sur la table : c'est
 * le seul endroit d'où l'on peut dédupliquer deux formulations d'un même bug et
 * arbitrer entre elles. C'est aussi le seul endroit où le plafond de puces a un
 * sens, sinon trois passes rendraient trois fois le plafond.
 */

import type { PrMeta } from './gh';
import { buildPreamble, type PromptOptions } from './prompt';

/**
 * Le repère qui sépare le raisonnement des trouvailles.
 *
 * Même mécanique que `## Verdict` pour la review finale : le cloud Ollama ignore
 * `format`, donc rien ne contraint la forme côté serveur et le seul repère
 * fiable est celui qu'on impose. Voir `extractReview` dans `render.ts`.
 */
export const PASS_HEADING = '## Trouvailles';

/** Ce qu'une passe doit rendre, identique pour les trois. */
const PASS_OUTPUT = `# What to return

Return \`${PASS_HEADING}\` followed by one bullet per finding, in French, nothing else. No verdict,
no summary, no closing paragraph: another pass writes those.

${PASS_HEADING}
- [bloquant] \`chemin/fichier.ts:42\` : ce qui casse, et ce que ça produit ici.
- [corriger] \`chemin/fichier.tsx:17\` : …
- [suggestion] \`chemin/fichier.ts:88\` : …
- [doute] \`chemin/fichier.ts:120\` : ce que tu soupçonnes sans pouvoir le prouver, et ce qu'il
  faudrait regarder pour trancher.

Labels, one per bullet:

- **bloquant**: breaks production, loses or exposes data, leaks a secret or personal data, or
  introduces a certain functional regression.
- **corriger**: breaks a rule from the doctrine above, or a probable but undemonstrated bug.
- **suggestion**: optional improvement, debt, test blind spot. A finding outside this PR's scope
  goes here, labelled as such, and proposes opening an issue. It never blocks.
- **doute**: what you cannot settle with the files you were given. Say what would settle it.
  A doubt that the context files above DO settle is not a doubt: read them and conclude.

No ceiling on this pass: report everything you found on your axis. Ranking happens later.

Do not recite the rule, say what breaks HERE and what it produces. « Chaîne FR en dur » is
worthless; « ce libellé de bouton est éditorial, il doit vivre dans le contenu sinon il échappe à
l'admin et à la traduction » is worth something.

Never use an em dash. The merge pass is told not to rewrite your wording, so anything you write
here reaches the posted comment as is.

Found nothing? Return \`${PASS_HEADING}\` and a single bullet « - [rien] : » followed by what you
actually checked to be able to say it. Never an empty section.`;

export interface Pass {
  /** Sert au journal du job et au pied de page du commentaire. */
  id: string;
  /** Nom français, affiché quand la passe n'aboutit pas. */
  label: string;
  /**
   * Nom anglais de l'axe, pour le prompt de fusion.
   *
   * Distinct de `label`, qui est français parce qu'il s'affiche : les consignes,
   * elles, sont en anglais de bout en bout. Traduire au vol dans le prompt
   * mélangerait les deux registres au milieu du contexte.
   */
  axis: string;
  objective: string;
}

export const PASSES: readonly Pass[] = [
  {
    id: 'regression',
    label: 'régression fonctionnelle',
    axis: "functional regressions",
    objective: `# Your one job in this pass: functional regressions

You are not looking at conventions, style, or data access. Another pass covers those. You are
looking for code that will misbehave at runtime. Walk these deliberately, on every changed file.
None of them is visible in a diff read line by line, which is exactly why they survive until
production.

1. **The caller's side.** A changed signature, return shape, thrown error or nullability breaks
   whoever calls it. The context files include what the changed files import: use them. When the
   caller is genuinely absent from your context, report a doubt.
2. **Error paths.** What happens when this throws, returns null, times out, or gets an empty
   list? An error caught, logged and swallowed is a silent failure: the feature is dead and
   nobody is told.
3. **Edge inputs.** Empty, zero, one element, duplicates, very large. Boundaries of a loop, a
   slice, a pagination. Off-by-one on both ends.
4. **State and ordering.** Two runs racing, a retry replaying a side effect, a cache or a ledger
   written before the thing it records actually succeeded, a missing await.
5. **What the change forgot.** A rename applied in two places out of three, a new branch with no
   test, a migration with no way back, a flag read but never set.`,
  },
  {
    id: 'doctrine',
    label: 'doctrine du dépôt',
    axis: "the repository's own conventions",
    objective: `# Your one job in this pass: the repository's own rules

Judge this PR against the doctrine quoted above, and against nothing else. Other passes cover
runtime bugs and data access; a remark of yours that does not trace back to a written rule of
this repository does not belong in this pass.

- Go rule by rule through the doctrine, and check the changed files against each one that
  applies. A rule nobody checks is a rule that decays.
- **Quote the rule you are applying**, in a few words, so the author can tell a project rule from
  a personal habit. If you cannot point to the rule, you are inventing it.
- Silence is a claim here too: if the PR respects the doctrine, say which rules you actually
  checked it against.
- Ignore formatting and style that lint and Prettier already settle. A doctrine is what a linter
  cannot enforce.

If this repository ships no doctrine, say so in a single « - [rien] : » bullet and stop. Do not
substitute your own conventions for the ones it did not write.`,
  },
  {
    id: 'data',
    label: 'données et accès',
    axis: "data access",
    objective: `# Your one job in this pass: data, secrets, and access boundaries

Not runtime bugs, not conventions. Who can read what, and what escapes to where.

1. **Role boundaries.** A query that returns rows the caller has no right to see. A filter on
   tenant, owner or role that the change dropped, widened, or moved after the fetch instead of
   into it. An admin path reachable without the check.
2. **Secrets.** A key, token or password reaching a log, an error message, a client bundle, a URL
   or a third party. A secret read from the wrong place, or committed.
3. **Personal data.** An email, a phone number, an address, an IP in a log line, an analytics
   payload, a redirect, or a message to an external service. Ask what the recipient can see.
4. **Trust in inputs.** Data from a request used unvalidated in a query, a path, a redirect, a
   command, or rendered as HTML.
5. **What the endpoint exposes.** A new route, field or serializer that widens what leaves the
   server. Compare with what the previous shape returned.

Prove it from what you were given: a boundary crossing you cannot see in the excerpts is a
« doute », with the file that would settle it named.`,
  },
];

export function buildPassSystemPrompt(pass: Pass, options: PromptOptions): string {
  return `${buildPreamble(options)}

${pass.objective}

${PASS_OUTPUT}`;
}

/**
 * Le gabarit de la review postée.
 *
 * Le cloud Ollama ne prend pas les structured outputs (`format: <schéma>` est
 * ignoré), donc rien ne contraint la forme côté serveur : la seule prise qu'on a
 * est ce gabarit et le post-traitement de `render.ts`, qui doit rester tolérant.
 * D'où un format volontairement plat, sans imbrication à parser.
 *
 * ⚠️ Ces titres sont aussi des repères d'analyse : `render.ts` coupe la réponse
 * à `## Verdict`. Les traduire casserait l'extraction, c'est pourquoi il n'y a
 * pas d'input de langue.
 */
const OUTPUT_TEMPLATE = `## Verdict
Une seule phrase : ce que tu retiens de cette PR.

## Bloquant
- \`chemin/fichier.ts:42\` : ce qui casse, et pourquoi ici.

## À corriger
- \`chemin/fichier.tsx:17\` : …

## Suggestions
- \`chemin/fichier.ts:88\` : …

## À vérifier
- \`chemin/fichier.ts:120\` : ce que tu soupçonnes sans pouvoir le prouver ici, et ce qu'il
  faudrait regarder pour trancher.`;

export interface MergeOptions {
  repo: string;
  maxFindings: number;
  /**
   * Les passes qui ont RÉELLEMENT lu, pas celles qui étaient prévues.
   *
   * Le prompt annonçait trois relecteurs en toutes lettres. Quand une passe
   * échouait, la fusion cherchait un axe qu'on ne lui avait pas donné, ou
   * hédgeait sur son absence : `index.ts` savait laquelle manquait, elle non.
   */
  passes: readonly Pass[];
}

/** Une énumération anglaise : virgules, puis « and » devant le dernier terme. */
function enumerate(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const WORDS = ['no', 'a single', 'two', 'three', 'four', 'five'];

/**
 * L'ouverture du prompt de fusion, accordée au nombre de relecteurs.
 *
 * Un « Three reviewers » écrit en dur devient un mensonge dès qu'une passe
 * échoue ou n'est pas lancée, et un modèle à qui on ment sur son entrée comble
 * le manque plutôt que de le signaler.
 */
function opening(repo: string, passes: readonly Pass[]): string {
  const axes = enumerate(passes.map((pass) => pass.axis));
  if (passes.length === 1) {
    return `One reviewer has just read a pull request on \`${repo}\`, on a single axis: ${axes}.`;
  }
  const word = WORDS[passes.length] ?? String(passes.length);
  return `${word[0]!.toUpperCase()}${word.slice(1)} reviewers have just read the same pull request on \`${repo}\`, each on one axis: ${axes}.`;
}

/**
 * La fusion ne reçoit pas le code.
 *
 * Trois passes l'ont déjà envoyé trois fois ; une quatrième copie n'achèterait
 * rien, parce que le travail qui reste est de trier, pas de relire. En
 * contrepartie il faut le lui dire franchement, sans quoi elle complèterait de
 * mémoire une trouvaille qu'elle trouve trop courte, et inventerait.
 */
export function buildMergeSystemPrompt(options: MergeOptions): string {
  return `${opening(options.repo, options.passes)} You are assembling
their findings into the single comment that gets posted on the PR.

**You do not have the code.** You only have what they wrote. So:

- Never add a finding. If it is not in their lists, it does not exist.
- Never invent a line number, a path, or a detail to make a bullet sound firmer. Keep the
  \`path:line\` they wrote, exactly as they wrote it.
- When a bullet is too vague to be useful, keep it as is or drop it. Do not complete it.

# What to do with their findings

1. **Deduplicate.** Two reviewers describe the same defect in different words: keep one bullet,
   the one that says best what breaks and what it produces. Two defects in the same file are not
   duplicates.
2. **Arbitrate the label.** They each judged on their own axis and could not see the others. A
   « corriger » that turns out to lose data is « Bloquant ». A « bloquant » resting on an
   unverified assumption belongs under « À vérifier ».
3. **Rank, then cut.** ${options.maxFindings} bullets maximum across Bloquant, À corriger and
   Suggestions, plus at most five under À vérifier. Past that nobody reads. Keep the costly ones.
   **When you cut, say so in the Verdict**: this ceiling ranks findings, it never justifies
   dropping one in silence.
4. **Drop the « rien » bullets**, but remember what they checked: that is what makes a
   « Rien à signaler » credible.

# Expected output

Return exactly these five sections, in this order, as markdown, and nothing before them.

${OUTPUT_TEMPLATE}

- A section with nothing in it says what was checked, on the same line:
  « Rien à signaler (chemins d'erreur et valeurs de retour relus) ». Take that from what the
  reviewers said they checked. If they said nothing, write « Rien à signaler ».
- No summary of the PR, no compliments, no closing paragraph. The author wrote it.
- Write in French. Never use an em dash.`;
}

export interface PassFindings {
  pass: Pass;
  findings: string;
}

export function buildMergeUserPrompt(meta: PrMeta, results: PassFindings[]): string {
  const blocks = results
    .map((result) => `## Reviewer: ${result.pass.label}\n\n${result.findings.trim()}`)
    .join('\n\n');

  const fileList = meta.files
    .map((file) => `- ${file.path} (+${file.additions} / -${file.deletions}, ${file.status})`)
    .join('\n');

  return `# PR #${meta.number} — ${meta.title}

## Author's description

${meta.body.trim() || '(empty)'}

## Files changed by this PR

Every finding you keep must be about one of these. A path that is not in this list came from a
context file, which this PR does not touch: drop that finding.

${fileList}

# What the reviewers found

${blocks}`;
}
