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
  /**
   * Où l'appel est parti, et sur quel modèle.
   *
   * Rapportés par appel et non une fois pour la review : depuis le mix, deux
   * passes n'ont plus le même coût par token, et un total qui ne dirait pas
   * d'où viennent ses tokens ne permettrait plus de décider quoi couper.
   */
  provider: string;
  model: string;
  /** Niveau de raisonnement effectivement demandé. Vide : celui du modèle. */
  think: string;
  /**
   * Le préambule commun ET l'objectif de la passe.
   *
   * Nommé d'après ce que c'est et non d'après le rôle du message qui le porte :
   * depuis que l'objectif est rendu en dernier message user, pour que le
   * préfixe reste partageable, un champ « systemChars » aurait désigné la
   * moitié de la consigne.
   */
  instructionChars: number;
  /** Le bloc partagé : PR, diff, fichiers, imports. */
  contextChars: number;
  inputTokens: number;
  /** Part de l'entrée servie depuis le cache. `0` : aucun, ou non exposé. */
  cachedInputTokens: number;
  outputTokens: number;
  /** Part de la sortie passée en raisonnement. `0` : non exposé. */
  reasoningTokens: number;
  thinkingChars: number;
  /** Taille de la réponse hors raisonnement. Sert à situer `thinkingChars`. */
  contentChars: number;
  durationMs: number;
  /** Coût estimé en dollars, ou `null` quand le tarif n'est pas connu. */
  costUsd: number | null;
  ok: boolean;
}

/**
 * Combien de caractères pour un token, en moyenne, sur du code et de la prose.
 *
 * Grossier et assumé : embarquer un tokenizer coûterait la seule promesse que
 * le bundle tient sans effort, celle de n'avoir aucune dépendance d'exécution.
 * La valeur se recalibre en divisant
 * `instructionChars + contextChars` par le
 * `promptTokens` d'un vrai run, que le journal imprime côte à côte exprès.
 */
export const CHARS_PER_TOKEN = 3.5;

export const estimateTokens = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN);

const count = (value: number) => value.toLocaleString('fr-FR');

export interface Totals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingChars: number;
  /** Somme des coûts connus. */
  costUsd: number;
  /**
   * Un appel au moins n'a pas de tarif connu.
   *
   * Le dire plutôt que l'additionner à zéro : un quota Ollama consommé n'est
   * pas un appel gratuit, et un total qui l'ignorerait mentirait sur ce qu'il
   * additionne.
   */
  costPartial: boolean;
}

