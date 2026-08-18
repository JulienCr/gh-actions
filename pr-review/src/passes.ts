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

import type { AssembledContext } from './context';
import type { PrFile, PrMeta } from './gh';
import type { ChatMessage } from './llm/types';
import { buildPreamble, buildUserPrompt, type PromptOptions } from './prompt';

/**
 * Le repère qui sépare le raisonnement des trouvailles.
 *
 * Même mécanique que `## Verdict` pour la review finale : le cloud Ollama ignore
 * `format`, donc rien ne contraint la forme côté serveur et le seul repère
 * fiable est celui qu'on impose. Voir `extractReview` dans `render.ts`.
 */
export const PASS_HEADING = '## Trouvailles';

/**
 * Ce qu'une passe doit rendre.
 *
 * Paramétré par la présence des fichiers importés : la règle sur les doutes y
 * renvoie explicitement, et une consigne qui désigne une section absente envoie
 * le modèle chercher un contexte qu'on ne lui a pas donné.
 */
const passOutput = (hasImports: boolean) => `# What to return

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
- **doute**: what you cannot settle with the files you were given. Say what would settle it.${
  hasImports
    ? '\n  A doubt that the context files above DO settle is not a doubt: read them and conclude.'
    : ''
}

No ceiling on this pass: report everything you found on your axis. Ranking happens later.

Do not recite the rule, say what breaks HERE and what it produces. « Chaîne FR en dur » is
worthless; « ce libellé de bouton est éditorial, il doit vivre dans le contenu sinon il échappe à
l'admin et à la traduction » is worth something.

Never use an em dash. The merge pass is told not to rewrite your wording, so anything you write
here reaches the posted comment as is.

Found nothing? Return \`${PASS_HEADING}\` and a single bullet « - [rien] : » followed by what you
actually checked to be able to say it. Never an empty section.`;

/**
 * L'ampleur des coupes, réglée par l'input `effort`.
 *
 * `full | balanced | lean` plutôt que `high | balanced | low` : à côté d'un
 * `thinking: low | medium | high | max` déjà présent, deux échelles qui
 * partagent les mots `high` et `low` finiraient par se confondre dans un
 * workflow, et personne ne s'en apercevrait avant de lire une facture.
 */
export type Effort = 'full' | 'balanced' | 'lean';

export const EFFORTS: readonly Effort[] = ['full', 'balanced', 'lean'];

export const isEffort = (value: string): value is Effort =>
  (EFFORTS as readonly string[]).includes(value);

/** L'échelle de raisonnement, du moins au plus coûteux. */
const LEVELS = ['low', 'medium', 'high', 'max'] as const;

/**
 * Descend de `steps` crans, sans jamais passer sous « low ».
 *
 * Relatif et non absolu : un dépôt qui écrit `thinking: low` doit l'obtenir
 * partout, au lieu de se faire remonter à « medium » par une passe qui aurait
 * son niveau écrit en dur.
 *
 * Une valeur hors échelle est rendue telle quelle. Un booléen, ou le niveau d'un
 * modèle qu'on ne connaît pas encore, n'a pas à être deviné ici : un niveau
 * refusé est de toute façon rattrapé par le repli de `chat`.
 */
export function stepDown(level: string, steps: number): string {
  if (steps <= 0) return level;
  const index = (LEVELS as readonly string[]).indexOf(level.trim().toLowerCase());
  if (index === -1) return level;
  return LEVELS[Math.max(0, index - steps)]!;
}

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
  /**
   * Cette passe reçoit-elle les fichiers importés, à ce cran ?
   *
   * Toute la politique de contexte tient dans cette table, une ligne par passe :
   * trois `if` dispersés dans l'assemblage auraient fini par se contredire.
   */
  imports: Record<Effort, boolean>;
  /** Crans de raisonnement retirés au niveau demandé par le dépôt. */
  thinkingSteps: Record<Effort, number>;
  /**
   * Rend une raison, en français, quand cette PR ne peut rien déclencher ici.
   * Absent : la passe tourne toujours, et c'est un choix, pas un oubli.
   */
  skipWhen?: (input: SelectionInput) => string | null;
}

export interface SelectionInput {
  /** Fichiers relisibles de la PR, exclusions déjà appliquées. */
  files: PrFile[];
  hasDoctrine: boolean;
}

/**
 * Extensions dont on peut affirmer qu'elles ne s'exécutent pas.
 *
 * Liste NÉGATIVE et minuscule, jamais positive : une liste d'extensions de code
 * raterait le langage du prochain dépôt et supprimerait en silence une passe qui
 * avait quelque chose à dire. Ici, se tromper veut dire lancer la passe pour
 * rien, ce qui coûte des tokens et jamais une trouvaille.
 *
 * `.json`, `.yml` et `.toml` n'y sont PAS : un workflow, un `package.json` ou
 * une policy sont de la configuration exécutée, et une régression y vit très
 * bien.
 *
 * `.mdx` non plus, bien qu'il ressemble à du `.md` : il porte des imports, des
 * expressions et des composants JSX, évalués à la compilation ou au rendu. Une
 * signature cassée y casse la page, et ce n'est ni de la doctrine ni de l'accès
 * aux données : sauter la passe de régression sur une PR de `.mdx` lui retire
 * exactement le seul axe qui pouvait la relire.
 */
