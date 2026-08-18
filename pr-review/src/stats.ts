/**
 * Ce que les appels au modèle ont coûté, et comment le dire. Module **pur**.
 *
 * Le pied de page rapportait déjà un total ; il ne disait pas d'où il venait.
 * Or les leviers d'économie ne se jugent pas sur un total : baisser le contexte
 * d'une passe et baisser son raisonnement produisent le même total en baisse et
 * demandent des décisions opposées. D'où un relevé par appel.
 *
 * Deux mesures ne sont PAS du même ordre, et le module s'interdit de les
 * confondre :
 *
 * - les **caractères** sont exacts, comptés ici même ;
 * - les **tokens** viennent d'Ollama quand un appel a eu lieu, et d'une simple
 *   division quand il n'y en a pas eu (`--count-only`). Une estimation est
 *   toujours annoncée comme telle, jamais rendue au même format qu'une mesure.
 */

/** Ce qu'un appel au modèle a consommé. Un par passe, plus un pour la fusion. */
export interface CallStat {
  /** Stable à travers un renommage d'étiquette : « regression », « merge »… */
  id: string;
  /** Nom français, celui du journal et du pied de page. */
  label: string;
  /** Niveau de raisonnement effectivement demandé. Vide : celui du modèle. */
  think: string;
  systemChars: number;
  userChars: number;
  promptTokens: number;
  evalTokens: number;
  thinkingChars: number;
  /** Taille de la réponse hors raisonnement. Sert à situer `thinkingChars`. */
  contentChars: number;
  durationMs: number;
  ok: boolean;
}

/**
 * Combien de caractères pour un token, en moyenne, sur du code et de la prose.
 *
 * Grossier et assumé : embarquer un tokenizer coûterait la seule promesse que
 * le bundle tient sans effort, celle de n'avoir aucune dépendance d'exécution.
 * La valeur se recalibre en divisant `systemChars + userChars` par le
 * `promptTokens` d'un vrai run, que le journal imprime côte à côte exprès.
 */
export const CHARS_PER_TOKEN = 3.5;

export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

const count = (value: number) => value.toLocaleString('fr-FR');

export interface Totals {
  promptTokens: number;
  evalTokens: number;
  thinkingChars: number;
}

/** Les sommes que le pied de page rapporte. Les appels ratés ne comptent pas. */
export function totals(calls: CallStat[]): Totals {
  return calls.reduce<Totals>(
    (sum, call) => ({
      promptTokens: sum.promptTokens + call.promptTokens,
      evalTokens: sum.evalTokens + call.evalTokens,
      thinkingChars: sum.thinkingChars + call.thinkingChars,
    }),
    { promptTokens: 0, evalTokens: 0, thinkingChars: 0 },
  );
}

/**
 * Part de raisonnement dans la sortie, **déduite** et non mesurée.
 *
 * Ollama ne sépare pas le raisonnement dans `eval_count` : le seul rapport
 * disponible est celui des tailles en caractères. Il suffit à répondre à la
 * seule question qu'on lui pose, « baisser `think` a-t-il coupé la sortie »,
 * et il ne prétend à rien de plus. `null` quand le modèle mêle son raisonnement
 * à sa réponse, auquel cas il n'y a rien à déduire.
 */
export function reasoningShare(call: CallStat): number | null {
  const total = call.thinkingChars + call.contentChars;
  if (call.thinkingChars === 0 || total === 0) return null;
  return call.thinkingChars / total;
}

/** La ligne de journal d'un appel abouti. */
export function describeCall(call: CallStat): string {
  const share = reasoningShare(call);
  const reasoning = share === null ? '' : ` dont ~${Math.round(share * 100)} % de raisonnement`;
  const think = call.think ? `, think=${call.think}` : '';
  return (
    `${call.label} en ${Math.round(call.durationMs / 1000)} s ` +
    `(${count(call.promptTokens)} tokens en entrée, ${count(call.evalTokens)} en sortie${reasoning}${think}).`
  );
}

