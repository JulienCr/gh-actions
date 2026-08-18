/**
 * Review IA d'une pull request, postée en un commentaire de synthèse.
 *
 * Quatre appels au modèle et non un : trois passes indépendantes (régression
 * fonctionnelle, doctrine du dépôt, données et accès) qui voient le même
 * contexte, puis une fusion qui trie et rédige. Voir `passes.ts` pour le
 * pourquoi du découpage.
 *
 * Tourne à l'identique en CI (action `JulienCr/gh-actions/pr-review`) et en
 * local, pour régler un prompt sans polluer une PR :
 *
 *   npx --yes -p github:JulienCr/gh-actions pr-review 154 --dry-run
 *
 * PRINCIPE : ce programme ne fait jamais échouer le job. Une review est un avis,
 * pas un gate. Un quota Ollama épuisé, une panne, une clé absente : on le dit
 * dans un commentaire quand c'est possible, et on sort en 0. La seule chose
 * qu'on refuse est le silence, qui laisserait une PR non relue passer pour une
 * PR jugée irréprochable.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { assembleContext, type AssembledContext } from './context';
import { run } from './exec';
import { currentHeadSha, fetchPrDiff, fetchPrMeta, postComment, resolveRepo, type PrMeta } from './gh';
import { compileMatcher } from './globs';
import { isEnabled, resolveConfig, UsageError, type Config } from './inputs';
import { chat, OllamaError, type ChatResult } from './ollama';
import { buildUserPrompt, type DoctrineFile, type PromptOptions } from './prompt';
import {
  buildMergeSystemPrompt,
  buildMergeUserPrompt,
  buildPassSystemPrompt,
  PASSES,
  PASS_HEADING,
  type Pass,
} from './passes';
import { extractReview, renderComment, renderFailureComment, renderPartialComment } from './render';
import {
  describeCall,
  renderBreakdown,
  statsLine,
  totals,
  type CallStat,
  type InputBreakdown,
} from './stats';

/** Emplacement 1Password de la clé, pour l'usage local. Surchargeable. */
const DEFAULT_KEY_REF = 'op://Personal/Ollama/add more/api_key';

/**
 * Racine du dépôt relu.
 *
 * Le répertoire courant d'une action JavaScript **est** le workspace, mais
 * `GITHUB_WORKSPACE` est le contrat documenté : s'y fier évite de dépendre d'un
 * détail d'implémentation du runner.
 */
function repoRoot(): string {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}

/**
 * Lit les fichiers de doctrine.
 *
 * L'absence d'un fichier dégrade la review, elle ne l'annule pas : la liste par
 * défaut couvre trois conventions de nommage et aucun dépôt ne les a toutes.
 * Seul le cas « aucun fichier trouvé » mérite d'être crié, parce qu'il change la
 * nature de ce que le modèle peut dire.
 */
function readDoctrine(root: string, paths: string[]): DoctrineFile[] {
  const files: DoctrineFile[] = [];
  for (const path of paths) {
    try {
      files.push({ path, content: readFileSync(join(root, path), 'utf-8') });
    } catch {
      console.log(`· ${path} : absent, ignoré.`);
    }
  }
  if (files.length === 0) {
    console.warn(
      `⚠ Aucun fichier de doctrine trouvé parmi : ${paths.join(', ')}.\n` +
        "  La review tournera sur des critères génériques. Renseigne l'input « doctrine ».",
    );
  }
  return files;
}

/**
 * Prévient quand le contenu lu ne correspond pas au diff envoyé.
 *
 * Le diff vient de GitHub, à la tête de la PR ; le contenu intégral vient du
 * disque, donc du commit sorti. En CI les deux coïncident (le workflow sort la
 * tête de la PR). En local sur une PR déjà mergée, non : le modèle reçoit alors
 * le diff d'hier et les fichiers d'aujourd'hui, et conclut de travers sur des
 * lignes qui ont bougé. Mesuré : la moitié des « hallucinations » d'un réglage
 * de prompt venaient de là, pas du modèle.
 */
async function warnOnDetachedContext(headSha: string): Promise<void> {
  const head = await currentHeadSha();
  if (head && head !== headSha) {
    console.warn(
      `⚠ Le dépôt est sur ${head.slice(0, 8)}, la PR sur ${headSha.slice(0, 8)} : le contenu lu ne\n` +
        "  correspond pas au diff. Pour un réglage de prompt fidèle, fais d'abord « gh pr checkout ».",
    );
  }
}

/**
 * Récupère la clé Ollama depuis 1Password, en local seulement.
 *
 * Évite qu'elle traîne dans un `.env` ou dans l'historique du shell. En CI elle
 * vient de l'input, et `op` n'existe pas : on ne tente rien.
 */
