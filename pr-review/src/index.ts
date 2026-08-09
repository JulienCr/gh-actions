/**
 * Review IA d'une pull request, postée en un commentaire de synthèse.
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assembleContext } from './context';
import { run } from './exec';
import { currentHeadSha, fetchPrDiff, fetchPrMeta, postComment, resolveRepo } from './gh';
import { compileMatcher } from './globs';
import { resolveConfig, UsageError, type Config } from './inputs';
import { chat, OllamaError } from './ollama';
import { buildSystemPrompt, buildUserPrompt, type DoctrineFile } from './prompt';
import { renderComment, renderFailureComment } from './render';

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
    budget: { totalChars: config.budgetChars, perFileChars: config.perFileChars },
    readFile: (path) => {
      try {
        return readFileSync(join(root, path), 'utf-8');
      } catch {
        return null;
      }
    },
  });

  if (context.diff.trim() === '') {
    console.log('Aucun fichier relisible dans cette PR (générés, binaires ou lockfiles seulement).');
    return;
  }

  const system = buildSystemPrompt({
    repo,
    projectSummary: config.projectSummary,
    doctrine: readDoctrine(root, config.doctrine),
    maxFindings: config.maxFindings,
  });
  const user = buildUserPrompt(meta, context);
  console.log(
    `Contexte : ${context.files.length} fichier(s) en intégral, ` +
      `${Math.round((system.length + user.length) / 1024)} Ko envoyés à ${config.model}.`,
  );

  let result;
  try {
    result = await chat({
      apiKey: config.apiKey,
      model: config.model,
      system,
      user,
      think: config.thinking,
      temperature: config.temperature,
      seed: config.seed,
      timeoutMs: config.timeoutMs,
      onRetry: (reason) => console.warn(`⚠ ${reason} — nouvelle tentative dans 20 s.`),
      onDowngrade: (reason) =>
        console.warn(
          `⚠ ${config.model} n'a pas accepté « thinking: ${config.thinking} » (${reason}).\n` +
            '  Review relancée sans raisonnement explicite : elle sera moins fouillée.',
        ),
    });
  } catch (error) {
    const reason = error instanceof OllamaError ? error.message : String(error);
    console.error(`Échec de la review : ${reason}`);
    if (!config.dryRun) await postComment(config.pr, renderFailureComment(reason, config.model));
    return;
  }

  const server = (process.env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/$/, '');
  const comment = renderComment({
    review: result.content,
    repoUrl: `${server}/${repo}`,
    headSha: meta.headSha,
    knownPaths: new Set(meta.files.map((file) => file.path)),
    footer: {
      model: config.model,
      durationMs: result.durationMs,
      promptTokens: result.promptTokens,
      evalTokens: result.evalTokens,
      thinkingChars: result.thinkingChars,
      skipped: context.skipped,
      omitted: context.omitted,
    },
  });

  if (config.dryRun) {
    console.log('\n────────── review (dry-run, non postée) ──────────\n');
    console.log(comment);
    return;
  }

  await postComment(config.pr, comment);
  console.log(`Review postée sur la PR #${config.pr}.`);
}

async function main(): Promise<void> {
  const config = resolveConfig({
    argv: process.argv.slice(2),
    env: process.env,
    warn: (message) => console.warn(`⚠ ${message}`),
  });

  // `gh` lit son jeton dans l'environnement. Le poser ici plutôt que de le
  // demander au workflow : un dépôt qui branche l'action n'a pas à connaître le
  // nom de la variable qu'attend un CLI qu'il n'appelle pas lui-même.
  if (config.githubToken) process.env.GH_TOKEN = config.githubToken;

  if (!config.apiKey) config.apiKey = await keyFrom1Password();
  if (!config.apiKey) {
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
