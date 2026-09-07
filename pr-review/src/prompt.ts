/**
 * Ce que toutes les passes de review partagent. Module **pur**.
 *
 * La doctrine de review n'est pas écrite ici : elle est lue dans les fichiers
 * que le dépôt désigne par l'input `doctrine`, et injectée. Une seule source de
 * vérité, partagée avec les autres relecteurs qui lisent déjà ces fichiers
 * (Copilot lit `.github/copilot-instructions.md`, Claude Code lit `CLAUDE.md`).
 * Toute règle recopiée ici finirait par diverger.
 *
 * Les consignes sont en anglais, comme la plupart des fichiers de doctrine
 * qu'elles encadrent : un prompt bilingue force le modèle à basculer de registre
 * au milieu du contexte. Seul le rendu attendu reste en français, puisque c'est
 * la langue du commentaire posté.
 *
 * Le socle défini ici est envoyé à chacune des passes de `passes.ts`, qui n'y
 * ajoutent que leur objectif. Ce qui est commun est écrit une fois : trois
 * copies d'une règle de citation dériveraient en trois règles différentes.
 */

import type { AssembledContext } from './context';
import type { PrMeta } from './gh';

export interface DoctrineFile {
  path: string;
  content: string;
}

export interface PromptOptions {
  /** `owner/repo`, pour situer le modèle. */
  repo: string;
  /** Cadrage libre, quand la doctrine du dépôt n'en donne pas. Souvent vide. */
  projectSummary: string;
  doctrine: DoctrineFile[];
}

function renderDoctrine(files: DoctrineFile[]): string {
  if (files.length === 0) {
    // Le dire au modèle plutôt que lui laisser croire qu'il a tout : sans
    // doctrine, il ne peut juger que sur des critères génériques, et une remarque
    // présentée comme une règle du dépôt serait inventée.
    return `This repository ships no review doctrine. Judge on general engineering grounds only, and
never present a remark as if it came from a project rule.`;
  }

  const blocks = files
    .map((file) => `<doctrine path="${file.path}">\n${file.content}\n</doctrine>`)
    .join('\n\n');

  return `Here are the repository's own conventions, as written by its maintainer. They are
authoritative, and they outrank your general habits.

${blocks}`;
}

/**
 * L'en-tête commun à toutes les passes : qui tu es, quel dépôt, quelles règles.
 *
 * La doctrine est donnée à **toutes** les passes, pas seulement à celle qui la
 * juge : une passe qui ne l'aurait pas signalerait comme défaut ce que le dépôt
 * impose. Quelques kilo-octets de conventions en face de quatre-vingt-dix de
 * code ne coûtent rien ; un faux positif sur une règle maison coûte la confiance
 * dans toute la review.
 */
export function buildPreamble(options: PromptOptions): string {
  const summary = options.projectSummary.trim();

  return `You are reviewing a pull request on the \`${options.repo}\` repository.
${summary ? `\n${summary}\n` : ''}
You run when the PR is opened, before any human reads it. Your job is to catch what a generic
linter cannot see: this project's own rules, functional regressions, and data leaks.

${renderDoctrine(options.doctrine)}

# How hard to look

Your job is coverage, not curation. A finding you swallowed because you were not sure enough
is a bug that ships. Report what you find and let its label carry your confidence: a doubt is
reported as a doubt, never dropped.

- **Read every excerpt you were given in full**, not only the changed lines. The diff says what
  moved; the code around it says what that broke. A reviewer who only reads « + » lines finds
  only typos.
- **Do not soften a finding into silence.** When something looks wrong but you cannot prove it
  from what you were given, say what you saw, what you suspect, and which file would settle it.
- **Finding nothing is a claim, not a default.** If this pass turns up nothing, say what you
  checked in order to say it. If you cannot name what you checked, you have not checked.

# Citing code

- Every finding starts with a \`path:line\` in backticks, path relative to the repository root.
- A line number is read, never estimated. Only cite numbers visible in the numbered excerpts you
  were given. When a file comes as diff only, cite the path with no line number.
- **Never state what a file contains unless that file was included in your context**, not even
  to support a comparison. If your point depends on a file you were not given, say so.

# Two habits that ruin a review

Both are confabulation: a plausible sentence you did not verify. One wrong detail makes the
reader doubt the whole finding, and a true finding dies with its invented supporting evidence.

1. **Padding a line list.** You read one occurrence, then list neighbours you assume are alike.

   WRONG — « le fichier dit encore « page 2 » (lignes 10, 28, 52, 384) »
   RIGHT — « le fichier dit encore « page 2 », par exemple ligne 10, et probablement ailleurs »

   Cite exactly one line number per finding: the one you actually read. Say the rest in words.

2. **Inventing the contrast.** A rename in this PR does not tell you what any other file says
   now. Do not complete the story.

   WRONG — « alors que template.md dit désormais « partie 2 » »
   RIGHT — « à confronter au vocabulaire retenu ailleurs, que je n'ai pas sous les yeux »

   Assert a file's contents only by quoting a string you can see in one of its excerpts.`;
}