async function keyFrom1Password(): Promise<string> {
  if (process.env.GITHUB_ACTIONS === 'true') return '';
  const ref = process.env.OLLAMA_API_KEY_REF ?? DEFAULT_KEY_REF;
  try {
    // tr côté appelant serait inutile : c'est le wrapper WSL de op.exe qui rend
    // une fin de ligne Windows, et un trim suffit à l'absorber.
    return (await run('op', ['read', ref])).trim();
  } catch {
    console.warn(`⚠ Clé absente et lecture de ${ref} impossible (1Password verrouillé ?).`);
    return '';
  }
}

/**
 * Ce que les quatre appels laissent derrière eux : un relevé et des échecs.
 *
 * Un relevé par appel et non quatre compteurs cumulés : baisser le contexte
 * d'une passe et baisser son raisonnement font tous deux descendre le total, et
 * demandent des décisions opposées. Un total ne permet pas de les distinguer.
 */
interface Run {
  calls: CallStat[];
  /** Raisons des appels en échec, pour les expliquer si plus rien n'aboutit. */
  failures: string[];
}

/**
 * Un appel au modèle, dont l'échec ne fait pas tomber les autres.
 *
 * Les trois passes sont indépendantes : deux passes sur trois valent mieux que
 * rien, à condition que le commentaire le déclare, ce dont se charge le pied de
 * page. La raison du premier échec est conservée pour le cas où tout échoue.
 */
async function callModel(
  config: Config,
  run: Run,
  args: { id: string; system: string; user: string; think: string; label: string },
): Promise<ChatResult | null> {
  const sizes = { systemChars: args.system.length, userChars: args.user.length };
  let result: ChatResult;
  try {
    result = await chat({
      apiKey: config.apiKey,
      model: config.model,
      system: args.system,
      user: args.user,
      think: args.think,
      temperature: config.temperature,
      seed: config.seed,
      timeoutMs: config.timeoutMs,
      onRetry: (reason) => console.warn(`⚠ [${args.label}] ${reason} — nouvelle tentative dans 20 s.`),
      onDowngrade: (reason) =>
        console.warn(
          `⚠ [${args.label}] ${config.model} n'a pas accepté « thinking: ${args.think} » (${reason}).\n` +
            '  Relancé sans raisonnement explicite : ce sera moins fouillé.',
        ),
    });
  } catch (error) {
    const reason = error instanceof OllamaError ? error.message : String(error);
    console.error(`✗ ${args.label} : ${reason}`);
    run.failures.push(reason);
    // Consigné quand même : l'entrée d'un appel raté a été envoyée, donc payée.
    // Ollama ne rend pas ses compteurs sur un échec, d'où des tokens à zéro et
    // des caractères, eux, connus.
    run.calls.push({
      id: args.id,
      label: args.label,
      think: args.think,
      ...sizes,
      promptTokens: 0,
      evalTokens: 0,
      thinkingChars: 0,
      contentChars: 0,
      durationMs: 0,
      ok: false,
    });
    return null;
  }

  const stat: CallStat = {
    id: args.id,
    label: args.label,
    think: args.think,
    ...sizes,
    promptTokens: result.promptTokens,
    evalTokens: result.evalTokens,
    thinkingChars: result.thinkingChars,
    contentChars: result.content.length,
    durationMs: result.durationMs,
    ok: true,
  };
  run.calls.push(stat);
  console.log(`✓ ${describeCall(stat)}`);
  return result;
}

interface PassOutcome {
  pass: Pass;
  findings: string;
}

/**
 * Lance les trois passes en parallèle.
 *
 * En parallèle et non l'une après l'autre : elles ne dépendent pas les unes des
 * autres, et le mur du job devient la plus lente au lieu de leur somme. Le prix
 * est que le contexte part trois fois ; c'est le coût assumé du découpage, et il
 * est bien plus faible que celui d'un axe de recherche que le modèle expédie
 * parce que deux autres lui tiennent la tête.
 */
async function runPasses(config: Config, run: Run, plan: PassPrompt[]): Promise<PassOutcome[]> {
  const results = await Promise.all(
    plan.map(async ({ pass, system, user, think }) => {
      const result = await callModel(config, run, {
        id: pass.id,
        system,
        user,
        think,
        label: `passe ${pass.label}`,
      });
      if (result === null) return null;
      return { pass, findings: extractReview(result.content, PASS_HEADING) };
    }),
  );
  return results.filter((result): result is PassOutcome => result !== null);
}

/**
 * Ce qui partira pour une passe, calculé avant tout appel.
 *
 * Séparé de l'envoi pour que `--count-only` mesure exactement ce qui serait
 * parti, plutôt qu'une reconstruction parallèle qui dériverait du vrai chemin
 * à la première divergence.
 */
