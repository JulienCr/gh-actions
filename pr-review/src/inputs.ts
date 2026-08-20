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

import { isProvider, PROVIDER_IDS, PROVIDERS } from './llm';
import { parseList } from './globs';
import { EFFORTS, isEffort, PASSES, stepDown, type Effort } from './passes';

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
  /** Provider des passes qui n'en désignent pas d'autre. */
  provider: 'ollama',
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
   * Nom du statut de commit.
   *
   * La barre oblique est celle des statuts d'intégration tierce, et elle range
   * le check à côté de ses pareils plutôt que parmi les jobs du dépôt. C'est
   * cette chaîne exacte qu'il faudra écrire dans la protection de branche.
   */
  statusContext: 'aristarque/review',
  /**
   * Plafond de tokens de sortie. `0` : rien n'est envoyé, le modèle garde le sien.
   *
   * Pas de valeur livrée, parce qu'aucune ne vaut pour tous les modèles : ce
   * qui borne un dérapage sur l'un tronquerait une review légitime sur l'autre.
   * Le dépôt qui a mesuré son besoin l'écrit.
   */
  maxOutputTokens: 0,
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

/**
 * Les quatre appels que fait une review : les trois passes de lecture, puis la
 * fusion. Chacun se configure séparément.
 */
export const PASS_IDS = ['regression', 'doctrine', 'data', 'merge'] as const;

export type PassId = (typeof PASS_IDS)[number];

export interface PassConfig {
  provider: string;
  model: string;
  /** Niveau **final**, cran d'effort déjà appliqué. Vide : défaut du modèle. */
  thinking: string;
}

/**
 * Le modèle bon marché, sous le nom que chaque provider lui donne.
 *
 * Le même poids (284 milliards de paramètres dont 13 actifs), servi par deux
 * routes. Ollama le facture en temps GPU, à un **niveau d'usage moyen** là où
 * `glm-5.2:cloud` est à un niveau élevé : le déplacement paie déjà avec la
 * seule clé Ollama. DeepSeek le facture au token, et y ajoute un cache de
 * préfixe qui rend le contexte commun des deux passes presque gratuit.
 */
const CHEAP_MODEL: Record<string, string> = {
  ollama: 'deepseek-v4-flash:cloud',
  deepseek: 'deepseek-v4-flash',
};

/**
 * Le mix recommandé : trois appels sur quatre quittent le modèle flagship.
 *
 * Pourquoi ces trois-là, et pas le quatrième :
 *
 * - **régression** n'y est pas. C'est la passe la plus complexe, la valeur de
 *   GLM-5.2 y est observée empiriquement, et rien ne prouve qu'un autre modèle
 *   la tienne. Elle garde le provider et le modèle globaux.
 * - **doctrine** est une tâche `règle -> conformité -> preuve`, très guidée par
 *   un document qu'elle a sous les yeux. Un modèle bien moins cher y suffit.
 * - **données et accès** est plus subtile, mais V4-Flash est un point de départ
 *   solide. Première escalade prévue si le recall baisse sur de vraies PR :
 *   `data-model: deepseek-v4-pro`, et rien d'autre à toucher.
 * - **fusion** ne reçoit pas le code : elle trie une trentaine de puces. Un
 *   flagship n'y achèterait que de la latence, d'où `low`.
 *
 * Doctrine et données partagent volontairement le même couple provider+modèle.
 * Chez un provider qui cache les préfixes, c'est ce qui leur permet de ne payer
 * qu'une fois les quatre-vingt-dix kilo-octets de contexte commun. Les séparer
 * annulerait ce levier.
 */
export function mixFor(provider: string): Partial<Record<PassId, PassConfig>> {
  const model = CHEAP_MODEL[provider];
  if (!model) return {};
  return {
    doctrine: { provider, model, thinking: 'high' },
    data: { provider, model, thinking: 'high' },
    merge: { provider, model, thinking: 'low' },
  };
}

/**
 * Par quelle route le mix passe, ou `null` quand il ne s'applique pas.
 *
 * Un dépôt qui a désigné son provider global a pris la main : on ne renvoie pas
 * ses passes ailleurs dans son dos, clé DeepSeek ou non. Ce test passait
 * autrefois APRÈS celui de la clé, et un `provider: openai` se faisait quand
 * même déplacer : trois passes partaient chez DeepSeek pendant que la
 * régression restait seule sur un endpoint étranger, avec un nom de modèle
 * Ollama qu'il ne sert pas.
 *
 * Le provider resté au défaut, DeepSeek en direct l'emporte dès qu'une clé
 * existe, parce que son cache de préfixe est le levier le plus fort. Sinon
 * Ollama, qui sert le même modèle et suffit à descendre d'un niveau d'usage.
 */
