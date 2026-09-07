// @vitest-environment node
//
// Comme pour Ollama et le client OpenAI-compatible : ce module ne parle que
// HTTP, et un environnement DOM substituerait son propre `fetch`.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PROVIDERS } from '../../src/llm';
import type { Downgrade } from '../../src/llm/types';

/**
 * Ce qui est propre à Bedrock et n'a pas d'équivalent chez DeepSeek : la
 * signature SigV4 en en-têtes plutôt qu'un `Bearer`, et un endpoint qui ne
 * rend jamais son raisonnement à part (`emptyMeansReasoning`).
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
let lastPath = '';
let lastAuthorization = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      calls += 1;
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      lastPath = req.url ?? '';
      lastAuthorization = req.headers.authorization ?? '';
      const next = queue.shift() ?? { status: 500, body: 'aucune réponse programmée' };
      res.statusCode = next.status;
      res.setHeader('content-type', next.status === 200 ? 'text/event-stream' : 'application/json');
      res.end(next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queue = [];
  calls = 0;
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

const call = (over: Partial<Parameters<(typeof PROVIDERS)['aws']['client']>[0]> = {}) =>
  PROVIDERS.aws!.client({
    apiKey: '',
    baseUrl,
    model: 'zai.glm-5',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ],
    retryDelayMs: 1,
    aws: {
      region: 'eu-north-1',
      credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'secret-de-test' },
    },
    ...over,
  });

describe('la signature de la requête', () => {
  it('signe avec AWS4-HMAC-SHA256 et vise /chat/completions', async () => {
    queue.push({ status: 200, body: ok() });
    await call();
    expect(lastAuthorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(lastPath.endsWith('/chat/completions')).toBe(true);
  });
});

describe('la lecture du flux', () => {
  it('agrège le contenu et l’usage d’un flux SSE valide', async () => {
    queue.push({ status: 200, body: ok('## Trouvailles\n- rien à signaler') });
    const result = await call();
    expect(result.content).toBe('## Trouvailles\n- rien à signaler');
    expect(result.usage.inputTokens).toBe(92_104);
    expect(result.usage.outputTokens).toBe(8_210);
  });
});

/**
 * Le point qui compte le plus : cet endpoint ne rend JAMAIS son raisonnement à
 * part, même à `reasoning_effort: high` (mesuré). Sans `emptyMeansReasoning`,
 * un vide qui a bel et bien consommé des tokens de sortie ne se distinguerait
 * pas d'un vide sans aucune cause, et le repli de `withRetries` ne se
 * déclencherait jamais chez ce provider.
 */
describe('un raisonnement qui ne rend jamais son texte', () => {
  it('marque reasoningExhausted sans `reasoning_content`, dès que la sortie n’est pas vide', async () => {
    queue.push({
      status: 200,
      body: sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, usage({ completion_tokens: 4_096 })),
    });
    queue.push({ status: 200, body: ok('repli') });
    const downgrades: Downgrade[] = [];
    const result = await call({ think: 'high', onDowngrade: (event) => downgrades.push(event) });
    expect(result.content).toBe('repli');
    expect(calls).toBe(2);
    expect(downgrades[0]?.cause).toBe('reasoning-exhausted');
  });

  it('ne rejoue pas un vide qui n’a produit aucun token de sortie', async () => {
    queue.push({
      status: 200,
      body: sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, usage({ completion_tokens: 0 })),
    });
    await expect(call({ think: 'high' })).rejects.toThrow(/vide/);
    expect(calls).toBe(1);
  });
});

/** Mesuré sur les trois modèles : une valeur refusée rend ce message exact. */
describe('un niveau de raisonnement refusé', () => {
  it('reconnaît « <param> value <x> is not supported », pas seulement le tour d’Ollama', async () => {
    queue.push({
      status: 400,
      body: `{"error":"'reasoning_effort' value 'max' is not supported by this model"}`,
    });
    queue.push({ status: 200, body: ok() });
    const downgrades: Downgrade[] = [];
    const result = await call({ think: 'nawak', onDowngrade: (event) => downgrades.push(event) });
    expect(result.content).toBe('trouvailles');
    expect(calls).toBe(2);
    // Mal classé, c'était « thinking-unsupported » : le journal aurait affirmé
    // que le modèle ne sait pas raisonner, alors que seul le niveau est mauvais.
    expect(downgrades[0]?.cause).toBe('level-rejected');
    expect(lastBody.reasoning_effort).toBeUndefined();
  });
});

/**
 * Mesuré sur les trois modèles à `reasoning_effort: high` (jamais à `low` ni
 * sans le paramètre) : la chaîne de pensée fuit dans `content`, entre balises
 * `<reasoning>` ouvertes et refermées au milieu des phrases. Sur un run réel,
 * 33 664 caractères de raisonnement anglais sont partis comme review.
 */
describe('les balises <reasoning> dans le contenu', () => {
  it('les retire même coupées entre deux fragments SSE, et compte le raisonnement', async () => {
    queue.push({
      status: 200,
      body: sse(
        text('<reason'),
        text('ing>je réfléchis</reasoning>## Trouvailles\n- rien à signaler'),
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        usage(),
      ),
    });
    const result = await call({ think: 'high' });
    expect(result.content).toBe('## Trouvailles\n- rien à signaler');
    expect(result.thinkingChars).toBe('je réfléchis'.length);
  });

  it('bascule un <reasoning> jamais refermé dans thinking, et replie plutôt que de le poster', async () => {
    queue.push({
      status: 200,
      body: sse(
        text('<reasoning>je réfléchis sans jamais conclure'),
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        usage({ completion_tokens: 4_096 }),
      ),
    });
    queue.push({ status: 200, body: ok('## Trouvailles\n- repli') });
    const downgrades: Downgrade[] = [];
    const result = await call({ think: 'high', onDowngrade: (event) => downgrades.push(event) });
    expect(result.content).toBe('## Trouvailles\n- repli');
    expect(calls).toBe(2);
    expect(downgrades[0]?.cause).toBe('reasoning-exhausted');
  });
});

/** Mesuré sur les trois modèles : `max` seul rend ce 400, `high` non. */
describe('un niveau que ce dialecte ne connaît pas sous son nom générique', () => {
  it('traduit « max » en « high », le vrai plafond disponible', async () => {
    queue.push({ status: 200, body: ok() });
    await call({ think: 'max' });
    expect(lastBody.reasoning_effort).toBe('high');
  });
});