interface PassPrompt {
  pass: Pass;
  system: string;
  user: string;
  think: string;
}

function planPasses(config: Config, promptOptions: PromptOptions, user: string): PassPrompt[] {
  return PASSES.map((pass) => ({
    pass,
    system: buildPassSystemPrompt(pass, promptOptions),
    user,
    think: config.thinking,
  }));
}

/**
 * La ventilation de l'entrée d'UNE passe, en caractères.
 *
 * Sur la somme des appels, un bloc envoyé à une seule passe paraîtrait bien plus
 * petit qu'il ne l'est pour celle qui le reçoit : on couperait ailleurs qu'où il
 * faut.
 */
function breakdown(plan: PassPrompt[], context: AssembledContext): InputBreakdown {
  const first = plan[0];
  const sum = (files: { numbered: string }[]) =>
    files.reduce((total, file) => total + file.numbered.length, 0);
  const system = first?.system.length ?? 0;
  const diff = context.diff.length;
  const touched = sum(context.files);
  const imported = sum(context.imported);
  return {
    system,
    diff,
    touched,
    imported,
    // Ce qui reste du prompt user : titre, description, liste des fichiers et
    // consignes. Déduit plutôt que recompté, pour que la somme des parts fasse
    // toujours exactement le prompt envoyé.
    meta: Math.max(0, (first?.user.length ?? 0) - diff - touched - imported),
  };
}

/**
 * Imprime ce qui partirait au modèle, sans rien lui envoyer.
 *
 * L'entrée est déterministe : mêmes fichiers, même prompt, mêmes caractères. Une
 * seule exécution suffit donc à comparer deux réglages, et elle ne coûte rien.
 * C'est ce qui permet de choisir où couper sur des mesures plutôt que sur un
 * pari, la composition d'une PR changeant d'un dépôt à l'autre.
 */
function countOnly(config: Config, plan: PassPrompt[], context: AssembledContext): void {
  const calls: CallStat[] = plan.map(({ pass, system, user, think }) => ({
    id: pass.id,
    label: `passe ${pass.label}`,
    think,
    systemChars: system.length,
    userChars: user.length,
    promptTokens: 0,
    evalTokens: 0,
    thinkingChars: 0,
    contentChars: 0,
    durationMs: 0,
    ok: true,
  }));

  console.log(
    `\nPR #${config.pr} · ${context.files.length} fichier(s) touchés · ` +
      `${context.imported.length} importé(s) · variante « ${config.variant} »\n`,
  );
  console.log(renderBreakdown(calls, breakdown(plan, context)));
  // La fusion ne se mesure pas à vide : son entrée est faite des trouvailles des
  // passes, qui n'existent qu'une fois les passes appelées. La taire vaut mieux
  // que la deviner, d'autant qu'elle ne pèse presque rien.
  console.log(
    '\n  La fusion n\u2019est pas comptée : son entrée est faite des trouvailles des passes,\n' +
      '  qui n\u2019existent pas sans appel. Mesurée en production, elle pèse ~2 000 tokens.',
  );
}

