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

import { assembleContext, contextFor, type AssembledContext, type WindowOptions } from './context';
import { run } from './exec';
import {
  currentHeadSha,
  fetchPrDiff,
  fetchPrMeta,
  findMarkedComment,
  postStatus,
  resolveRepo,
  upsertComment,
  type PrMeta,
  type StatusState,
} from './gh';
import { compileMatcher } from './globs';
import {
  isEnabled,
  readInput,
  resolveConfig,
  UsageError,
  type Config,
  type Env,
  type PassConfig,
  type PassId,
} from './inputs';
import {
  describeDowngrade,
  estimateCost,
  isPeakHour,
  LlmError,
  PROVIDERS,
  type ChatMessage,
  type ChatResult,
} from './llm';
import { type DoctrineFile, type PromptOptions } from './prompt';
import {
  buildMergeSystemPrompt,
  buildMergeUserPrompt,
  buildPassMessages,
  groupByDestination,
  PASS_HEADING,
  selectPasses,
  type Pass,
} from './passes';
import {
  extractReview,
  MARKER,
  renderAbortedComment,
  isPendingComment,
  renderComment,
  renderFailureComment,
  renderPartialComment,
  renderPendingComment,
} from './render';
import {
  describeCall,
  describeTargets,
  estimateTokens,
  renderBreakdown,
  statsLine,
  totals,
  type CallStat,
  type InputBreakdown,
} from './stats';

/**
 * Le fenêtrage, hors son seuil, qui vient du cran.
 *
 * `pad` assez large pour tenir la fonction touchée et sa signature : en dessous
 * de quarante lignes on coupe au milieu d'une fonction, soit exactement le
 * voisinage qui justifie d'envoyer le contenu et pas seulement le diff.
 */
const WINDOW: Omit<WindowOptions, 'minLines'> = {
  pad: 60,
  head: 40,
  joinGap: 25,
  maxCoverage: 0.7,
};

/**
 * Emplacements 1Password des clés, pour l'usage local. Surchargeables par
 * `<PROVIDER>_API_KEY_REF`, par exemple `OLLAMA_API_KEY_REF`.
 */
const DEFAULT_KEY_REFS: Record<string, string> = {
  ollama: 'op://Personal/Ollama/add more/api_key',
  deepseek: 'op://Personal/DeepSeek/api_key',
};

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
async function warnOnDetachedContext(headSha: string): Promise<boolean> {
  const head = await currentHeadSha();
  if (head && head !== headSha) {
    console.warn(
      `⚠ Le dépôt est sur ${head.slice(0, 8)}, la PR sur ${headSha.slice(0, 8)} : le contenu lu ne\n` +
        "  correspond pas au diff. Pour un réglage de prompt fidèle, fais d'abord « gh pr checkout ».",
    );
    return true;
  }
  return false;
}

/**
 * Récupère la clé d'un provider depuis 1Password, en local seulement.
 *
 * Évite qu'elle traîne dans un `.env` ou dans l'historique du shell. En CI elle
 * vient de l'input, et `op` n'existe pas : on ne tente rien.
 */
