// @vitest-environment node
//
// Explicite, comme pour Ollama : ce module n'existe que pour parler HTTP, et un
// environnement DOM substituerait son propre `fetch`, qui ne rend pas les mêmes
// erreurs d'abandon que celui de Node.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createOpenAiClient } from '../../src/llm/openai';
import { LlmError, type Downgrade } from '../../src/llm/types';

/**
 * Ce qui se teste ici et qui n'a pas d'équivalent côté Ollama :
 *
 * - `stream_options: { include_usage: true }`, sans quoi AUCUN compteur
 *   n'arrive en streaming et toute l'instrumentation mesure zéro ;
 * - la lecture du cache dans les deux conventions concurrentes, aucune n'étant
 *   standard ;
 * - le refus d'une réponse coupée au plafond de sortie, que rien dans le texte
 *   ne signale.
 */

interface Scripted {
  status: number;
  body: string;
}

let server: Server;
let baseUrl = '';
let queue: Scripted[] = [];
let calls = 0;
let lastBody: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      calls += 1;
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      const next = queue.shift() ?? { status: 500, body: 'aucune réponse programmée' };
      res.statusCode = next.status;
      res.setHeader('content-type', next.status === 200 ? 'text/event-stream' : 'application/json');
      res.end(next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queue = [];
  calls = 0;
});

const deepseek = createOpenAiClient({
  name: 'DeepSeek',
  thinkingOff: { thinking: { type: 'disabled' } },
});

const sse = (...chunks: unknown[]) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;

const text = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] });

const usage = (over: Record<string, unknown> = {}) => ({
  choices: [],
  usage: { prompt_tokens: 92_104, completion_tokens: 8_210, ...over },
});

const ok = (content = 'trouvailles') =>
  sse(text(content), { choices: [{ delta: {}, finish_reason: 'stop' }] }, usage());

const call = (over: Partial<Parameters<typeof deepseek>[0]> = {}) =>
  deepseek({
    apiKey: 'faux',
    baseUrl,
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ],
    retryDelayMs: 1,
    ...over,
  });

describe('la requête', () => {
  it('demande l’usage avec le flux, sans quoi aucun compteur n’arrive', async () => {
    queue.push({ status: 200, body: ok() });
    await call();
    expect(lastBody.stream).toBe(true);
    expect(lastBody.stream_options).toEqual({ include_usage: true });
  });

  it('transmet le niveau de raisonnement demandé', async () => {
    queue.push({ status: 200, body: ok() });
    await call({ think: 'high' });
    expect(lastBody.reasoning_effort).toBe('high');
  });

  it('coupe le raisonnement par le champ propre au dialecte, pas par un niveau', async () => {
    queue.push({ status: 200, body: ok() });
    await call({ think: 'off' });
    expect(lastBody.reasoning_effort).toBeUndefined();
    expect(lastBody.thinking).toEqual({ type: 'disabled' });
  });

  /** Un booléen vrai demande « raisonne », pas « raisonne à tel point ». */
  it('laisse son défaut au modèle quand on demande juste « true »', async () => {
    queue.push({ status: 200, body: ok() });
    await call({ think: 'true' });
    expect(lastBody.reasoning_effort).toBeUndefined();
    expect(lastBody.thinking).toBeUndefined();
  });

  /**
   * `seed` n'est documenté chez aucun des dialectes visés, et un paramètre
   * inconnu se paie d'un 400 sur les serveurs stricts. L'appelant prévient, ce
   * qui vaut mieux qu'une review perdue pour un gage de reproductibilité.
   */
  it('n’envoie pas la graine, que ce dialecte ne documente pas', async () => {
    queue.push({ status: 200, body: ok() });
    await call({ seed: 1 });
    expect(lastBody.seed).toBeUndefined();
    expect(lastBody.temperature).toBe(1);
  });
});

