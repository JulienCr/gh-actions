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
   * Surtout pas 0. Le décodage glouton sur un modèle de raisonnement raccourcit
   * la chaîne de pensée et la fait tourner en rond ; 1 est la valeur des
   * exemples officiels de GLM-5. La stabilité d'un jour à l'autre est confiée à
   * la graine, qui la sert sans coûter en profondeur.
   */
  temperature: 1,
  seed: 1,
} as const;

export interface Config {
  pr: number;
  dryRun: boolean;
  model: string;
  /** Niveau passé à `think`. Vide : le modèle garde son propre défaut. */
  thinking: string;
  temperature: number;
  /** `undefined` : pas de graine, le modèle varie d'une exécution à l'autre. */
  seed: number | undefined;
  maxFindings: number;
  budgetChars: number;
  perFileChars: number;
  timeoutMs: number;
  /** Chemins de doctrine, dans l'ordre où ils seront injectés dans le prompt. */
  doctrine: string[];
  /** Motifs ajoutés au plancher `ALWAYS_SKIPPED`. */
  skip: string[];
  /** Cadrage libre du projet, quand la doctrine n'en donne pas. */
  projectSummary: string;
  apiKey: string;
  githubToken: string;
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

/** Nombre positif, ou le repli. Une valeur illisible ne doit pas annuler la review. */
function readNumber(env: Env, name: string, fallback: number, warn: (message: string) => void): number {
  const raw = readInput(env, name);
  if (raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`input « ${name} » illisible (« ${raw} ») : on garde ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function readBoolean(env: Env, name: string): boolean {
  return /^(true|1|yes)$/i.test(readInput(env, name));
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

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--model') {
      const value = argv[++index];
      if (!value) throw new UsageError('« --model » attend un nom de modèle.');
      model = value;
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

  return {
    pr,
    dryRun,
    model,
    // Pas de validation contre une liste de niveaux : ils varient d'un modèle à
    // l'autre, et un niveau refusé est rattrapé à l'appel.
    thinking: readInput(env, 'thinking') || DEFAULTS.thinking,
    temperature: readTemperature(env, warn),
    seed: readSeed(env, warn),
    maxFindings: readNumber(env, 'max-findings', DEFAULTS.maxFindings, warn),
    budgetChars: readNumber(env, 'budget-chars', DEFAULTS.budgetChars, warn),
    perFileChars: readNumber(env, 'per-file-chars', DEFAULTS.perFileChars, warn),
    timeoutMs: readNumber(env, 'timeout-minutes', DEFAULTS.timeoutMinutes, warn) * 60_000,
    doctrine: doctrineInput.length > 0 ? doctrineInput : [...DEFAULT_DOCTRINE],
    // Le plancher d'abord : ce qui suit ne peut qu'ajouter, jamais retirer.
    skip: [...ALWAYS_SKIPPED, ...parseList(readInput(env, 'skip'))],
    projectSummary: readInput(env, 'project-summary'),
    apiKey: readInput(env, 'ollama-api-key') || env.OLLAMA_API_KEY?.trim() || '',
    githubToken: readInput(env, 'github-token') || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || '',
  };
}
