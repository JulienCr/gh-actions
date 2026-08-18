/**
 * Configuration de la review : inputs de l'action, arguments de la ligne de
 * commande, et défauts. Module **pur** (l'environnement est injecté).
 *
 * Le même binaire sert dans les deux contextes. En CI, GitHub pose chaque input
 * dans `INPUT_<NOM>` ; en local, on passe des drapeaux. Les drapeaux gagnent :
 * quand on règle un prompt depuis son poste, on veut que `--model` l'emporte
 * sans avoir à démonter l'environnement.
 *
 * Aucun input n'est obligatoire hormis le numéro de PR. Un dépôt qui branche la
 * review sans rien configurer doit obtenir une review correcte ; les inputs sont
 * là pour l'ajuster, pas pour la faire démarrer.
 */

import { parseList } from './globs';
import { EFFORTS, isEffort, type Effort } from './passes';

/**
 * Fichiers jamais relus, quels que soient les inputs.
 *
 * C'est un plancher, pas un défaut : ce sont des artefacts mécaniques, une
 * review qui les commente perd son temps et celui du lecteur. Un dépôt qui
 * voudrait vraiment faire relire son lockfile a un problème plus grave.
 *
 * `*.svg` n'y est PAS : un SVG est du texte, parfois écrit à la main dans un
 * composant. L'exclure d'office masquerait une modification relisible. Un dépôt
 * dont les SVG sont des exports machine l'ajoute par l'input « skip ».
 */
export const ALWAYS_SKIPPED: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'Cargo.lock',
  'poetry.lock',
  'go.sum',
  // Ancré nulle part : un monorepo a aussi des `packages/x/node_modules/`.
  '**/node_modules/**',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.webp',
  '*.avif',
  '*.gif',
  '*.ico',
  '*.pdf',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.otf',
  '*.mp3',
  '*.mp4',
  '*.mov',
  '*.zip',
  '*.gz',
  '*.tar',
];

/**
 * Doctrine cherchée par défaut. Les trois noms courants d'un fichier de
 * conventions ; ceux qui n'existent pas sont ignorés sans bruit, donc lister
 * large ne coûte rien.
 */
export const DEFAULT_DOCTRINE: readonly string[] = [
  '.github/copilot-instructions.md',
  'CLAUDE.md',
  'AGENTS.md',
];

export const DEFAULTS = {
  model: 'glm-5.2:cloud',
  maxFindings: 20,
  budgetChars: 500_000,
  perFileChars: 80_000,
  /**
   * Budget des fichiers importés, distinct de celui des fichiers touchés.
   *
   * Mesuré sur une PR réelle : 92 000 tokens envoyés pour une fenêtre de
   * 976 000. La place existe, et elle sert exactement là où le modèle devait
   * renoncer à trancher faute d'avoir l'appelant sous les yeux. `0` désactive.
   */
  importsBudgetChars: 300_000,
  timeoutMinutes: 15,
  /**
   * Effort de raisonnement demandé au modèle.
   *
   * `max` parce qu'une review vaut par ce qu'elle trouve, pas par sa latence :
   * le job tourne pendant que l'auteur fait autre chose. Un modèle qui ne sait
   * pas raisonner rejoue sans (cf. `chat`), donc ce défaut ne ferme la porte à
   * aucun modèle.
   */
  thinking: 'max',
  /**
   * Effort de raisonnement de la fusion, plus bas que celui des passes.
   *
   * Les passes lisent quatre-vingt-dix kilo-octets de code, la fusion trie une
   * trentaine de puces sans avoir le code sous les yeux : `max` n'y achèterait
   * que de la latence. Les passes tournant en parallèle, elles coûtent le temps
   * d'une seule, et c'est la fusion qui s'ajoute au mur du job.
   */
  mergeThinking: 'high',
  /**
   * Surtout pas 0. Le décodage glouton sur un modèle de raisonnement raccourcit
   * la chaîne de pensée et la fait tourner en rond ; 1 est la valeur des
   * exemples officiels de GLM-5. La stabilité d'un jour à l'autre est confiée à
   * la graine, qui la sert sans coûter en profondeur.
   */
  temperature: 1,
  seed: 1,
  /** Nom du bras quand on n'en donne pas : celui du réglage livré. */
  variant: 'default',
  /**
   * Le cran par défaut.
   *
   * « balanced » et non « full » : ce que `full` garde en plus, ce sont des
   * envois dont la mesure n'a pas montré qu'ils rapportaient une trouvaille.
   * Un dépôt qui veut la lecture la plus large l'écrit, et le sait.
   */
  effort: 'balanced' as Effort,
  /** Plafond des imports au cran « lean », où le contexte se resserre. */
  leanImportsBudgetChars: 120_000,
  /**
   * Taille à partir de laquelle un fichier part par extraits, selon le cran.
   *
   * `0` au cran `full` : aucun fenêtrage. Le seuil reste haut ailleurs, parce
   * que fenêtrer un petit fichier économise quelques lignes et coûte une lecture
   * morcelée, plus le risque qu'une conclusion soit tirée d'un trou.
   */
  windowMinLines: { full: 0, balanced: 250, lean: 120 } as Record<Effort, number>,
} as const;