describe('la lecture du flux', () => {
  it('agrège le texte et le raisonnement, chacun de son côté', async () => {
    queue.push({
      status: 200,
      body: sse(
        { choices: [{ delta: { reasoning_content: 'je réfléchis' } }] },
        text('## Trouv'),
        text('ailles'),
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        usage(),
      ),
    });
    const result = await call();
    expect(result.content).toBe('## Trouvailles');
    expect(result.thinkingChars).toBe('je réfléchis'.length);
  });

  it('ignore les lignes SSE qui ne portent pas de données', async () => {
    queue.push({
      status: 200,
      body: `: ping\nevent: message\n${sse(text('ok'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, usage())}`,
    });
    expect((await call()).content).toBe('ok');
  });

  it('lit le cache de DeepSeek', async () => {
    queue.push({
      status: 200,
      body: sse(
        text('ok'),
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        usage({ prompt_cache_hit_tokens: 92_032, completion_tokens_details: { reasoning_tokens: 6_480 } }),
      ),
    });
    const result = await call();
    expect(result.usage.inputTokens).toBe(92_104);
    expect(result.usage.cachedInputTokens).toBe(92_032);
    expect(result.usage.reasoningTokens).toBe(6_480);
  });

  /** Aucune des deux conventions n'est standard : le client lit les deux. */
  it('lit aussi le cache à la convention OpenAI', async () => {
    queue.push({
      status: 200,
      body: sse(
        text('ok'),
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        usage({ prompt_tokens_details: { cached_tokens: 4_096 } }),
      ),
    });
    expect((await call()).usage.cachedInputTokens).toBe(4_096);
  });

  /**
   * Un provider qui n'honore pas `include_usage` ne doit pas coûter une review
   * déjà payée : les compteurs restent muets, la lecture est rendue.
   */
  it('rend la réponse même sans usage, plutôt que de perdre la lecture', async () => {
    queue.push({
      status: 200,
      body: sse(text('ok'), { choices: [{ delta: {}, finish_reason: 'stop' }] }),
    });
    const result = await call();
    expect(result.content).toBe('ok');
    expect(result.usage.inputTokens).toBe(0);
  });
});

describe('les réponses inexploitables', () => {
  it('refuse un flux interrompu plutôt que de poster une review tronquée', async () => {
    queue.push({ status: 200, body: `data: ${JSON.stringify(text('début de rev'))}\n\n` });
    queue.push({ status: 200, body: `data: ${JSON.stringify(text('début de rev'))}\n\n` });
    await expect(call()).rejects.toThrow(/interrompu/);
  });

  /**
   * Le pire des cas : la réponse est bien formée, elle est simplement amputée,
   * et rien dans son texte ne le dit. Postée telle quelle, elle aurait l'aplomb
   * d'une review entière.
   */
  it('refuse une réponse coupée au plafond de tokens de sortie', async () => {
    queue.push({
      status: 200,
      body: sse(text('la moitié'), { choices: [{ delta: {}, finish_reason: 'length' }] }, usage()),
    });
    await expect(call()).rejects.toThrow(/plafond/);
    expect(calls).toBe(1);
  });

  it('refuse une réponse vide, quand tout est parti dans le raisonnement', async () => {
    queue.push({
      status: 200,
      body: sse(
        { choices: [{ delta: { reasoning_content: 'et puis rien' }, finish_reason: 'stop' }] },
        usage(),
      ),
    });
    await expect(call()).rejects.toThrow(/vide/);
  });

  it('borne la sortie quand le dépôt a écrit un plafond, et pas autrement', async () => {
    queue.push({ status: 200, body: ok() });
    await call({});
    expect(lastBody).not.toHaveProperty('max_tokens');
    queue.push({ status: 200, body: ok() });
    await call({ maxOutputTokens: 32_000 });
    expect(lastBody.max_tokens).toBe(32_000);
  });

  it('remonte une erreur applicative arrivée en 200', async () => {
    queue.push({ status: 200, body: `data: ${JSON.stringify({ error: { message: 'quota' } })}\n\n` });
    await expect(call()).rejects.toThrow(/quota/);
  });
});