/** Les sommes que le pied de page rapporte. Les appels ratés ne comptent pas. */
export function totals(calls: CallStat[]): Totals {
  return calls.reduce<Totals>(
    (sum, call) => ({
      inputTokens: sum.inputTokens + call.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + call.cachedInputTokens,
      outputTokens: sum.outputTokens + call.outputTokens,
      thinkingChars: sum.thinkingChars + call.thinkingChars,
      costUsd: sum.costUsd + (call.costUsd ?? 0),
      // Un appel raté n'a rien coûté qu'on sache chiffrer, mais il a bien été
      // envoyé : ne pas le compter comme un trou de tarification.
      costPartial: sum.costPartial || (call.ok && call.costUsd === null),
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      thinkingChars: 0,
      costUsd: 0,
      costPartial: false,
    },
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

/**
 * Un montant en dollars, avec assez de décimales pour ne pas s'afficher à zéro.
 *
 * Une passe sur DeepSeek coûte quelques centièmes de dollar : arrondir au cent
 * afficherait « 0,01 $ » partout et rendrait invisible le facteur trente que le
 * cache fait gagner, qui est précisément ce qu'on cherche à voir.
 */
export const formatCost = (usd: number): string =>
  `${usd.toLocaleString('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} $`;

/** La ligne de journal d'un appel abouti. */
export function describeCall(call: CallStat): string {
  const share = reasoningShare(call);
  const reasoning =
    call.reasoningTokens > 0
      ? ` dont ${count(call.reasoningTokens)} de raisonnement`
      : share === null
        ? ''
        : ` dont ~${Math.round(share * 100)} % de raisonnement`;
  const think = call.think ? `, think=${call.think}` : '';
  const cached = call.cachedInputTokens > 0 ? ` dont ${count(call.cachedInputTokens)} en cache` : '';
  const cost = call.costUsd === null ? '' : `, ~${formatCost(call.costUsd)}`;
  return (
    `${call.label} en ${Math.round(call.durationMs / 1000)} s · ${call.provider}/${call.model} ` +
    `(${count(call.inputTokens)} tokens en entrée${cached}, ` +
    `${count(call.outputTokens)} en sortie${reasoning}${think}${cost}).`
  );
}

/**
 * Ce qui a tourné, et où : « ollama/glm-5.2:cloud (régression) · … ».
 *
 * Le pied de page annonçait un modèle unique. Depuis que les quatre appels
 * peuvent viser des destinations différentes, un seul nom serait faux pour
 * trois d'entre eux, et le lecteur d'une PR n'aurait aucun moyen de savoir quel
 * modèle a produit la trouvaille qu'il lit.
 */
export function describeTargets(calls: CallStat[]): string {
  const byTarget = new Map<string, string[]>();
  for (const call of calls) {
    const key = `${call.provider}/${call.model}`;
    const labels = byTarget.get(key);
    if (labels) labels.push(call.label);
    else byTarget.set(key, [call.label]);
  }
  return [...byTarget]
    .map(([target, labels]) => `${target} (${labels.join(', ')})`)
    .join(' · ');
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
  const targets = calls.map((call) => `${call.provider}/${call.model}`);
  const width = Math.max(...labels.map((label) => label.length), 'appel'.length);
  const target = Math.max(...targets.map((value) => value.length), 'destination'.length);
  const priced = calls.some((call) => call.costUsd !== null);

  const rows = calls.map((call, index) => {
    const total = call.instructionChars + call.contextChars;
    const cost = call.costUsd === null ? '—' : `~${formatCost(call.costUsd)}`;
    return (
      `  ${pad(call.label, width)}  ${pad(targets[index]!, target)}  ` +
      `${padStart(count(call.instructionChars), 9)}  ` +
      `${padStart(count(call.contextChars), 10)}  ${padStart(count(total), 10)}  ` +
      `${padStart(`~${count(estimateTokens(total))}`, 10)}` +
      (priced ? `  ${padStart(cost, 12)}` : '')
    );
  });

  const grand = calls.reduce((sum, call) => sum + call.instructionChars + call.contextChars, 0);
  const grandCost = calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
  const header =
    `  ${pad('appel', width)}  ${pad('destination', target)}  ${padStart('consignes', 9)}  ` +
    `${padStart('contexte', 10)}  ${padStart('total', 10)}  ${padStart('≈ tokens', 10)}` +
    (priced ? `  ${padStart('≈ entrée', 12)}` : '');
  const rule = `  ${'─'.repeat(width + target + 48 + (priced ? 14 : 0))}`;

  return [
    header,
    ...rows,
    rule,
    `  ${pad('total entrée', width)}  ${pad('', target)}  ${padStart('', 9)}  ${padStart('', 10)}  ` +
      `${padStart(count(grand), 10)}  ${padStart(`~${count(estimateTokens(grand))}`, 10)}` +
      (priced ? `  ${padStart(`~${formatCost(grandCost)}`, 12)}` : ''),
    `  dont : ${describeBlocks(blocks)}`,
    '',
    '  Tokens estimés : caractères ÷ ' + CHARS_PER_TOKEN + '. Les caractères, eux, sont exacts.',
    ...(priced
      ? [
          "  Coût : ENTRÉE seule, au tarif plein, sans cache. La sortie n'est pas devinable\n" +
            '  avant l’appel, et le cache ne se constate qu’après.',
        ]
      : []),
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