/**
 * Le contexte envoyé à une passe : la PR, son diff, ses fichiers, ses imports.
 *
 * ⚠️ **Ce texte est le préfixe partagé entre les passes**, et le cache de
 * préfixe des providers exige une égalité octet pour octet. Deux règles en
 * découlent, et elles ne sont pas cosmétiques :
 *
 * 1. Aucune phrase du bloc commun ne se formule différemment selon ce que la
 *    passe reçoit. La consigne sur les fichiers absents disait autrefois
 *    « from this section » ou « from this section and from the next one »
 *    selon qu'il y avait des imports : une variante à cet endroit fait
 *    diverger le prompt bien avant les quatre-vingt-dix kilo-octets qu'on
 *    cherchait à réutiliser.
 * 2. Les fichiers importés se rendent en DERNIER, pour que le prompt d'une
 *    passe qui ne les reçoit pas soit un préfixe **strict** de celui d'une
 *    passe qui les reçoit. C'est ce qui rend le cran « balanced » compatible
 *    avec le cache. Voir `groupByDestination` dans `passes.ts`.
 */
export function buildUserPrompt(meta: PrMeta, context: AssembledContext): string {
  const fileList = meta.files
    .map((file) => {
      const flag = context.skipped.includes(file.path) ? ' (not reviewed)' : '';
      return `- ${file.path} (+${file.additions} / -${file.deletions}, ${file.status})${flag}`;
    })
    .join('\n');

  const contents =
    context.files.length > 0
      ? context.files.map(renderFile).join('\n\n')
      : '(no full content available, work from the diff alone)';

  const omitted =
    context.omitted.length > 0
      ? `\n\nNo full content for these files, for lack of room. You only have their diff, so cite them without a line number:\n${context.omitted
          .map((path) => `- ${path}`)
          .join('\n')}`
      : '';

  return `# PR #${meta.number} — ${meta.title}

Base branch: ${meta.baseRefName}

## Author's description

${meta.body.trim() || '(empty)'}

## Changed files

${fileList}${omitted}

## Diff

\`\`\`diff
${context.diff}
\`\`\`

## Full content of the changed files, after the change

Lines are numbered. That number is the one you cite in \`path:line\`. Any file absent from the
sections below was not given to you: do not describe its contents.
${renderGaps(context.windowed.length > 0)}
${contents}${renderImported(context.imported)}`;
}

const renderFile = (file: { path: string; numbered: string; windowed?: boolean }) => {
  // Redit sur le titre ce que la bannière dit dans le corps : un modèle qui
  // traverse quatre-vingt-dix kilo-octets oublie une consigne lue plus haut.
  const note = file.windowed ? ' (excerpt: the lines around the changes only)' : '';
  return `### ${file.path}${note}\n\n\`\`\`\n${file.numbered}\n\`\`\``;
};

/**
 * Ce qu'est un trou, et ce qu'on n'a pas le droit d'en conclure.
 *
 * La consigne la plus importante du fenêtrage. Sans elle, « je ne vois pas le
 * filtre sur le tenant » devient une trouvaille alors que le filtre est
 * peut-être dans le trou : on troque des tokens contre des faux positifs, ce
 * qui coûte bien plus cher que ce qu'on économise.
 */
function renderGaps(hasWindows: boolean): string {
  if (!hasWindows) return '';

  return `
Large files are given as excerpts around the changed lines, not in full. A line reading

    ==== lines 43-317 of this file were NOT given to you (275 lines) ====

means those 275 lines exist in the file and were withheld from you. It does not mean the file
stops there, and it does not mean the code you expected there is missing.

**Never conclude from a gap.** « I do not see the tenant filter » is not a finding when the filter
could be sitting in a gap: it is a « doute », and you name the gap that would settle it. What you
may conclude from a gap is nothing at all.
`;
}

/**
 * Les fichiers importés, dans une section à part et étiquetée comme telle.
 *
 * Ce n'est pas cosmétique. Sans la distinction, le modèle relève des défauts
 * dans du code que la PR ne touche pas, ce qui est le plus sûr moyen de rendre
 * une review inutilisable : l'auteur n'a rien à en faire, et les vraies
 * trouvailles se noient. La consigne doit dire à quoi ces fichiers servent,
 * c'est-à-dire à trancher, et pas à être jugés.
 */
function renderImported(files: { path: string; numbered: string }[]): string {
  if (files.length === 0) return '';

  return `

## Context files, NOT modified by this PR

These are here so you can settle a question instead of asking it: what a caller expects, what an
enum actually contains, whether a helper counts characters or bytes. Same numbering, and you may
cite them as evidence.

**Do not review them.** Every finding must be about a changed file listed above. A defect that
lives only in one of these files is out of scope: this PR did not introduce it, and its author
did not ask. Use them to prove or to kill a doubt about the change itself.

${files.map(renderFile).join('\n\n')}`;
}
