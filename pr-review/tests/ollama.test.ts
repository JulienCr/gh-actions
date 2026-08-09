// @vitest-environment node
//
// Explicite, bien que ce soit déjà le défaut du projet : ce module n'existe que
// pour parler HTTP, et un environnement DOM substituerait son propre `fetch`,
// qui ne rend pas les mêmes erreurs d'abandon que celui de Node. Tester contre
// lui reviendrait à valider un runtime que cette action ne rencontrera jamais.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chat, OllamaError } from '../src/ollama';

/**
 * La politique de reprise se teste contre un vrai serveur HTTP local plutôt que
 * contre un `fetch` bouchonné : c'est le code de statut et le corps réels qui
 * décident, et un stub les aurait figés à ce que je crois qu'ils sont.
 *
 * Ce qui compte ici est asymétrique : reprendre ce qui peut passer (5xx, panne
 * réseau) et surtout NE PAS reprendre le reste. Un 401 rejoué double le bruit,
 * et un dépassement de délai rejoué double le temps du job pour rien.
 */

interface Scripted {
  status: number;
  body: string;
}

let server: Server;
let host: string;
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
      res.setHeader('content-type', 'application/json');
      res.end(next.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.OLLAMA_HOST = host;
});

afterAll(async () => {
  delete process.env.OLLAMA_HOST;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queue = [];
  calls = 0;
});

const ok = (content: string) =>
  JSON.stringify({ message: { role: 'assistant', content }, prompt_eval_count: 100, eval_count: 20 });

const call = () =>
  chat({ apiKey: 'faux', model: 'glm-5.2:cloud', system: 'sys', user: 'usr', retryDelayMs: 1 });

describe('chat · requête', () => {
  it('demande une réponse déterministe et non streamée', async () => {
    queue.push({ status: 200, body: ok('## Verdict\nok') });
    await call();
    expect(lastBody.stream).toBe(false);
    expect(lastBody.options).toEqual({ temperature: 0 });
    expect(lastBody.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('rend le contenu et les compteurs de tokens', async () => {
    queue.push({ status: 200, body: ok('## Verdict\nok') });
    const result = await call();
    expect(result.content).toBe('## Verdict\nok');
    expect(result.promptTokens).toBe(100);
    expect(result.evalTokens).toBe(20);
  });
});

describe('chat · reprise', () => {
  it('reprend une fois après un 5xx', async () => {
    queue.push({ status: 503, body: 'indisponible' }, { status: 200, body: ok('après reprise') });
    const result = await call();
    expect(result.content).toBe('après reprise');
    expect(calls).toBe(2);
  });

  it('reprend une fois après un 429', async () => {
    queue.push({ status: 429, body: 'trop de requêtes' }, { status: 200, body: ok('ok') });
    await call();
    expect(calls).toBe(2);
  });

  it('ne reprend pas un 401 : la clé ne deviendra pas valide', async () => {
    queue.push({ status: 401, body: '{"error":"Unauthorized"}' });
    await expect(call()).rejects.toThrow(/HTTP 401 \(clé refusée\)/);
    expect(calls).toBe(1);
  });

  it('ne reprend pas un 404 de modèle', async () => {
    queue.push({ status: 404, body: '{"error":"model not found"}' });
    await expect(call()).rejects.toThrow(/modèle inconnu/);
    expect(calls).toBe(1);
  });

  it('abandonne après un second échec, sans troisième tentative', async () => {
    queue.push({ status: 503, body: 'ko' }, { status: 503, body: 'toujours ko' });
    await expect(call()).rejects.toThrow(OllamaError);
    expect(calls).toBe(2);
  });
});

describe('chat · réponses inexploitables', () => {
  it('refuse une réponse vide plutôt que de poster un commentaire blanc', async () => {
    queue.push({ status: 200, body: JSON.stringify({ message: { content: '   ' } }) });
    await expect(call()).rejects.toThrow(/réponse vide/);
    expect(calls).toBe(1);
  });

  it('remonte une erreur applicative arrivée en 200', async () => {
    queue.push({ status: 200, body: JSON.stringify({ error: 'model is loading' }) });
    await expect(call()).rejects.toThrow(/model is loading/);
  });

  it('signale un corps non JSON', async () => {
    queue.push({ status: 200, body: '<html>proxy</html>' });
    await expect(call()).rejects.toThrow(/illisible/);
  });
});

describe('chat · dépassement de délai', () => {
  it("n'est pas repris : le même prompt reprendrait le même temps", async () => {
    // Aucune réponse programmée côté serveur n'est nécessaire : le délai est si
    // court que la requête est abandonnée avant toute réponse utile.
    const slow = createServer(() => {
      /* ne répond jamais */
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const previous = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;

    await expect(
      chat({ apiKey: 'faux', model: 'm', system: 's', user: 'u', timeoutMs: 60, retryDelayMs: 1 }),
    ).rejects.toThrow(/n'a pas répondu/);

    process.env.OLLAMA_HOST = previous;
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  });
});