export function mixRoute(provider: string, hasDeepSeekKey: boolean): string | null {
  if (provider !== DEFAULTS.provider) return null;
  return hasDeepSeekKey ? 'deepseek' : 'ollama';
}

export interface Config {
  pr: number;
  dryRun: boolean;
  /**
   * Le modèle du provider global.
   *
   * Ce n'est plus « le modèle de la review » : chaque appel a le sien, dans
   * `passConfigs`. Celui-ci reste parce qu'un commentaire d'échec doit nommer
   * quelque chose alors qu'aucune passe n'a tourné.
   */
  model: string;
  /** Provider des passes qui n'en désignent pas d'autre. */
  provider: string;
  /** Provider, modèle et raisonnement de chacun des quatre appels. */
  passConfigs: Record<PassId, PassConfig>;
  /** Clés par identifiant de provider. Remplies tard, cf. `main`. */
  keys: Record<string, string>;
  /** Base du provider `openai` générique. Vide : ce provider est inutilisable. */
  openaiBaseUrl: string;
  /**
   * L'endpoint générique cache-t-il les préfixes ?
   *
   * Ne pilote PAS le séquencement, qui vaut pour tout provider : deux appels de
   * même destination s'enchaînent de toute façon. Ne change que ce qu'on
   * annonce du gain, et le relevé de préfixe partagé de `--count-only`. Faux
   * par défaut : « OpenAI-compatible » décrit un protocole, pas une garantie
   * de cache.
   */
  openaiPrefixCache: boolean;
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
  /** Plafond de tokens de SORTIE d'une requête. `0` : rien n'est envoyé. */
  maxOutputTokens: number;
  /** Chemins de doctrine, dans l'ordre où ils seront injectés dans le prompt. */
  doctrine: string[];
  /** Motifs ajoutés au plancher `ALWAYS_SKIPPED`. */
  skip: string[];
  /** Cadrage libre du projet, quand la doctrine n'en donne pas. */
  projectSummary: string;
  githubToken: string;
  /**
   * Poster une annonce « review en cours » avant les appels au modèle.
   *
   * Ce n'est pas du confort : sans elle, une PR sans commentaire ne distingue
   * pas une review en cours d'une review jamais déclenchée, et c'est ce qui a
   * laissé merger des PR non relues.
   */
  announce: boolean;
  /** Poser un statut de commit « pending » puis conclusif. Voir `statusContext`. */
  statusCheck: boolean;
  /** Nom du statut, tel qu'il faudra l'écrire dans la protection de branche. */
  statusContext: string;
  /**
   * `review` : le travail normal. `abort` : ne rien lire ni appeler, seulement
   * conclure une annonce et un statut qu'un run tué a laissés en suspens.
   */
  mode: 'review' | 'abort';
  /** Lien du run, pour l'annonce et le statut. Vide hors CI. */
  runUrl: string;
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
 * Comme `readBoolean`, mais l'absence vaut « oui ».
 *
 * Pour les interrupteurs qu'on veut allumés chez qui n'a rien configuré :
 * l'annonce sert surtout au dépôt qui n'a pas lu la doc, puisque c'est là qu'un
 * silence se lit comme un feu vert.
 */
function readBooleanDefaultTrue(env: Env, name: string): boolean {
  return !/^(false|0|no|off)$/i.test(readInput(env, name));
}

/**
 * L'URL du run courant, dérivée de l'environnement Actions.
 *
 * Pas un input : le dépôt consommateur n'a pas à recopier trois variables que
 * le runner pose déjà. Absente en local, où l'annonce s'en passe.
 */
function runUrlFrom(env: Env): string {
  const server = env.GITHUB_SERVER_URL?.trim();
  const repo = env.GITHUB_REPOSITORY?.trim();
  const id = env.GITHUB_RUN_ID?.trim();
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : '';
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

/**
 * Lit un identifiant de provider, ou prévient et rend le repli.
 *
 * Un provider inconnu ne doit pas annuler la review : même politique que tout
 * input illisible. Le taire, en revanche, ferait tourner la passe sur un
 * provider que personne n'a demandé sans que rien ne le dise.
 */
function readProvider(env: Env, name: string, fallback: string, warn: (m: string) => void): string {
  const raw = readInput(env, name).toLowerCase();
  if (raw === '') return fallback;
  if (isProvider(raw)) return raw;
  warn(
    `input « ${name} » : provider inconnu (« ${raw} ») : on garde ${fallback}.\n` +
      `  Connus : ${PROVIDER_IDS.join(', ')}.`,
  );
  return fallback;
}

/** Ce qui s'applique à une passe quand ni elle ni le mix n'ont rien à dire. */
interface PassFallback {
  provider: string;
  model: string;
  /** Niveau écrit globalement par le dépôt, cran appliqué. Vide : rien d'écrit. */
  thinkingWritten: string;
  /** Niveau intégré, cran appliqué. Toujours renseigné. */
  thinkingDefault: string;
}

/**
 * Résout la configuration d'UN appel.
 *
 * L'ordre de priorité est le seul point subtil de ce module :
 *
 * 1. `<passe>-provider` / `<passe>-model` / `<passe>-thinking` ;
 * 2. l'input global écrit à la main par le dépôt ;
 * 3. le mix recommandé, s'il est actif ;
 * 4. les défauts intégrés.
 *
 * Le mix passe APRÈS ce qui est écrit à la main, et c'est délibéré : un input
 * posé dans un workflow ne doit pas se faire ignorer en silence parce qu'une
 * clé DeepSeek est apparue dans les secrets. C'est aussi pourquoi `action.yml`
 * ne pose plus de défaut sur `model`, `thinking` ni `merge-thinking` : le
 * runner écrit les défauts du manifeste dans `INPUT_*`, et le code ne pourrait
 * plus distinguer « écrit par le dépôt » de « jamais touché ».
 *
 * Un `model` écrit à la main va plus loin et désactive le mix ENTIER (voir
 * `resolveConfig`) : déplacer une passe vers un provider tout en lui laissant
 * le modèle d'un autre produirait un 404, pas un compromis.
 *
 * Le niveau de raisonnement d'un `<passe>-thinking` échappe au cran d'effort :
 * deux mécanismes qui règlent la même valeur finiraient par se battre, et le
 * perdant serait celui que quelqu'un a écrit.
 */
function resolvePass(
  env: Env,
  id: PassId,
  mix: PassConfig | undefined,
  fallback: PassFallback,
  warn: (message: string) => void,
): PassConfig {
  const provider = readProvider(env, `${id}-provider`, mix?.provider ?? fallback.provider, warn);
  // Le mix ne vaut que pour SON provider : un dépôt qui redirige une passe
  // ailleurs ne doit pas hériter du modèle d'un provider qu'il vient d'écarter.
  const applicable = mix && provider === mix.provider ? mix : undefined;
  // Une passe renvoyée vers un autre provider ne doit pas garder le modèle de
  // celui qu'elle quitte : `doctrine-provider: deepseek` sans `doctrine-model`
  // partait avec un nom Ollama, donc en 404.
  const providerDefault =
    provider === fallback.provider ? '' : (PROVIDERS[provider]?.defaultModel ?? '');
  return {
    provider,
    model:
      readInput(env, `${id}-model`) || applicable?.model || providerDefault || fallback.model,
    thinking:
      readInput(env, `${id}-thinking`) ||
      fallback.thinkingWritten ||
      applicable?.thinking ||
      fallback.thinkingDefault,
  };
}

export interface MixOptions {
  provider: string;
  model: string;
  /** `thinking` tel qu'écrit par le dépôt, ou vide. */
  thinking: string;
  /** `merge-thinking` tel qu'écrit par le dépôt, ou vide. */
  mergeThinking: string;
  effort: Effort;
  /** Le mix qui s'applique. Vide : chaque passe suit les inputs globaux. */
  mix: Partial<Record<PassId, PassConfig>>;
}

/**
 * La configuration des quatre appels.
 *
 * Une table plutôt que douze champs : ajouter une passe ne doit pas demander de
 * toucher quatre endroits, et une ligne par appel se lit d'un coup d'oeil.
 */
export function resolvePassConfigs(
  env: Env,
  options: MixOptions,
  warn: (message: string) => void = () => {},
): Record<PassId, PassConfig> {
  const configs = {} as Record<PassId, PassConfig>;
  for (const id of PASS_IDS) {
    // La fusion ne lit pas de code : elle a son propre niveau, et le cran
    // d'effort ne la concerne pas. Les passes de lecture, elles, descendent du
    // nombre de crans que leur table leur assigne.
    const steps = PASSES.find((pass) => pass.id === id)?.thinkingSteps[options.effort] ?? 0;
    const written = id === 'merge' ? options.mergeThinking : options.thinking;
    configs[id] = resolvePass(
      env,
      id,
      options.mix[id],
      {
        provider: options.provider,
        model: options.model,
        thinkingWritten: written ? stepDown(written, steps) : '',
        thinkingDefault:
          id === 'merge' ? DEFAULTS.mergeThinking : stepDown(DEFAULTS.thinking, steps),
      },
      warn,
    );
  }
  return configs;
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
  // Vide tant que personne n'a rien écrit : c'est cette distinction qui permet
  // au mix de s'appliquer sans jamais écraser un input posé à la main.
  let model = readInput(env, 'model') || env.OLLAMA_REVIEW_MODEL?.trim() || '';
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

  const keys: Record<string, string> = {
    ollama: readInput(env, 'ollama-api-key') || env.OLLAMA_API_KEY?.trim() || '',
    deepseek: readInput(env, 'deepseek-api-key') || env.DEEPSEEK_API_KEY?.trim() || '',
    openai: readInput(env, 'openai-api-key') || env.OPENAI_API_KEY?.trim() || '',
  };

  const provider = readProvider(env, 'provider', DEFAULTS.provider, warn);
  // Le modèle par défaut suit le provider, et n'est plus un nom Ollama envoyé à
  // qui n'en sert pas : c'était un 404 sur les quatre appels, avec un journal
  // qui accusait le modèle plutôt que la configuration. Le provider générique
  // n'a pas de catalogue connu, donc pas de défaut : on prévient.
  const providerDefault = PROVIDERS[provider]?.defaultModel || '';
  if (model === '' && providerDefault === '') {
    warn(
      `provider « ${provider} » sans « model » : cet endpoint n'a pas de catalogue connu,\n` +
        `  donc aucun modèle par défaut. Nomme-en un, sinon les appels partiront à vide.`,
    );
  }
  // Un modèle écrit à la main contredit le mix : déplacer une passe ailleurs en
  // lui laissant le modèle d'un autre provider produirait un 404, pas un
  // compromis. L'écrire garde donc le comportement d'avant, pour les quatre.
  const route = model === '' ? mixRoute(provider, keys.deepseek !== '') : null;

  return {
    pr,
    dryRun,
    model: model || providerDefault || DEFAULTS.model,
    provider,
    // Pas de validation contre une liste de niveaux : ils varient d'un modèle à
    // l'autre, et un niveau refusé est rattrapé à l'appel.
    passConfigs: resolvePassConfigs(
      env,
      {
        provider,
        model: model || providerDefault || DEFAULTS.model,
        thinking: readInput(env, 'thinking'),
        mergeThinking: readInput(env, 'merge-thinking'),
        effort,
        mix: route === null ? {} : mixFor(route),
      },
      warn,
    ),
    keys,
    openaiBaseUrl: readInput(env, 'openai-base-url').replace(/\/$/, ''),
    openaiPrefixCache: readBoolean(env, 'openai-prefix-cache'),
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
    maxOutputTokens: readNumber(env, 'max-output-tokens', DEFAULTS.maxOutputTokens, warn),
    doctrine: doctrineInput.length > 0 ? doctrineInput : [...DEFAULT_DOCTRINE],
    // Le plancher d'abord : ce qui suit ne peut qu'ajouter, jamais retirer.
    skip: [...ALWAYS_SKIPPED, ...parseList(readInput(env, 'skip'))],
    projectSummary: readInput(env, 'project-summary'),
    countOnly,
    variant,
    githubToken: readInput(env, 'github-token') || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || '',
    announce: readBooleanDefaultTrue(env, 'announce'),
    statusCheck: readBoolean(env, 'status-check'),
    statusContext: readInput(env, 'status-context') || DEFAULTS.statusContext,
    mode: readInput(env, 'mode').toLowerCase() === 'abort' ? 'abort' : 'review',
    runUrl: runUrlFrom(env),
  };
}