async function review(config: Config): Promise<void> {
  const root = repoRoot();

  console.log(`Lecture de la PR #${config.pr}…`);
  const [repo, meta, rawDiff] = await Promise.all([
    resolveRepo(),
    fetchPrMeta(config.pr),
    fetchPrDiff(config.pr),
  ]);
  await warnOnDetachedContext(meta.headSha);

  const context = assembleContext({
    rawDiff,
    prFiles: meta.files,
    isSkipped: compileMatcher(config.skip),
    budget: {
      totalChars: config.budgetChars,
      perFileChars: config.perFileChars,
      importedChars: config.importsBudgetChars,
    },
    readFile: (path) => {
      try {
        return readFileSync(join(root, path), 'utf-8');
      } catch {
        return null;
      }
    },
    // Un dossier n'est pas un fichier : sans ce test, `./composants` résoudrait
    // vers le dossier lui-même et on raterait son `index.ts`.
    exists: (path) => {
      try {
        return statSync(join(root, path), { throwIfNoEntry: false })?.isFile() ?? false;
      } catch {
        return false;
      }
    },
  });

  if (context.diff.trim() === '') {
    console.log('Aucun fichier relisible dans cette PR (générés, binaires ou lockfiles seulement).');
    return;
  }

  const promptOptions: PromptOptions = {
    repo,
    projectSummary: config.projectSummary,
    doctrine: readDoctrine(root, config.doctrine),
  };
  const user = buildUserPrompt(meta, context);
  const plan = planPasses(config, promptOptions, user);
  console.log(
    `Contexte : ${context.files.length} fichier(s) touchés, ${context.imported.length} importé(s), ` +
      `${plan.length} passes + fusion (${config.model}).`,
  );

  if (config.countOnly) {
    countOnly(config, plan, context);
    return;
  }

  const started = Date.now();
  const run: Run = { calls: [], failures: [] };
  const outcomes = await runPasses(config, run, plan);

  if (outcomes.length === 0) {
    const reason = run.failures[0] ?? 'raison inconnue';
    console.error(`Échec de la review : aucune passe n'a abouti (${reason}).`);
    if (!config.dryRun) await postComment(config.pr, renderFailureComment(reason, config.model));
    return;
  }

  const merged = await callModel(config, run, {
    id: 'merge',
    // Les passes qui ont abouti, pas celles qui étaient prévues : annoncer un
    // relecteur qui n'a rien rendu ferait chercher à la fusion un axe absent.
    system: buildMergeSystemPrompt({
      repo,
      maxFindings: config.maxFindings,
      passes: outcomes.map((outcome) => outcome.pass),
    }),
    user: buildMergeUserPrompt(meta, outcomes),
    think: config.mergeThinking,
    label: 'fusion',
  });

  const server = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/$/, '');
  const shared = {
    repoUrl: `${server}/${repo}`,
    headSha: meta.headSha,
    // Les fichiers importés sont de vrais fichiers du dépôt : les lier est juste.
    // Le filtre garde son rôle contre les chemins que le modèle invente.
    knownPaths: knownPaths(meta, context),
    footer: {
      model: config.model,
      durationMs: Date.now() - started,
      ...totals(run.calls),
      skipped: context.skipped,
      omitted: context.omitted,
      imported: context.imported.length,
      failedPasses: PASSES.filter((pass) => !outcomes.some((outcome) => outcome.pass === pass)).map(
        (pass) => pass.label,
      ),
    },
  };

  const comment =
    merged === null
      ? renderPartialComment({
          ...shared,
          reason: run.failures.at(-1) ?? 'raison inconnue',
          passes: outcomes.map((outcome) => ({ label: outcome.pass.label, findings: outcome.findings })),
        })
      : renderComment({ ...shared, review: merged.content });

  // Une ligne, greppable dans un journal de CI comme en local. Les trouvailles
  // brutes y sont : comparer deux réglages sur leurs tokens dit lequel est le
  // moins cher, jamais lequel a perdu une trouvaille.
  console.log(
    statsLine({
      pr: config.pr,
      model: config.model,
      variant: config.variant,
      calls: run.calls,
      blocks: breakdown(plan, context),
      findings: Object.fromEntries(outcomes.map((outcome) => [outcome.pass.id, outcome.findings])),
    }),
  );

  if (config.dryRun) {
    console.log('\n────────── review (dry-run, non postée) ──────────\n');
    console.log(comment);
    return;
  }

  await postComment(config.pr, comment);
  console.log(`Review postée sur la PR #${config.pr}.`);
}

function knownPaths(meta: PrMeta, context: AssembledContext): Set<string> {
  return new Set([
    ...meta.files.map((file) => file.path),
    ...context.imported.map((file) => file.path),
  ]);
}

async function main(): Promise<void> {
  // Avant tout le reste : ni PR lue, ni clé cherchée, ni token dépensé. Le job
  // reste vert, et le log dit pourquoi il n'y aura pas de commentaire.
  if (!isEnabled(process.env)) {
    console.log('Review désactivée (input « enable »).');
    return;
  }

  const config = resolveConfig({
    argv: process.argv.slice(2),
    env: process.env,
    warn: (message) => console.warn(`⚠ ${message}`),
  });

  // `gh` lit son jeton dans l'environnement. Le poser ici plutôt que de le
  // demander au workflow : un dépôt qui branche l'action n'a pas à connaître le
  // nom de la variable qu'attend un CLI qu'il n'appelle pas lui-même.
  if (config.githubToken) process.env.GH_TOKEN = config.githubToken;

  // `--count-only` n'appelle rien : exiger une clé pour compter des caractères
  // interdirait de mesurer depuis un poste sans 1Password, ou depuis la CI.
  if (!config.apiKey && !config.countOnly) config.apiKey = await keyFrom1Password();
  if (!config.apiKey && !config.countOnly) {
    // Cas nominal d'une PR venue d'un fork : GitHub n'y expose pas les secrets.
    // Rien à commenter, rien à faire échouer.
    console.log('Clé Ollama absente : review ignorée.');
    return;
  }

  await review(config);
}

main().catch((error: unknown) => {
  // Dernier filet : même une erreur inattendue (gh absent, PR introuvable) ne
  // doit pas rougir le check. Seule l'erreur d'invocation fait exception.
  console.error(`Review interrompue : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof UsageError ? 1 : 0;
});