export interface Config {
  pr: number;
  dryRun: boolean;
  model: string;
  /** Niveau passé à `think` pour les passes. Vide : le modèle garde son défaut. */
  thinking: string;
  /** Idem pour la fusion, qui n'a pas besoin d'autant. */
  mergeThinking: string;
  temperature: number;
  /** `undefined` : pas de graine, le modèle varie d'une exécution à l'autre. */
  seed: number | undefined;
  maxFindings: number;
  budgetChars: number;
  perFileChars: number;
  /** Plafond des fichiers importés joints en contexte. `0` : aucun. */
  importsBudgetChars: number;
  /** L'ampleur des coupes. Voir `Effort` dans `passes.ts`. */
  effort: Effort;
  /** Passes imposées par l'input `passes`. Vide : la règle décide. */
  passes: string[];
  /** Taille au-delà de laquelle un fichier part par extraits. `0` : jamais. */
  windowMinLines: number;
  timeoutMs: number;
  /** Chemins de doctrine, dans l'ordre où ils seront injectés dans le prompt. */
  doctrine: string[];
  /** Motifs ajoutés au plancher `ALWAYS_SKIPPED`. */
  skip: string[];
  /** Cadrage libre du projet, quand la doctrine n'en donne pas. */
  projectSummary: string;
  apiKey: string;
  githubToken: string;
  /** Imprimer ce qui partirait, et ne rien envoyer. Réglage local seulement. */
  countOnly: boolean;
  /** Nom libre du bras mesuré, repris dans la ligne « ::stats:: ». */
  variant: string;
}

/**
 * Erreur d'invocation, seul cas qui sort en 1.
 *
 * Le reste du programme sort toujours en 0 pour ne pas rougir le check, mais une
 * ligne de commande fautive n'est pas un aléa de review : la masquer ferait
 * croire à une review qui a tourné.
 */
export class UsageError extends Error {}

export type Env = Record<string, string | undefined>;

/**
 * Lit un input d'action.
 *
 * Reprend la convention du runner : `INPUT_` + le nom en capitales, les espaces
 * en tirets bas. Les traits d'union sont conservés tels quels, donc
 * `ollama-api-key` se lit dans `INPUT_OLLAMA-API-KEY`. C'est contre-intuitif,
 * c'est ce que fait `@actions/core`, et c'est ce que pose le runner.
 */