/**
 * Les blocs qui composent l'entrée d'un appel, en caractères.
 *
 * C'est la ventilation qui décide où couper : un fenêtrage des fichiers touchés
 * ne vaut son effort que s'ils pèsent réellement la moitié de l'entrée, ce qu'on
 * ne peut pas deviner et qui change d'un dépôt à l'autre.
 */
export interface InputBreakdown {
  system: number;
  diff: number;
  /** Contenu des fichiers modifiés par la PR. */
  touched: number;
  /** Contenu des fichiers joints parce qu'un fichier touché les importe. */
  imported: number;
  /** Le reste du prompt : titre, description, liste des fichiers, consignes. */
  meta: number;
}

const pad = (text: string, width: number) => text.padEnd(width);
const padStart = (text: string, width: number) => text.padStart(width);

/**
 * Le tableau de `--count-only`.
 *
 * Aligné à la main plutôt que par une dépendance : quatre lignes de colonnes ne
 * valent pas un paquet, et le journal d'un runner n'a pas de rendu de tableau.
 */
export function renderBreakdown(calls: CallStat[], blocks: InputBreakdown): string {
  const labels = calls.map((call) => call.label);
  const width = Math.max(...labels.map((label) => label.length), 'appel'.length);

  const rows = calls.map((call) => {
    const total = call.systemChars + call.userChars;
    return (
      `  ${pad(call.label, width)}  ${padStart(count(call.systemChars), 9)}  ` +
      `${padStart(count(call.userChars), 10)}  ${padStart(count(total), 10)}  ` +
      `${padStart(`~${count(estimateTokens(total))}`, 10)}`
    );
  });

  const grand = calls.reduce((sum, call) => sum + call.systemChars + call.userChars, 0);
  const header =
    `  ${pad('appel', width)}  ${padStart('système', 9)}  ${padStart('user', 10)}  ` +
    `${padStart('total', 10)}  ${padStart('≈ tokens', 10)}`;
  const rule = `  ${'─'.repeat(width + 46)}`;

  return [
    header,
    ...rows,
    rule,
    `  ${pad('total entrée', width)}  ${padStart('', 9)}  ${padStart('', 10)}  ` +
      `${padStart(count(grand), 10)}  ${padStart(`~${count(estimateTokens(grand))}`, 10)}`,
    `  dont : ${describeBlocks(blocks)}`,
    '',
    '  Tokens estimés : caractères ÷ ' + CHARS_PER_TOKEN + '. Les caractères, eux, sont exacts.',
  ].join('\n');
}

/**
 * La part de chaque bloc, sur UN prompt et non sur leur somme.
 *
 * Sur la somme, un bloc envoyé à une seule passe paraîtrait trois fois plus
 * petit qu'il n'est pour celle qui le reçoit, et on couperait au mauvais endroit.
 */
function describeBlocks(blocks: InputBreakdown): string {
  const total = blocks.system + blocks.diff + blocks.touched + blocks.imported + blocks.meta;
  if (total === 0) return 'rien';
  const share = (value: number) => `${Math.round((value / total) * 100)} %`;
  return [
    `diff ${share(blocks.diff)}`,
    `fichiers touchés ${share(blocks.touched)}`,
    `imports ${share(blocks.imported)}`,
    `système ${share(blocks.system)}`,
    `reste ${share(blocks.meta)}`,
  ].join(' · ');
}

export interface StatsPayload {
  pr: number;
  model: string;
  /** Nom libre du bras mesuré, pour comparer deux exécutions. */
  variant: string;
  calls: CallStat[];
  blocks: InputBreakdown;
  /** Trouvailles brutes par passe : la seule mesure de qualité qui compte. */
  findings: Record<string, string>;
}

/**
 * Une ligne préfixée, greppable dans un journal de CI comme en local.
 *
 * Les trouvailles brutes y sont, et pas seulement les compteurs : comparer deux
 * réglages sur leurs tokens dit lequel est le moins cher, jamais lequel a perdu
 * une trouvaille. C'est pourtant la seule question qui puisse annuler un levier.
 */
export const statsLine = (payload: StatsPayload): string => `::stats::${JSON.stringify(payload)}`;