describe('la politique de reprise', () => {
  it('reprend une fois après un 429', async () => {
    queue.push({ status: 429, body: '{"error":{"message":"rate limit"}}' });
    queue.push({ status: 200, body: ok() });
    expect((await call()).content).toBe('trouvailles');
    expect(calls).toBe(2);
  });

  it('ne reprend pas un 401 : la clé ne deviendra pas valide', async () => {
    queue.push({ status: 401, body: '{"error":{"message":"nope"}}' });
    await expect(call()).rejects.toThrow(LlmError);
    expect(calls).toBe(1);
  });

  /** Un crédit épuisé se lit dans le journal, il ne se répare pas en insistant. */
  it('nomme un 402 plutôt que de le laisser en code nu', async () => {
    queue.push({ status: 402, body: '{"error":{"message":"Insufficient Balance"}}' });
    await expect(call()).rejects.toThrow(/crédit épuisé/);
  });

  it('rejoue sans raisonnement quand le modèle refuse le paramètre', async () => {
    queue.push({ status: 400, body: '{"error":{"message":"reasoning_effort not supported"}}' });
    queue.push({ status: 200, body: ok() });
    const downgrades: Downgrade[] = [];
    await call({ think: 'max', onDowngrade: (event) => downgrades.push(event) });
    expect(calls).toBe(2);
    expect(downgrades).toEqual([
      { cause: 'thinking-unsupported', from: 'max', to: '', reason: expect.any(String) },
    ]);
    expect(lastBody.reasoning_effort).toBeUndefined();
  });

  /**
   * Le pendant du « invalid think value » d'Ollama, jamais couvert ici alors
   * que `rejectsThinkingValue` teste explicitement les deux mots. Une coquille
   * dans un input ne doit coûter que le niveau, pas la profondeur d'analyse.
   */
  it('garde le raisonnement quand seul le niveau est fautif', async () => {
    queue.push({ status: 400, body: '{"error":{"message":"invalid reasoning_effort value: nawak"}}' });
    queue.push({ status: 200, body: ok() });
    const downgrades: Downgrade[] = [];
    await call({ think: 'nawak', onDowngrade: (event) => downgrades.push(event) });
    expect(calls).toBe(2);
    expect(downgrades[0]?.cause).toBe('level-rejected');
    // `true` côté requête veut dire « le défaut du modèle » : `reasoningBody`
    // n'envoie alors aucun champ, plutôt qu'un niveau inventé.
    expect(lastBody.reasoning_effort).toBeUndefined();
  });

  /**
   * Le 4e drapeau de `LlmError` est bien posé par ce client depuis toujours,
   * mais rien ne vérifiait qu'il déclenchait le repli — le trou était côté
   * OpenAI seulement, la variante Ollama étant couverte.
   */
  it('rejoue sans raisonnement quand tout est parti dans le raisonnement', async () => {
    queue.push({
      status: 200,
      body: sse(
        { choices: [{ delta: { reasoning_content: 'et puis rien' }, finish_reason: 'stop' }] },
        usage(),
      ),
    });
    queue.push({ status: 200, body: ok() });
    const downgrades: Downgrade[] = [];
    const result = await call({ think: 'high', onDowngrade: (event) => downgrades.push(event) });
    expect(result.content).toBe('trouvailles');
    expect(calls).toBe(2);
    expect(downgrades[0]).toMatchObject({ cause: 'reasoning-exhausted', from: 'high', to: '' });
    expect(lastBody.reasoning_effort).toBeUndefined();
  });

  /**
   * L'ordre des gardes, et il n'est pas cosmétique : ce cas-ci était testé
   * comme une troncature AVANT d'être testé comme un vide, donc refusé sans
   * rejeu alors que la passe était encore récupérable. C'est exactement la
   * forme qu'a prise l'incident mesuré sur avolo-shorts#99.
   */
  it('replie un vide coupé au plafond, au lieu de le refuser sèchement', async () => {
    queue.push({
      status: 200,
      body: sse(
        { choices: [{ delta: { reasoning_content: 'sans fin' }, finish_reason: 'length' }] },
        usage(),
      ),
    });
    queue.push({ status: 200, body: ok() });
    const result = await call({ think: 'high' });
    expect(result.content).toBe('trouvailles');
    expect(calls).toBe(2);
  });

  /** Un 400 qui parle d'autre chose ne se rejoue pas : le prompt reste trop long. */
  it('ne rejoue pas un 400 étranger au raisonnement', async () => {
    queue.push({ status: 400, body: '{"error":{"message":"context length exceeded"}}' });
    await expect(call({ think: 'max' })).rejects.toThrow(LlmError);
    expect(calls).toBe(1);
  });
});