export function readInput(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

/**
 * Nombre au-dessus du minimum, ou le repli. Une valeur illisible ne doit pas
 * annuler la review.
 *
 * `minimum` vaut 1 partout sauf pour les budgets qu'on peut vouloir annuler :
 * un plafond nul n'a pas de sens pour un délai, il en a un pour du contexte
 * facultatif, où il veut dire « n'en joins aucun ».
 */
function readNumber(
  env: Env,
  name: string,
  fallback: number,
  warn: (message: string) => void,
  minimum = 1,
): number {
  const raw = readInput(env, name);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    warn(`input « ${name} » illisible (« ${raw} ») : on garde ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/**
 * Le cran demandé, ou le défaut.
 *
 * Un cran inconnu ne doit pas annuler la review : on prévient et on garde le
 * défaut, comme pour tout input illisible.
 */
function readEffort(env: Env, warn: (message: string) => void): Effort {
  const raw = readInput(env, 'effort').toLowerCase();
  if (raw === '') return DEFAULTS.effort;
  if (isEffort(raw)) return raw;
  warn(
    `input « effort » inconnu (« ${raw} ») : on garde ${DEFAULTS.effort}.\n` +
      `  Valeurs acceptées : ${EFFORTS.join(', ')}.`,
  );
  return DEFAULTS.effort;
}

function readBoolean(env: Env, name: string): boolean {
  return /^(true|1|yes)$/i.test(readInput(env, name));
}

/**
 * La review est-elle branchée ?
 *
 * Interrupteur du dépôt consommateur : `enable: false` la coupe sans rien
 * démonter du workflow, le temps d'un quota épuisé ou d'une refonte. Absent vaut
 * allumé, sinon un dépôt qui branche l'action sans lire la doc n'obtiendrait
 * rien et croirait à une PR jugée irréprochable.
 *
 * Lu hors de `resolveConfig`, et appelé avant lui : une review éteinte ne doit
 * pas exiger un numéro de PR, seule chose dont l'absence sort en 1.
 */
export function isEnabled(env: Env): boolean {
  return !/^(false|0|no|off)$/i.test(readInput(env, 'enable'));
}

/**
 * Comme `readNumber`, mais zéro est une valeur, pas une erreur.
 *
 * `readNumber` refuse zéro parce qu'un plafond nul n'a pas de sens ; une
 * température nulle en a un, même si on la déconseille.
 */
function readTemperature(env: Env, warn: (message: string) => void): number {
  const raw = readInput(env, 'temperature');
  if (raw === '') return DEFAULTS.temperature;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    warn(`input « temperature » illisible (« ${raw} ») : on garde ${DEFAULTS.temperature}.`);
    return DEFAULTS.temperature;
  }
  if (parsed === 0) {
    warn(
      'temperature = 0 sur un modèle de raisonnement : la review sera plus courte et plus\n' +
        '  superficielle. Pour de la stabilité, garde la température et fixe « seed ».',
    );
  }
  return parsed;
}

/** `off` (ou `none`) rend la variance au modèle ; tout le reste est une graine. */
function readSeed(env: Env, warn: (message: string) => void): number | undefined {
  const raw = readInput(env, 'seed');
  if (raw === '') return DEFAULTS.seed;
  if (/^(off|none|false)$/i.test(raw)) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    warn(`input « seed » illisible (« ${raw} ») : on garde ${DEFAULTS.seed}.`);
    return DEFAULTS.seed;
  }
  return parsed;
}

export interface ResolveOptions {
  argv: string[];
  env: Env;
  warn?: (message: string) => void;
}

/**
 * Assemble la configuration effective.
 *
 * `argv` ne porte que ce qui sert au réglage local : le numéro de PR, `--dry-run`
 * et `--model`. Tout le reste vient des inputs, parce que tout le reste se règle
 * une fois dans le workflow du dépôt et ne bouge plus.
 */
export function resolveConfig({ argv, env, warn = () => {} }: ResolveOptions): Config {
  let pr: number | null = null;
  let dryRun = readBoolean(env, 'dry-run');
  let model = readInput(env, 'model') || env.OLLAMA_REVIEW_MODEL?.trim() || DEFAULTS.model;
  let countOnly = false;
  let variant = readInput(env, 'variant') || DEFAULTS.variant;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry-run') dryRun = true;
    // Ne rien envoyer implique ne rien poster : sans ça, une faute de frappe sur
    // un drapeau de mesure irait commenter une PR.
    else if (arg === '--count-only') {
      countOnly = true;
      dryRun = true;
    } else if (arg === '--model') {
      const value = argv[++index];
      if (!value) throw new UsageError('« --model » attend un nom de modèle.');
      model = value;
    } else if (arg === '--variant') {
      const value = argv[++index];
      if (!value) throw new UsageError('« --variant » attend un nom.');
      variant = value;
    } else if (/^#?\d+$/.test(arg)) pr = Number(arg.replace('#', ''));
    else throw new UsageError(`argument inconnu : ${arg}`);
  }

  if (pr === null) {
    const fromInput = readInput(env, 'pr');
    if (/^#?\d+$/.test(fromInput)) pr = Number(fromInput.replace('#', ''));
  }
  if (pr === null) {
    const fromEvent = env.PR_NUMBER?.trim();
    if (fromEvent && /^\d+$/.test(fromEvent)) pr = Number(fromEvent);
  }
  if (pr === null) {
    throw new UsageError(
      "numéro de PR manquant. En CI, renseigne l'input « pr » ; en local : pr-review <numéro> [--dry-run] [--model <nom>]",
    );
  }

  const doctrineInput = parseList(readInput(env, 'doctrine'));
  const effort = readEffort(env, warn);

  return {
    pr,
    dryRun,
    model,
    // Pas de validation contre une liste de niveaux : ils varient d'un modèle à
    // l'autre, et un niveau refusé est rattrapé à l'appel.
    thinking: readInput(env, 'thinking') || DEFAULTS.thinking,
    mergeThinking: readInput(env, 'merge-thinking') || DEFAULTS.mergeThinking,
    temperature: readTemperature(env, warn),
    seed: readSeed(env, warn),
    maxFindings: readNumber(env, 'max-findings', DEFAULTS.maxFindings, warn),
    budgetChars: readNumber(env, 'budget-chars', DEFAULTS.budgetChars, warn),
    perFileChars: readNumber(env, 'per-file-chars', DEFAULTS.perFileChars, warn),
    effort,
    passes: parseList(readInput(env, 'passes')),
    windowMinLines: readNumber(
      env,
      'window-min-lines',
      DEFAULTS.windowMinLines[effort],
      warn,
      0,
    ),
    // Le cran pose le défaut, l'input explicite l'écrase : régler « effort » ne
    // doit pas rendre un budget écrit à la main silencieusement inopérant.
    importsBudgetChars: readNumber(
      env,
      'imports-budget-chars',
      effort === 'lean' ? DEFAULTS.leanImportsBudgetChars : DEFAULTS.importsBudgetChars,
      warn,
      0,
    ),
    timeoutMs: readNumber(env, 'timeout-minutes', DEFAULTS.timeoutMinutes, warn) * 60_000,
    doctrine: doctrineInput.length > 0 ? doctrineInput : [...DEFAULT_DOCTRINE],
    // Le plancher d'abord : ce qui suit ne peut qu'ajouter, jamais retirer.
    skip: [...ALWAYS_SKIPPED, ...parseList(readInput(env, 'skip'))],
    projectSummary: readInput(env, 'project-summary'),
    countOnly,
    variant,
    apiKey: readInput(env, 'ollama-api-key') || env.OLLAMA_API_KEY?.trim() || '',
    githubToken: readInput(env, 'github-token') || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || '',
  };
}
