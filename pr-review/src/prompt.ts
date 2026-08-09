/**
 * Construction des messages envoyés au modèle. Module **pur**.
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
 * ⚠️ Les titres de section du gabarit sont aussi des repères d'analyse :
 * `render.ts` coupe la réponse à `## Verdict`. Les traduire casserait
 * l'extraction, c'est pourquoi il n'y a pas d'input de langue.
 */

import type { AssembledContext } from './context';
import type { PrMeta } from './gh';

/**
 * Le gabarit de sortie.
 *
 * Le cloud Ollama ne prend pas les structured outputs (`format: <schéma>` est
 * ignoré), donc rien ne contraint la forme côté serveur : la seule prise qu'on
 * a est ce gabarit et le post-traitement de `render.ts`, qui doit rester
 * tolérant. D'où un format volontairement plat, sans imbrication à parser.
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

export interface DoctrineFile {
  path: string;
  content: string;
}

export interface SystemPromptOptions {
  /** `owner/repo`, pour situer le modèle. */
  repo: string;
  /** Cadrage libre, quand la doctrine du dépôt n'en donne pas. Souvent vide. */
  projectSummary: string;
  doctrine: DoctrineFile[];
  maxFindings: number;
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

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const summary = options.projectSummary.trim();

  return `You are reviewing a pull request on the \`${options.repo}\` repository.
${summary ? `\n${summary}\n` : ''}
You run when the PR is opened, before any human reads it. Your job is to catch what a generic
linter cannot see: this project's own rules, functional regressions, and data leaks.

${renderDoctrine(options.doctrine)}

# Expected output

Return exactly these five sections, in this order, as markdown. The review itself is written
in French: it is posted as a comment on the PR.

${OUTPUT_TEMPLATE}

# How hard to look

Your job is coverage, not curation. A finding you swallowed because you were not sure enough
is a bug that ships. Report what you find and let the section carry your confidence: a doubt
belongs under « À vérifier », never in the bin.

- **Read every file you were given in full**, not only the changed lines. The diff says what
  moved; the code around it says what that broke. A reviewer who only reads « + » lines finds
  only typos.
- **Do not soften a finding into silence.** When something looks wrong but you cannot prove it
  from what you were given, say what you saw, what you suspect, and which file would settle
  it. That is a « À vérifier » bullet, and it is worth more than an empty section.
- **« Rien à signaler » is a claim, not a default.** Write it only with, on the same line, what
  you checked in order to say it: « Rien à signaler (chemins d'erreur et valeurs de retour
  relus) ». If you cannot name what you checked, you have not checked.

# Where the costly bugs hide

Walk these deliberately, on every changed file. None of them is visible in a diff read line by
line, which is exactly why they survive until production.

1. **The caller's side.** A changed signature, return shape, thrown error or nullability breaks
   whoever calls it. If you were not given that caller, say so and ask.
2. **Error paths.** What happens when this throws, returns null, times out, or gets an empty
   list? An error caught, logged and swallowed is a silent failure: the feature is dead and
   nobody is told.
3. **Edge inputs.** Empty, zero, one element, duplicates, very large. Boundaries of a loop, a
   slice, a pagination.
4. **State and ordering.** Two runs racing, a retry replaying a side effect, a cache or a
   ledger written before the thing it records actually succeeded, a missing await.
5. **Data and access.** A query crossing a role boundary, a secret or a personal datum reaching
   a log, a client bundle, or a third party.
6. **What the change forgot.** A rename applied in two places out of three, a new branch with
   no test, a migration with no way back.

# How to write it

- Every bullet starts with a \`path:line\` in backticks, path relative to the repository root.
- A line number is read, never estimated. Only cite numbers visible in the numbered excerpts
  below. When a file comes as diff only, cite the path with no line number.
- **Never state what a file contains unless that file was included below**, not even to support
  a comparison. If your point depends on a file you were not given, phrase it as a question.

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

   Assert a file's contents only by quoting a string you can see in its excerpt above.
- Do not recite the rule: say what breaks HERE and what it produces. « Chaîne FR en dur » is
  worthless; « ce libellé de bouton est éditorial, il doit vivre dans le contenu sinon il
  échappe à l'admin et à la traduction » is worth something.
- ${options.maxFindings} bullets maximum across Bloquant, À corriger and Suggestions, plus at
  most five under À vérifier. Past that nobody reads you. If you have more, keep the costly
  ones. This ceiling is there to rank your findings, never to justify dropping one in silence:
  when you cut, say so in the Verdict.
- Do not comment on formatting or style that lint and Prettier already settle.
- No summary of the PR, no compliments, no closing paragraph. The author wrote it.
- A finding outside the PR's scope is labelled as such, goes under Suggestions, and proposes
  opening an issue. It never blocks.
- Write in French. Never use an em dash.

# Which section

- Bloquant: breaks production, loses or exposes data, leaks a secret or personal data, or
  introduces a certain functional regression.
- À corriger: breaks a rule from the doctrine above, or a probable but undemonstrated bug.
- Suggestions: optional improvements, debt, test blind spots.
- À vérifier: what you cannot settle with the files you were given. A suspicion about a caller
  you were not shown, an invariant you could not confirm, a behaviour that depends on data you
  cannot see. Say what would confirm or kill it. Sending a real doubt here is right; sending a
  finding you could have proven from the excerpts above is not.`;
}

export function buildUserPrompt(meta: PrMeta, context: AssembledContext): string {
  const fileList = meta.files
    .map((file) => {
      const flag = context.skipped.includes(file.path) ? ' (not reviewed)' : '';
      return `- ${file.path} (+${file.additions} / -${file.deletions}, ${file.status})${flag}`;
    })
    .join('\n');

  const contents =
    context.files.length > 0
      ? context.files.map((file) => `### ${file.path}\n\n\`\`\`\n${file.numbered}\n\`\`\``).join('\n\n')
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

Lines are numbered. That number is the one you cite in \`path:line\`. Any file absent from this
section was not given to you: do not describe its contents.

${contents}`;
}