/**
 * Le dialecte générique n'a pas de champ pour couper le raisonnement : ne rien
 * envoyer vaut mieux qu'un paramètre inventé, qu'un serveur strict refuserait.
 */
describe('le dialecte générique', () => {
  const generic = createOpenAiClient({ name: 'le provider' });

  it('n’invente pas de champ pour couper un raisonnement qu’il ne sait pas couper', async () => {
    queue.push({ status: 200, body: ok() });
    await generic({
      apiKey: 'faux',
      baseUrl,
      model: 'peu-importe',
      messages: [{ role: 'user', content: 'u' }],
      think: 'off',
      retryDelayMs: 1,
    });
    expect(lastBody.thinking).toBeUndefined();
    expect(lastBody.reasoning_effort).toBeUndefined();
  });
});

/**
 * Le corps d'une erreur n'est pas écrit par nous : un proxy mal réglé renvoie
 * volontiers la requête reçue, en-têtes compris. Ce corps part dans le journal
 * d'un runner, et jusque dans le commentaire posté quand aucune passe n'aboutit.
 */
describe('les secrets ne sortent pas dans un message d’erreur', () => {
  const withKey = (over = {}) =>
    deepseek({
      apiKey: 'sk-secret-a-ne-pas-recopier',
      baseUrl,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'u' }],
      retryDelayMs: 1,
      ...over,
    });

  it('masque la clé qu’un endpoint renverrait dans le corps d’un refus', async () => {
    queue.push({
      status: 400,
      body: '{"error":{"message":"bad request, headers: Authorization: Bearer sk-secret-a-ne-pas-recopier"}}',
    });
    await expect(withKey()).rejects.toThrow(/\*\*\*/);
    queue.push({
      status: 400,
      body: '{"error":{"message":"Authorization: Bearer sk-secret-a-ne-pas-recopier"}}',
    });
    await expect(withKey()).rejects.not.toThrow(/sk-secret-a-ne-pas-recopier/);
  });

  it('masque aussi un jeton tiers, dont on ne connaît pas la valeur', async () => {
    queue.push({ status: 400, body: '{"error":{"message":"upstream sent Bearer tok_du_voisin_123"}}' });
    const error = await withKey().then(
      () => new Error('aurait dû échouer'),
      (caught: Error) => caught,
    );
    expect(error.message).toContain('Bearer ***');
    expect(error.message).not.toContain('tok_du_voisin_123');
  });

  it('masque la clé dans une erreur applicative arrivée en 200', async () => {
    queue.push({
      status: 200,
      body: `data: ${JSON.stringify({ error: { message: 'key sk-secret-a-ne-pas-recopier refused' } })}\n\n`,
    });
    const error = await withKey().then(
      () => new Error('aurait dû échouer'),
      (caught: Error) => caught,
    );
    expect(error.message).not.toContain('sk-secret-a-ne-pas-recopier');
  });
});