const PROSE_ONLY = ['.md', '.txt', '.rst', '.adoc'];

/** L'extension d'un chemin, sans dépendre de `node:path` dans un module pur. */
function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

const runsSomething = (files: PrFile[]): boolean =>
  files.some((file) => !PROSE_ONLY.includes(extensionOf(file.path)));

export const PASSES: readonly Pass[] = [
  {
    id: 'regression',
    label: 'régression fonctionnelle',
    axis: "functional regressions",
    // Sa matière première : son premier axe s'appelle « The caller's side ».
    imports: { full: true, balanced: true, lean: true },
    // L'axe le plus coûteux à creuser, et celui qui le mérite : tracer un
    // appelant, un chemin d'erreur ou une course est une recherche, pas un
    // parcours de liste. Il garde son raisonnement à tous les crans.
    thinkingSteps: { full: 0, balanced: 0, lean: 0 },
    skipWhen: ({ files }) =>
      runsSomething(files) ? null : 'aucun fichier exécutable dans cette PR',
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
    // Elle juge la PR contre un document qu'elle a déjà sous les yeux, et son
    // prompt lui interdit de relever quoi que ce soit dans un fichier non
    // modifié : les appelants et les enums ne lui apprennent rien.
    imports: { full: true, balanced: false, lean: false },
    thinkingSteps: { full: 0, balanced: 0, lean: 2 },
    // Son propre prompt lui dicte alors sa sortie mot pour mot (« say so in a
    // single « - [rien] : » bullet and stop »). La lancer revient à payer un
    // contexte entier et un raisonnement pour une réponse écrite d'avance,
    // ce qui n'a de sens à aucun cran.
    skipWhen: ({ hasDoctrine }) =>
      hasDoctrine ? null : 'ce dépôt ne fournit aucun fichier de doctrine',
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
    // Son cinquième axe compare la forme exposée avant et après, et sa règle de
    // preuve renvoie aux extraits fournis : lui couper le contexte
    // transformerait des trouvailles en « doute », soit exactement le régime que
    // le contexte importé a été introduit pour supprimer.
    imports: { full: true, balanced: true, lean: false },
    thinkingSteps: { full: 0, balanced: 0, lean: 1 },
    // Aucune règle, à aucun cran. Un README fuit une clé aussi bien qu'un .ts,
    // une doc d'API publie un endpoint interne, une capture collée porte une
    // adresse. Le coût d'une fuite dépasse de plusieurs ordres celui d'une
    // passe : ce trou ne doit pas être « optimisé » dans six mois.
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

export interface Selection {
  run: Pass[];
  /** Passes délibérément non lancées. Ce n'est pas un incident, et ça se dit. */
  skipped: { label: string; reason: string }[];
}

export interface SelectOptions {
  /**
   * Appliquer les règles de `skipWhen` propres à chaque passe.
   *
   * Faux au cran `full`, qui promet la lecture la plus fouillée possible. La
   * règle de la doctrine absente fait exception et s'applique quand même :
   * `full` promet de la profondeur, pas du gaspillage délibéré.
   */
  auto: boolean;
  /** Identifiants imposés par l'input `passes`. Vide : la règle décide. */
  forced: string[];
  warn?: (message: string) => void;
}

/**
 * Choisit les passes à lancer, et dit pourquoi elle écarte les autres.
 *
 * Ne rend jamais une liste vide : une optimisation ne doit pas produire une
 * review muette, qu'une PR non relue rendrait indiscernable d'une PR jugée
 * irréprochable.
 */
export function selectPasses(input: SelectionInput, options: SelectOptions): Selection {
  if (options.forced.length > 0) {
    const wanted = options.forced.map((id) => id.trim().toLowerCase());
    const known = new Set(PASSES.map((pass) => pass.id));
    const unknown = wanted.filter((id) => !known.has(id));

    // Chaque identifiant est vérifié, pas seulement la liste entière. Une
    // coquille dans « data » laissait passer une liste partiellement valide :
    // la passe des fuites ne tournait pas, et rien ne le disait. C'est le seul
    // chemin par lequel cet axe peut disparaître, il ne peut pas être muet.
    if (unknown.length > 0) {
      options.warn?.(
        `input « passes » : identifiant(s) inconnu(s) : ${unknown.join(', ')}.\n` +
          `  Connus : ${[...known].join(', ')}.`,
      );
    }

    const run = PASSES.filter((pass) => wanted.includes(pass.id));
    // Celui qui écrit une liste valide sait ce qu'il fait : aucune règle ne s'y
    // applique. Une liste dont rien n'est reconnu est une faute de frappe, pas
    // une demande : on lance les trois plutôt que de ne rien relire.
    if (run.length > 0) return { run: [...run], skipped: [] };

    options.warn?.('  Aucun identifiant exploitable : on lance les trois passes.');
    return { run: [...PASSES], skipped: [] };
  }

  const run: Pass[] = [];
  const skipped: { label: string; reason: string }[] = [];

  for (const pass of PASSES) {
    // La doctrine absente se juge à tous les crans ; le reste seulement en auto.
    const applies = options.auto || pass.id === 'doctrine';
    const reason = applies ? (pass.skipWhen?.(input) ?? null) : null;
    if (reason === null) run.push(pass);
    else skipped.push({ label: pass.label, reason });
  }

  if (run.length === 0) return { run: [...PASSES], skipped: [] };
  return { run, skipped };
}

/**
 * Les messages d'une passe, dans l'ordre qui rend le cache possible.
 *
 * Trois messages et non deux, et l'objectif de la passe en DERNIER. Le prompt
 * système portait auparavant le préambule **et** l'objectif : deux passes
 * divergeaient donc dès leur premier octet, et les quatre-vingt-dix kilo-octets
 * de contexte qui suivaient étaient repayés intégralement à chaque appel.
 * Aucun cache de préfixe ne pouvait s'y accrocher.
 *
 * Ici le préambule est identique pour toutes les passes, le contexte aussi (au
 * bloc des imports près, rendu en dernier), et seul le troisième message
 * change. Le préfixe commun est donc aussi long que possible, ce qui est
 * exactement ce qu'un cache de préfixe sait réutiliser.
 *
 * Le texte n'a pas bougé, seulement sa place. Une consigne posée APRÈS un long
 * contexte est d'ailleurs plutôt mieux honorée qu'une consigne lue avant.
 */
export function buildPassMessages(
  pass: Pass,
  options: PromptOptions,
  meta: PrMeta,
  seen: AssembledContext,
): ChatMessage[] {
  return [
    { role: 'system', content: buildPreamble(options) },
    { role: 'user', content: buildUserPrompt(meta, seen) },
    // La consigne sur les doutes ne s'écrit que s'il y a bien une section de
    // fichiers de contexte à lire : sinon elle désigne du vide.
    { role: 'user', content: `${pass.objective}\n\n${passOutput(seen.imported.length > 0)}` },
  ];
}

export interface Sequenceable {
  /** Deux appels qui partagent ce couple peuvent partager un cache. */
  provider: string;
  model: string;
  /** Taille de l'entrée, en caractères. */
  chars: number;
  /**
   * Les enchaîner achète-t-il un préfixe en cache ?
   *
   * Ne décide plus du groupement, seulement de ce qu'on en DIT : chez un
   * provider qui cache, la mise en file achète des tokens ; chez les autres,
   * elle achète des passes qui aboutissent. Voir `groupByDestination`.
   */
  cacheable: boolean;
}

/**
 * Regroupe les appels par destination, et ordonne chaque groupe.
 *
 * Deux appels qui visent le même couple provider+modèle ne partent plus
 * ensemble. Deux raisons, et la seconde a coûté trois reviews avant d'être
 * comprise :
 *
 * 1. **Le cache.** Chez un provider qui cache les préfixes, la seconde requête
 *    rejoue le gros contexte commun à un trente-et-unième du tarif, à condition
 *    de partir APRÈS : un cache s'écrit à la fin de l'entrée qui l'a produit.
 *    D'où le tri par taille croissante, au cran `balanced` : « doctrine » ne
 *    reçoit pas les fichiers importés et « données » les reçoit, or ils sont
 *    rendus en dernier. Le prompt de doctrine est alors un préfixe strict de
 *    celui de données.
 * 2. **La capacité.** Mesuré sur avolo-shorts#63, #64 et #68 : trois grosses
 *    requêtes simultanées sur un même compte Ollama, et les deux qui partagent
 *    un modèle rendent un contenu VIDE après trois minutes de génération. La
 *    même passe lancée SEULE, avec un contexte plus gros (173 109 tokens contre
 *    ~134 000), aboutit. Ce n'est donc pas la taille du contexte, c'est la
 *    concurrence.
 *
 * Le groupement ne regarde donc plus `cacheable`. La version précédente y
 * voyait le seul motif de sérialiser, et laissait par conséquent partir
 * ensemble deux appels qu'Ollama ne savait pas servir en même temps.
 *
 * Les groupes, eux, restent parallèles entre eux : destinations distinctes,
 * rien à se disputer.
 */
export function groupByDestination<T extends Sequenceable>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = `${item.provider}/${item.model}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  // Le tri est stable : deux entrées de même taille gardent l'ordre des passes,
  // qui est lui-même déterministe. Rien ici ne doit dépendre d'une exécution.
  return [...groups.values()].map((group) => [...group].sort((a, b) => a.chars - b.chars));
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
