// @vitest-environment node
//
// Same as for Ollama and the OpenAI-compatible client: this module only
// speaks HTTP, and a DOM environment would substitute its own `fetch`.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PROVIDERS } from '../../src/llm';
import type { Downgrade } from '../../src/llm/types';

/**
 * What's specific to Bedrock and has no DeepSeek equivalent: the SigV4
 * signature in headers rather than a `Bearer`, and an endpoint that never
 * returns its reasoning apart (`emptyMeansReasoning`).
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
      const next = queue.shift() ?? { status: 500, body: 'no scripted response' };
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

describe('the request signature', () => {
  it('signs with AWS4-HMAC-SHA256 and targets /chat/completions', async () => {
    queue.push({ status: 200, body: ok() });
    await call();
    expect(lastAuthorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(lastPath.endsWith('/chat/completions')).toBe(true);
  });
});

describe('reading the stream', () => {
  it('aggregates the content and usage of a valid SSE stream', async () => {
    queue.push({ status: 200, body: ok('## Trouvailles\n- rien à signaler') });
    const result = await call();
    expect(result.content).toBe('## Trouvailles\n- rien à signaler');
    expect(result.usage.inputTokens).toBe(92_104);
    expect(result.usage.outputTokens).toBe(8_210);
  });
});

/**
 * The point that matters most: this endpoint NEVER returns its reasoning
 * apart, even at `reasoning_effort: high` (measured). Without
 * `emptyMeansReasoning`, an emptiness that did consume output tokens would
 * be indistinguishable from one with no cause at all, and `withRetries`'s
 * fallback would never fire for this provider.
 */
describe('reasoning that never returns its text', () => {
  it('flags reasoningExhausted without `reasoning_content`, as soon as output isn\'t empty', async () => {
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

  it('does not replay an emptiness that produced no output tokens', async () => {
    queue.push({
      status: 200,
      body: sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }, usage({ completion_tokens: 0 })),
    });
    await expect(call({ think: 'high' })).rejects.toThrow(/vide/);
    expect(calls).toBe(1);
  });
});

/** Measured on all three models: a rejected value returns this exact message. */
describe('a rejected reasoning level', () => {
  it('recognizes "<param> value <x> is not supported", not just Ollama\'s wording', async () => {
    queue.push({
      status: 400,
      body: `{"error":"'reasoning_effort' value 'max' is not supported by this model"}`,
    });
    queue.push({ status: 200, body: ok() });
    const downgrades: Downgrade[] = [];
    const result = await call({ think: 'nawak', onDowngrade: (event) => downgrades.push(event) });
    expect(result.content).toBe('trouvailles');
    expect(calls).toBe(2);
    // Misclassified, this was 'thinking-unsupported': the log would have
    // claimed the model can't reason, when only the level is wrong.
    expect(downgrades[0]?.cause).toBe('level-rejected');
    expect(lastBody.reasoning_effort).toBeUndefined();
  });
});

/**
 * Measured on all three models at `reasoning_effort: high` (never at `low`
 * nor without the parameter): the chain of thought leaks into `content`,
 * between `<reasoning>` tags opened and closed mid-sentence. On one real
 * run, 33,664 characters of English reasoning went out as the review.
 */
describe('<reasoning> tags in the content', () => {
  it('strips them even when split across two SSE fragments, and counts the reasoning', async () => {
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

  it('moves a never-closed <reasoning> into thinking, and falls back rather than posting it', async () => {
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

/** Measured on all three models: `max` alone returns this 400, `high` doesn't. */
describe("a level this dialect doesn't recognize under its generic name", () => {
  it('translates "max" to "high", the real available ceiling', async () => {
    queue.push({ status: 200, body: ok() });
    await call({ think: 'max' });
    expect(lastBody.reasoning_effort).toBe('high');
  });
});