async function keyFrom1Password(provider: string): Promise<string> {
  if (process.env.GITHUB_ACTIONS === 'true') return '';
  const ref = process.env[`${provider.toUpperCase()}_API_KEY_REF`] ?? DEFAULT_KEY_REFS[provider];
  if (!ref) return '';
  try {
    // tr côté appelant serait inutile : c'est le wrapper WSL de op.exe qui rend
    // une fin de ligne Windows, et un trim suffit à l'absorber.
    return (await run('op', ['read', ref])).trim();
  } catch {
    console.warn(`⚠ Clé ${provider} absente et lecture de ${ref} impossible (1Password verrouillé ?).`);
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
 * Où part un appel, et avec quelle clé.
 *
 * Le provider `openai` générique n'a pas de base par défaut : sans
 * `openai-base-url`, il viserait api.openai.com par accident. Mieux vaut le
 * déclarer inutilisable et le dire.
 */
function endpointFor(config: Config, target: PassConfig): { baseUrl: string; apiKey: string } | null {
  const spec = PROVIDERS[target.provider];
  if (!spec) return null;
  const baseUrl =
    target.provider === 'openai'
      ? // Le provider générique n'existe que pour viser l'adresse qu'on lui
        // donne. `openai-base-url` ne vaut QUE pour lui : appliquée à DeepSeek,
        // elle enverrait la review chez le voisin sans que rien ne le dise.
        config.openaiBaseUrl
      : // `OLLAMA_HOST` est historique et documenté ; le motif vaut pour tout
        // provider qui a une base par défaut, ce qui donne un bac à sable local
        // gratuit. Le provider générique n'en est pas : son adresse ne vient que
        // de `openai-base-url`, faute de défaut à surcharger.
        (process.env[`${target.provider.toUpperCase()}_HOST`] ?? spec.defaultBaseUrl).replace(
          /\/$/,
          '',
        );
  const apiKey = config.keys[target.provider] ?? '';
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/**
 * Prévient quand une clé partirait en clair sur le réseau.
 *
 * Une base en `http://` est légitime en local, où le bac à sable de ce dépôt
 * l'utilise ; vers un hôte distant, elle expose l'en-tête `Authorization` à
 * quiconque écoute. On avertit sans refuser : c'est une configuration
 * délibérée, et le job ne rougit jamais.
 */
function warnOnClearTextKey(config: Config, targets: readonly PassConfig[]): void {
  const risky = new Set<string>();
  for (const target of targets) {
    const endpoint = endpointFor(config, target);
    if (!endpoint) continue;
    if (/^https:/i.test(endpoint.baseUrl)) continue;
    if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(endpoint.baseUrl)) continue;
    risky.add(endpoint.baseUrl);
  }
  for (const baseUrl of risky) {
    console.warn(
      `⚠ ${baseUrl} n'est pas en HTTPS : la clé part en clair dans un en-tête.\n` +
        "  Acceptable sur un hôte local, jamais vers un endpoint distant.",
    );
  }
}

/**
 * Enchaîner deux appels chez ce provider achète-t-il un préfixe en cache ?
 *
 * L'endpoint générique n'a pas de réponse par défaut : personne ne sait ce
 * qu'un endpoint qu'on ne connaît pas garantit, et le supposer coûterait du
 * temps de job contre une économie imaginaire. C'est au dépôt de le dire.
 */
function cachesPrefixes(config: Config, provider: string): boolean {
  if (provider === 'openai') return config.openaiPrefixCache;
  return PROVIDERS[provider]?.prefixCache ?? false;
}

/** Ce que pèsent les messages, consignes d'un côté et contexte de l'autre. */
function sizes(messages: ChatMessage[]): { instructionChars: number; contextChars: number } {
  // Le contexte est le PREMIER message user : c'est ce que produit
  // `buildPassMessages`, et c'est le bloc que deux passes se partagent. Tout le
  // reste (préambule système, objectif de la passe) est de la consigne.
  const context = messages.find((message) => message.role === 'user');
  const total = messages.reduce((sum, message) => sum + message.content.length, 0);
  const contextChars = context?.content.length ?? 0;
  return { instructionChars: total - contextChars, contextChars };
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
  args: { id: string; target: PassConfig; messages: ChatMessage[]; label: string },
): Promise<ChatResult | null> {
  const { target } = args;
  const shape = {
    id: args.id,
    label: args.label,
    provider: target.provider,
    model: target.model,
    // Le niveau DEMANDÉ. Un appel qui aboutit le remplace par celui qui a été
    // joué, que le repli a pu changer en cours de route ; un appel raté le
    // garde, faute d'avoir jamais rien retenu.
    think: target.thinking,
    ...sizes(args.messages),
  };

  const endpoint = endpointFor(config, target);
  let result: ChatResult;
  try {
    if (endpoint === null) {
      // Ne devrait pas arriver : `usableTargets` a déjà écarté ces passes. Le
      // test reste, parce qu'un chemin qui appellerait sans clé partirait en
      // 401 après avoir envoyé quatre-vingt-dix kilo-octets.
      throw new LlmError(`aucun endpoint utilisable pour « ${target.provider} »`);
    }
    result = await PROVIDERS[target.provider]!.client({
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl,
      model: target.model,
      messages: args.messages,
      think: target.thinking,
      temperature: config.temperature,
      seed: config.seed,
      timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens,
      onRetry: (reason) => console.warn(`⚠ [${args.label}] ${reason} — nouvelle tentative dans 20 s.`),
      onDowngrade: (event) => console.warn(`⚠ [${args.label}] ${describeDowngrade(event, target.model)}`),
    });
  } catch (error) {
    const reason = error instanceof LlmError ? error.message : String(error);
    console.error(`✗ ${args.label} : ${reason}`);
    run.failures.push(reason);
    // Consigné quand même : l'entrée d'un appel raté a été envoyée, donc payée.
    // Les compteurs ne sont pas rendus sur un échec, d'où des tokens à zéro et
    // des caractères, eux, connus.
    run.calls.push({
      ...shape,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      thinkingChars: 0,
      contentChars: 0,
      durationMs: 0,
      costUsd: null,
      ok: false,
    });
    return null;
  }

  const stat: CallStat = {
    ...shape,
    think: result.think,
    inputTokens: result.usage.inputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    thinkingChars: result.thinkingChars,
    contentChars: result.content.length,
    durationMs: result.durationMs,
    // Le régime horaire au moment de l'appel : DeepSeek facture moitié prix
    // hors des heures pleines, et supposer le pire gonflerait de deux le seul
    // chiffre qui sert à juger cette refonte.
    costUsd: estimateCost(target.provider, target.model, result.usage, isPeakHour(new Date())),
    ok: true,
  };
  run.calls.push(stat);
  console.log(`✓ ${describeCall(stat)}`);
  return result;
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
  target: PassConfig;
  messages: ChatMessage[];
  /** Le contexte que CETTE passe reçoit, imports retirés le cas échéant. */
  seen: AssembledContext;
  /** Pour `groupByDestination` : deux appels de même destination partagent une file. */
  provider: string;
  model: string;
  /** Taille totale de l'entrée. Le plus court part en premier dans son groupe. */
  chars: number;
  cacheable: boolean;
}

/**
 * Ce qui partira, passe par passe.
 *
 * Un prompt par passe et non un seul partagé : le contexte que chacune reçoit
 * dépend désormais d'elle et du cran, et la construction doit rester le seul
 * chemin vers l'envoi, pour que `--count-only` mesure ce qui partirait vraiment.
 */
function planPasses(
  config: Config,
  promptOptions: PromptOptions,
  meta: PrMeta,
  context: AssembledContext,
  passes: readonly Pass[],
): PassPrompt[] {
  return passes.map((pass) => {
    const target = config.passConfigs[pass.id as PassId];
    const seen = contextFor(context, pass.imports[config.effort]);
    const messages = buildPassMessages(pass, promptOptions, meta, seen);
    return {
      pass,
      target,
      messages,
      seen,
      provider: target.provider,
      model: target.model,
      chars: messages.reduce((sum, message) => sum + message.content.length, 0),
      cacheable: cachesPrefixes(config, target.provider),
    };
  });
}

interface PassOutcome {
  pass: Pass;
  findings: string;
}

/**
 * Lance les passes, groupées par destination.
 *
 * Deux régimes, et c'est tout l'objet de la fonction :
 *
 * - **entre groupes, en parallèle.** Ils ne partagent rien, et les sérialiser
 *   ne ferait qu'additionner leurs durées. Le mur du job reste celui du groupe
 *   le plus lent, en pratique la régression.
 * - **dans un groupe, en séquence.** Deux passes qui visent le même couple
 *   provider+modèle partagent un préfixe de quatre-vingt-dix kilo-octets, mais
 *   un cache s'écrit à la fin de l'entrée qui l'a produit : lancées ensemble,
 *   elles le paient toutes les deux. La plus courte part en premier, et la
 *   seconde rejoue son préfixe à un trente-et-unième du tarif.
 *
 * L'échec d'une passe ne fait toujours tomber qu'elle : dans un groupe
 * séquentiel, il coûte à la suivante son cache, pas sa lecture.
 */
async function runPasses(config: Config, run: Run, plan: PassPrompt[]): Promise<PassOutcome[]> {
  const groups = await Promise.all(
    groupByDestination(plan).map(async (group) => {
      const outcomes: PassOutcome[] = [];
      for (const { pass, target, messages } of group) {
        const result = await callModel(config, run, {
          id: pass.id,
          target,
          messages,
          label: `passe ${pass.label}`,
        });
        if (result !== null) {
          outcomes.push({ pass, findings: extractReview(result.content, PASS_HEADING) });
        }
      }
      return outcomes;
    }),
  );
  // Remis dans l'ordre des passes : le groupement est un détail d'exécution, et
  // le commentaire ne doit pas changer d'ordre selon qui a été groupé avec qui.
  const done = new Map(groups.flat().map((outcome) => [outcome.pass, outcome]));
  return plan
    .map(({ pass }) => done.get(pass))
    .filter((outcome): outcome is PassOutcome => outcome !== undefined);
}

/**
 * La ventilation de l'entrée d'UNE passe, en caractères.
 *
 * Sur la somme des appels, un bloc envoyé à une seule passe paraîtrait bien plus
 * petit qu'il ne l'est pour celle qui le reçoit : on couperait ailleurs qu'où il
 * faut.
 */
function breakdown(plan: PassPrompt[]): InputBreakdown {
  const first = plan[0];
  const sum = (files: { numbered: string }[]) =>
    files.reduce((total, file) => total + file.numbered.length, 0);
  // Le contexte de CETTE passe, pas le contexte global : depuis que le cran
  // retire les imports à certaines passes, compter ceux du contexte global
  // attribuerait des caractères qui ne partent pas, écraserait « meta » à zéro
  // et rendrait la ventilation fausse précisément dans les réglages que
  // « --count-only » sert à comparer.
  const seen = first?.seen;
  const measured = first ? sizes(first.messages) : { instructionChars: 0, contextChars: 0 };
  const diff = seen?.diff.length ?? 0;
  const touched = sum(seen?.files ?? []);
  const imported = sum(seen?.imported ?? []);
  return {
    // Le préambule commun ET l'objectif de la passe : les deux sont de la
    // consigne, quel que soit le rôle du message qui les porte.
    system: measured.instructionChars,
    diff,
    touched,
    imported,
    // Ce qui reste du bloc de contexte : titre, description, liste des fichiers
    // et bannières. Déduit plutôt que recompté, pour que la somme des parts
    // fasse toujours exactement le prompt envoyé.
    meta: Math.max(0, measured.contextChars - diff - touched - imported),
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
  const calls: CallStat[] = plan.map(({ pass, target, messages }) => {
    const measured = sizes(messages);
    const inputTokens = estimateTokens(measured.instructionChars + measured.contextChars);
    return {
      id: pass.id,
      label: `passe ${pass.label}`,
      provider: target.provider,
      model: target.model,
      think: target.thinking,
      ...measured,
      inputTokens,
      // Rien n'est encore parti : aucun cache ne peut être supposé, et le
      // supposer flatterait précisément le chiffre qu'on veut vérifier.
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      thinkingChars: 0,
      contentChars: 0,
      durationMs: 0,
      costUsd: estimateCost(
        target.provider,
        target.model,
        { inputTokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        isPeakHour(new Date()),
      ),
      ok: true,
    };
  });

  console.log(
    `\nPR #${config.pr} · ${context.files.length} fichier(s) touchés · ` +
      `${context.imported.length} importé(s) · variante « ${config.variant} »\n`,
  );
  console.log(renderBreakdown(calls, breakdown(plan)));
  // La fusion ne se mesure pas à vide : son entrée est faite des trouvailles des
  // passes, qui n'existent qu'une fois les passes appelées. La taire vaut mieux
  // que la deviner, d'autant qu'elle ne pèse presque rien.
  console.log(
    '\n  La fusion n\u2019est pas comptée : son entrée est faite des trouvailles des passes,\n' +
      '  qui n\u2019existent pas sans appel. Mesurée en production, elle pèse ~2 000 tokens.',
  );
  for (const group of groupByDestination(plan).filter((chain) => chain.length > 1)) {
    // Deux motifs de mise en file, et ils ne s'annoncent pas pareil : chez un
    // provider qui cache, elle achète des tokens ; chez les autres, elle achète
    // des passes qui aboutissent.
    const why = group[0]!.cacheable
      ? 'pour que la seconde rejoue le préfixe de la première en cache'
      : "parce qu'un même modèle ne sert pas deux gros contextes à la fois";
    console.log(
      `\n  ${group.map(({ pass }) => `« ${pass.label} »`).join(' puis ')} : même destination,\n` +
        `  donc lancées à la suite ${why}.`,
    );
    if (group[0]!.cacheable) console.log(`  ${describePrefix(group)}`);
  }
}

/**
 * Le préfixe que deux appels enchaînés se partagent réellement, en caractères.
 *
 * Vérifié sur les vrais prompts et pas seulement en test unitaire : le test
 * épingle la règle, ce relevé épingle la PR du jour. Un fichier au contenu
 * inattendu, une doctrine lue dans un ordre différent, et le préfixe tombe à
 * quelques centaines de caractères sans que rien d'autre ne le signale.
 * `--count-only` ne coûtant rien, autant qu'il le dise avant l'appel plutôt
 * qu'après la facture.
 */
function describePrefix(group: PassPrompt[]): string {
  const shared = group.reduce<string | null>((prefix, { messages }) => {
    const whole = messages.map((message) => message.content).join('\n');
    if (prefix === null) return whole;
    let cut = 0;
    while (cut < prefix.length && cut < whole.length && prefix[cut] === whole[cut]) cut += 1;
    return prefix.slice(0, cut);
  }, null);

  const chars = shared?.length ?? 0;
  const smallest = Math.min(...group.map(({ chars: total }) => total));
  const share = Math.round((chars / smallest) * 100);
  if (share < 90) {
    return (
      `⚠ préfixe commun : ${chars.toLocaleString('fr-FR')} caractères seulement, soit ${share} %\n` +
      "    du plus court des deux prompts. Le cache ne portera que sur cette part : une consigne\n" +
      '    accordée différemment selon la passe a dû diverger avant le contexte.'
    );
  }
  return `préfixe commun : ${chars.toLocaleString('fr-FR')} caractères, ~${chars > 0 ? Math.round(chars / 3.5).toLocaleString('fr-FR') : 0} tokens réutilisables.`;
}

/**
 * Écarte les passes dont la destination n'a pas de clé, plutôt que de les
 * envoyer chercher un 401.
 *
 * Le repli est délibérément timide : on retombe sur le provider global, qui est
 * celui que le dépôt utilisait avant, et jamais sur un autre provider configuré
 * pour une autre passe. Sans clé nulle part, la passe n'est pas lancée et le
 * pied de page le déclare : c'est une décision, pas une panne, et le job reste
 * vert dans les deux cas.
 */
/**
 * La destination effective d'un appel, repli compris.
 *
 * ⚠️ **Mutation assumée** : le repli est écrit dans `config.passConfigs`, et pas
 * seulement rendu. C'est ce qui fait qu'une passe repliée part bien sur son
 * nouveau provider, `planPasses` relisant la table. L'ordre compte donc :
 * appeler `planPasses` avant cette fonction laisserait le plan pointer vers un
 * provider sans clé, et le repli ne servirait à rien.
 */
function resolveTarget(
  config: Config,
  id: PassId,
  label: string,
  warn: (message: string) => void,
): PassConfig | null {
  const target = config.passConfigs[id];
  if (endpointFor(config, target) !== null) return target;

  const fallback: PassConfig = { ...target, provider: config.provider, model: config.model };
  if (endpointFor(config, fallback) === null) return null;
  warn(
    `« ${label} » : aucune clé pour « ${target.provider} ».\n` +
      `  Repli sur ${fallback.provider}/${fallback.model}, qui en a une.`,
  );
  config.passConfigs[id] = fallback;
  return fallback;
}

function usableTargets(
  config: Config,
  passes: readonly Pass[],
  warn: (message: string) => void,
): { run: Pass[]; skipped: { label: string; reason: string }[] } {
  const runnable: Pass[] = [];
  const skipped: { label: string; reason: string }[] = [];

  for (const pass of passes) {
    if (resolveTarget(config, pass.id as PassId, `passe ${pass.label}`, warn) !== null) {
      runnable.push(pass);
    } else {
      skipped.push({
        label: pass.label,
        reason: `aucune clé pour « ${config.passConfigs[pass.id as PassId].provider} »`,
      });
    }
  }

  return { run: runnable, skipped };
}

/**
 * Ce qu'Aristarque laisse sur la PR : un commentaire unique et un statut.
 *
 * Regroupés ici parce qu'ils vont toujours par deux — un rapport sans statut
 * laisse partir un auto-merge, un statut sans rapport ne dit pas quoi corriger —
 * et parce que chaque sortie de `review()` doit conclure les deux. Un chemin qui
 * oublie de conclure laisse un « en cours » éternel, qui bloquerait le merge
 * pour de mauvaises raisons.
 */
interface Reporter {
  /** Le commentaire d'attente, posté avant le premier appel au modèle. */
  announce(passes: string[]): Promise<void>;
  /** Le mot de la fin : le commentaire s'il y en a un, et l'état du statut. */
  settle(state: StatusState, description: string, body?: string): Promise<void>;
}

function reporterFor(config: Config, repo: string, headSha: string): Reporter {
  // `dry-run` et `--count-only` ne touchent à rien : ce sont des gestes de
  // réglage, faits depuis un poste, sur une PR qui appartient à quelqu'un.
  const mute = config.dryRun || config.countOnly;

  /** Un statut posé de travers ne doit pas emporter la review avec lui. */
  const status = async (state: StatusState, description: string): Promise<void> => {
    if (mute || !config.statusCheck) return;
    try {
      await postStatus(repo, headSha, {
        state,
        context: config.statusContext,
        description,
        targetUrl: config.runUrl || undefined,
      });
      console.log(`Statut « ${config.statusContext} » → ${state}.`);
    } catch (error) {
      console.warn(`⚠ Statut « ${config.statusContext} » non posé : ${String(error)}`);
    }
  };

  return {
    async announce(passes) {
      if (mute || !config.announce) return;
      try {
        await upsertComment(repo, config.pr, MARKER, renderPendingComment({ passes, runUrl: config.runUrl }));
        console.log(`Annonce posée sur la PR #${config.pr}.`);
      } catch (error) {
        // Cosmétique au sens strict : l'annonce sert à lever une ambiguïté, pas
        // à produire la review. La perdre ne justifie pas de perdre la review.
        console.warn(`⚠ Annonce non posée : ${String(error)}`);
      }
    },
    async settle(state, description, body) {
      if (body !== undefined && !mute) {
        await upsertComment(repo, config.pr, MARKER, body);
      }
      await status(state, description);
    },
  };
}

/**
 * Conclut ce qu'un run tué a laissé en suspens (`mode: abort`).
 *
 * Un run annulé par `cancel-in-progress` ou tranché par `timeout-minutes` ne
 * repasse jamais par la fin de `review()` : son annonce resterait « en cours »
 * et son statut « pending » pour toujours. Le second bloquerait le merge sans
 * fin, ce qui transformerait un garde-fou en panne.
 */
async function abort(config: Config, reason = 'run annulé ou délai dépassé'): Promise<void> {
  const repo = await resolveRepo();
  const meta = await fetchPrMeta(config.pr);
  const report = reporterFor(config, repo, meta.headSha);

  // Un job peut être annulé dans les secondes qui suivent la pose du rapport :
  // l'étape de nettoyage tourne alors sur une review qui a abouti, et
  // l'écraserait. On ne remplace donc QUE l'annonce, reconnaissable à son
  // propre rendu. Le statut, lui, se conclut dans tous les cas — un « pending »
  // laissé derrière bloquerait le merge pour toujours.
  const existing = await findMarkedComment(repo, config.pr, MARKER).catch(() => null);
  const pending = existing === null || isPendingComment(existing.body);
  if (!pending) {
    console.log('Le rapport est déjà posé : seul le statut est conclu.');
    await report.settle('success', 'review rendue');
    return;
  }

  await report.settle('error', `review interrompue (${reason})`, renderAbortedComment(config.runUrl));
  console.log(`Review de la PR #${config.pr} déclarée interrompue.`);
}

async function review(config: Config): Promise<void> {
  const root = repoRoot();

  console.log(`Lecture de la PR #${config.pr}…`);
  const [repo, meta, rawDiff] = await Promise.all([
    resolveRepo(),
    fetchPrMeta(config.pr),
    fetchPrDiff(config.pr),
  ]);
  const detached = await warnOnDetachedContext(meta.headSha);

  // Le « pending » part AVANT tout le reste, et pas au moment de lancer les
  // passes : entre les deux il y a la lecture de la PR, l'assemblage du
  // contexte et quelques appels réseau, soit largement de quoi laisser un
  // auto-merge armé passer devant.
  const report = reporterFor(config, repo, meta.headSha);
  await report.settle('pending', 'review en cours');

  const isSkipped = compileMatcher(config.skip);
  // Un diff périmé donne des plages périmées, donc des fenêtres qui montrent les
  // mauvaises lignes : le fenêtrage ferait d'un avertissement une faute
  // silencieuse. Le cas n'existe qu'en local, la CI sortant la tête de la PR.
  if (detached && config.windowMinLines > 0) {
    console.warn('  Fenêtrage désactivé pour cette exécution : les plages du diff ne seraient pas fiables.');
  }
  const context = assembleContext({
    rawDiff,
    prFiles: meta.files,
    isSkipped,
    window:
      config.windowMinLines > 0 && !detached
        ? { ...WINDOW, minLines: config.windowMinLines }
        : null,
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
    // Pas de commentaire : il n'y a rien à dire, et le dire encombrerait toutes
    // les PR de maintenance. Mais le statut, lui, doit conclure — un « pending »
    // laissé là bloquerait un merge légitime.
    await report.settle('success', 'aucun fichier relisible');
    return;
  }

  const promptOptions: PromptOptions = {
    repo,
    projectSummary: config.projectSummary,
    doctrine: readDoctrine(root, config.doctrine),
  };

  const doctrine = promptOptions.doctrine;
  const selection = selectPasses(
    { files: meta.files.filter((file) => !isSkipped(file.path)), hasDoctrine: doctrine.length > 0 },
    {
      auto: config.effort !== 'full',
      forced: config.passes,
      warn: (message) => console.warn(`⚠ ${message}`),
    },
  );
  // Après `selectPasses` : une passe qu'aucune règle ne lance n'a pas besoin
  // d'une clé, et exiger la clé d'abord ferait râler pour une passe qui ne
  // partait pas. `--count-only` n'appelle rien et n'exige donc rien non plus.
  if (!config.countOnly) {
    const usable = usableTargets(config, selection.run, (message) => console.warn(`⚠ ${message}`));
    selection.run = usable.run;
    selection.skipped.push(...usable.skipped);
  }
  const plan = planPasses(config, promptOptions, meta, context, selection.run);

  console.log(
    `Contexte : ${context.files.length} fichier(s) touchés, ${context.imported.length} importé(s), ` +
      `${plan.length} passe(s) + fusion (effort ${config.effort}).`,
  );
  for (const { pass, target } of plan) {
    console.log(`· passe « ${pass.label} » → ${target.provider}/${target.model}, think=${target.thinking || 'défaut'}.`);
  }
  for (const { label, reason } of selection.skipped) {
    console.log(`· passe « ${label} » non lancée : ${reason}.`);
  }
  warnOnClearTextKey(config, plan.map(({ target }) => target));

  // Une seule fois, et seulement quand ça change quelque chose : une graine
  // posée dans le workflow laisserait croire à une review reproductible partout.
  if (config.seed !== undefined) {
    const ignoring = [...new Set(plan.map(({ target }) => target.provider))].filter(
      (provider) => PROVIDERS[provider]?.supportsSeed === false,
    );
    if (ignoring.length > 0) {
      console.warn(
        `⚠ « seed » n'est pas transmis à ${ignoring.join(', ')} : ce paramètre n'y est pas\n` +
          '  documenté. Ces passes varieront d\u2019une exécution à l\u2019autre.',
      );
    }
  }

  if (config.countOnly) {
    countOnly(config, plan, context);
    return;
  }

  if (plan.length === 0) {
    // Aucune passe lançable, et ce n'est pas une panne : chacune a sa raison,
    // et la taire laisserait une PR non relue passer pour une PR irréprochable.
    const reason = selection.skipped.map(({ label, reason: why }) => `« ${label} » : ${why}`).join(' ; ');
    console.error(`Échec de la review : aucune passe lançable (${reason}).`);
    await report.settle('failure', `aucune passe lançable : ${reason}`, renderFailureComment(reason, config.model));
    return;
  }

  await report.announce(plan.map(({ pass }) => pass.label));

  const started = Date.now();
  const run: Run = { calls: [], failures: [] };
  const outcomes = await runPasses(config, run, plan);

  const targets = [...new Set(plan.map(({ target }) => `${target.provider}/${target.model}`))];

  if (outcomes.length === 0) {
    const reason = run.failures[0] ?? 'raison inconnue';
    console.error(`Échec de la review : aucune passe n'a abouti (${reason}).`);
    await report.settle(
      'failure',
      `aucune passe n'a abouti : ${reason}`,
      renderFailureComment(reason, targets.join(', ') || config.model),
    );
    return;
  }

  const mergeTarget = resolveTarget(config, 'merge', 'fusion', (message) =>
    console.warn(`⚠ ${message}`),
  );
  if (mergeTarget === null) {
    // Les lectures sont déjà payées : elles seront rendues brutes plutôt que
    // jetées parce que le tri n'a nulle part où tourner.
    const reason = `aucune clé pour « ${config.passConfigs.merge.provider} »`;
    console.error(`✗ fusion : ${reason}`);
    run.failures.push(reason);
  }

  const merged =
    mergeTarget === null
      ? null
      : await callModel(config, run, {
          id: 'merge',
          target: mergeTarget,
          messages: [
            {
              role: 'system',
              // Les passes qui ont abouti, pas celles qui étaient prévues :
              // annoncer un relecteur qui n'a rien rendu ferait chercher à la
              // fusion un axe absent.
              content: buildMergeSystemPrompt({
                repo,
                maxFindings: config.maxFindings,
                softSections: config.softSections,
                passes: outcomes.map((outcome) => outcome.pass),
              }),
            },
            { role: 'user', content: buildMergeUserPrompt(meta, outcomes) },
          ],
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
      models: describeTargets(run.calls.filter((call) => call.ok)),
      durationMs: Date.now() - started,
      ...totals(run.calls),
      skipped: context.skipped,
      omitted: context.omitted,
      windowed: context.windowed,
      imported: context.imported.length,
      effort: config.effort,
      // Ce que le cran a retiré, nommément. Le pied de page promet de déclarer
      // toute coupe ; taire à quelles passes les imports ont manqué laisserait
      // le lecteur croire que les trois ont jugé sur le même contexte.
      importsWithheld: selection.run
        .filter((pass) => !pass.imports[config.effort])
        .map((pass) => pass.label),
      // Les passes lancées qui n'ont pas abouti : un incident. Distinct de
      // celles qu'on n'a pas lancées, qui est une décision.
      failedPasses: selection.run
        .filter((pass) => !outcomes.some((outcome) => outcome.pass === pass))
        .map((pass) => pass.label),
      skippedPasses: selection.skipped,
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

  // Une ligne, greppable dans un journal de CI comme en local.
  //
  // Les trouvailles brutes n'y sont QU'EN LOCAL. La passe « données et accès »
  // cherche des secrets, et une trouvaille qui en cite un le recopierait dans
  // le journal d'un runner, que la doctrine du dépôt interdit. Comparer deux
  // réglages sur leurs trouvailles est un geste de réglage, qui se fait depuis
  // un poste ; en CI la ligne garde les compteurs, qui ne citent rien.
  console.log(
    statsLine({
      pr: config.pr,
      model: config.model,
      variant: config.variant,
      calls: run.calls,
      blocks: breakdown(plan),
      findings: config.dryRun
        ? Object.fromEntries(outcomes.map((outcome) => [outcome.pass.id, outcome.findings]))
        : {},
    }),
  );

  if (config.dryRun) {
    console.log('\n────────── review (dry-run, non postée) ──────────\n');
    console.log(comment);
    return;
  }

  await report.settle(
    'success',
    merged === null ? 'review rendue, sans fusion' : 'review rendue',
    comment,
  );
  console.log(`Review postée sur la PR #${config.pr}.`);
}

function knownPaths(meta: PrMeta, context: AssembledContext): Set<string> {
  return new Set([
    ...meta.files.map((file) => file.path),
    ...context.imported.map((file) => file.path),
  ]);
}

/**
 * Complète l'environnement avec les clés que 1Password garde, en local.
 *
 * **Avant** `resolveConfig`, et c'est tout l'objet de cette fonction : le mix
 * choisit sa route sur les clés disponibles, et une clé DeepSeek qui n'arrivait
 * qu'après ne pesait sur rien. Le support local de DeepSeek était donc
 * inopérant pour qui range sa clé dans 1Password plutôt que dans son shell,
 * c'est-à-dire pour l'usage que ce dépôt recommande.
 *
 * Les candidats sont les providers qui ont une référence connue, et rien de
 * plus : on ne peut pas savoir lesquels serviront tant que le mix n'a pas
 * choisi, et le mix ne peut pas choisir sans les clés. Deux lectures, pas
 * douze.
 */
async function loadLocalKeys(env: NodeJS.ProcessEnv): Promise<Env> {
  const enriched: Env = { ...env };
  if (process.env.GITHUB_ACTIONS === 'true') return enriched;

  for (const provider of Object.keys(DEFAULT_KEY_REFS)) {
    const variable = `${provider.toUpperCase()}_API_KEY`;
    // Ni l'input ni l'environnement n'ont la clé : c'est le seul cas où aller
    // la chercher se justifie.
    if (readInput(enriched, `${provider}-api-key`) || enriched[variable]?.trim()) continue;
    const key = await keyFrom1Password(provider);
    if (key) enriched[variable] = key;
  }
  return enriched;
}

async function main(): Promise<void> {
  // Avant tout le reste : ni PR lue, ni clé cherchée, ni token dépensé. Le job
  // reste vert, et le log dit pourquoi il n'y aura pas de commentaire.
  if (!isEnabled(process.env)) {
    console.log('Review désactivée (input « enable »).');
    return;
  }

  // Lu sur argv brut, avant toute résolution : ce drapeau décide s'il faut une
  // clé, et la résolution a besoin des clés. Le poids d'un `includes` contre
  // une lecture 1Password inutile.
  const countOnly = process.argv.slice(2).includes('--count-only');

  const config = resolveConfig({
    argv: process.argv.slice(2),
    env: countOnly ? process.env : await loadLocalKeys(process.env),
    warn: (message) => console.warn(`⚠ ${message}`),
  });

  // `gh` lit son jeton dans l'environnement. Le poser ici plutôt que de le
  // demander au workflow : un dépôt qui branche l'action n'a pas à connaître le
  // nom de la variable qu'attend un CLI qu'il n'appelle pas lui-même.
  if (config.githubToken) process.env.GH_TOKEN = config.githubToken;

  // Avant la garde des clés : conclure une annonce laissée en suspens ne
  // demande aucun provider, et l'exiger rendrait le nettoyage impossible
  // précisément quand il sert — un run tué avant d'avoir rien appelé.
  if (config.mode === 'abort') {
    await abort(config);
    return;
  }

  // `--count-only` n'appelle rien : exiger une clé pour compter des caractères
  // interdirait de mesurer depuis un poste sans 1Password, ou depuis la CI.
  if (!config.countOnly) {
    // SEULEMENT les providers que cette review va solliciter. Une clé qui
    // traîne dans l'environnement pour un tout autre usage — un
    // `OPENAI_API_KEY` posé pour un autre outil — ne doit pas empêcher le
    // silence promis à une PR venue d'un fork, qui poserait alors un
    // commentaire d'échec là où rien n'était attendu.
    const wanted = new Set(Object.values(config.passConfigs).map((target) => target.provider));
    wanted.add(config.provider);

    if ([...wanted].every((provider) => !config.keys[provider])) {
      // Cas nominal d'une PR venue d'un fork : GitHub n'y expose pas les
      // secrets. Rien à commenter, rien à faire échouer.
      console.log('Aucune clé de provider : review ignorée.');
      return;
    }
  }

  try {
    await review(config);
  } catch (error) {
    // Le programme sort en 0 quoi qu'il arrive (cf. l'en-tête), mais une panne
    // inattendue laisserait derrière elle le « pending » posé au démarrage — et
    // un pending requis bloque le merge pour toujours. L'étape « abort » du
    // workflow ne rattrape pas ce cas : elle ne tourne que sur job annulé ou en
    // échec, et celui-ci sort vert.
    await abort(config, 'panne inattendue').catch(() => {});
    throw error;
  }
}

main().catch((error: unknown) => {
  // Dernier filet : même une erreur inattendue (gh absent, PR introuvable) ne
  // doit pas rougir le check. Seule l'erreur d'invocation fait exception.
  console.error(`Review interrompue : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof UsageError ? 1 : 0;
});
