// @vitest-environment node
//
// Explicite, bien que ce soit déjà le défaut du projet : ce module n'existe que
// pour parler HTTP, et un environnement DOM substituerait son propre `fetch`,
// qui ne rend pas les mêmes erreurs d'abandon que celui de Node. Tester contre
// lui reviendrait à valider un runtime que cette action ne rencontrera jamais.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ollamaClient } from '../../src/llm/ollama';
import { LlmError } from '../../src/llm/types';

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
/**
 * L'hôte visé par `call`.
 *
 * Une variable plutôt qu'`OLLAMA_HOST` depuis que la base est un paramètre du
 * client : c'est l'appelant qui la résout (cf. `endpointFor` dans `index.ts`),
 * et le client, lui, ne lit plus l'environnement.
 */
let baseUrl = '';

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
  baseUrl = host;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  queue = [];
  calls = 0;
});

/**
 * Une réponse complète tient en un seul fragment, `done: true` compris : c'est
 * ce marqueur, et non la fermeture de la connexion, qui distingue une
 * génération terminée d'un flux coupé en route.
 */
const ok = (content: string) =>
  JSON.stringify({
    message: { role: 'assistant', content },
    done: true,
    prompt_eval_count: 100,
    eval_count: 20,
  });

/**
 * Détourne l'appelant vers un autre hôte le temps d'un test, et le restaure même
 * si l'assertion échoue : sans le `finally`, un seul test rouge laisse la
 * variable d'environnement en place et fait tomber tous les suivants, qui
 * accusent alors le mauvais coupable.
 */
async function withHost(url: string, body: () => Promise<void>): Promise<void> {
  const previous = baseUrl;
  baseUrl = url;
  try {
    await body();
  } finally {
    baseUrl = previous;
  }
}

/** Ouvre un serveur éphémère, le referme quoi qu'il arrive, et y pointe l'appelant. */
async function withServer(
  handler: Parameters<typeof createServer>[1],
  body: () => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await withHost(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, body);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const call = (over: Partial<Parameters<typeof ollamaClient>[0]> = {}) =>
  ollamaClient({
    apiKey: 'faux',
    baseUrl,
    model: 'glm-5.2:cloud',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ],
    retryDelayMs: 1,
    ...over,
  });

describe('chat · requête', () => {
  it('demande une réponse streamée, sans brider l’échantillonnage', async () => {
    queue.push({ status: 200, body: ok('## Verdict\nok') });
    await call({ temperature: 1, seed: 1 });
    // Non négociable : sans streaming, Ollama ne renvoie pas un octet avant la
    // fin de la génération, et le `fetch` de Node abandonne au bout de 300 s
    // d'attente d'en-têtes (`UND_ERR_HEADERS_TIMEOUT`), quel que soit
    // l'`AbortSignal` posé par l'appelant. Mesuré sur la PR wolfgangparis#578 :
    // la passe la plus bavarde tombait à 300,8 s.
    expect(lastBody.stream).toBe(true);
    // Surtout pas temperature 0 : voir le commentaire de `ChatOptions`.
    expect(lastBody.options).toEqual({ temperature: 1, seed: 1 });
    expect(lastBody.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('omet la graine quand on n’en veut pas, plutôt que d’en inventer une', async () => {
    queue.push({ status: 200, body: ok('ok') });
    await call({ seed: undefined });
    expect(lastBody.options).toEqual({ temperature: 1 });
  });

  it('transmet le niveau de raisonnement demandé', async () => {
    queue.push({ status: 200, body: ok('ok') });
    await call({ think: 'max' });
    expect(lastBody.think).toBe('max');
  });

  it('n’envoie pas « think » du tout quand aucun niveau n’est demandé', async () => {
    queue.push({ status: 200, body: ok('ok') });
    await call({ think: '' });
    expect(lastBody).not.toHaveProperty('think');
  });

  it('traduit « off » en refus explicite de raisonner, pas en absence de consigne', async () => {
    queue.push({ status: 200, body: ok('ok') });
    await call({ think: 'off' });
    expect(lastBody.think).toBe(false);
  });

  it('agrège les fragments du flux en une seule réponse', async () => {
    queue.push({
      status: 200,
      body: [
        JSON.stringify({ message: { role: 'assistant', thinking: 'je ré', content: '' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', thinking: 'fléchis', content: '## Verdict\n' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: 'rien à signaler' }, done: false }),
        // Ollama ne renseigne les compteurs que sur le dernier fragment.
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 84817, eval_count: 31158 }),
      ].join('\n'),
    });
    const result = await call();

    expect(result.content).toBe('## Verdict\nrien à signaler');
    expect(result.thinkingChars).toBe('je réfléchis'.length);
    expect(result.usage.inputTokens).toBe(84817);
    expect(result.usage.outputTokens).toBe(31158);
  });

  it('rend le contenu, les compteurs de tokens et la taille du raisonnement', async () => {
    queue.push({
      status: 200,
      body: JSON.stringify({
        message: { role: 'assistant', content: '## Verdict\nok', thinking: 'abcde' },
        done: true,
        prompt_eval_count: 100,
        eval_count: 20,
      }),
    });
    const result = await call();
    expect(result.content).toBe('## Verdict\nok');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.thinkingChars).toBe(5);
  });
});

describe('chat · modèle sans raisonnement', () => {
  it('rejoue sans « think » plutôt que de rendre l’action inutilisable', async () => {
    queue.push(
      { status: 400, body: '{"error":"registry.ollama.ai/library/x does not support thinking"}' },
      { status: 200, body: ok('review sans raisonnement') },
    );
    const downgrades: string[] = [];
    const result = await call({ think: 'max', onDowngrade: (reason) => downgrades.push(reason) });

    expect(result.content).toBe('review sans raisonnement');
    expect(calls).toBe(2);
    // La seconde tentative doit vraiment avoir lâché le paramètre : le rejouer
    // à l'identique produirait le même 400 et une review perdue.
    expect(lastBody).not.toHaveProperty('think');
    // Silencieux, ce repli ferait croire à une review fouillée qui ne l'est pas.
    expect(downgrades).toHaveLength(1);
  });

  it('garde le raisonnement quand seul le niveau est fautif', async () => {
    queue.push(
      {
        status: 400,
        body: '{"error": "invalid think value: "nawak" (must be "high", "medium", "low", "max", true, or false)"}',
      },
      { status: 200, body: ok('review quand même raisonnée') },
    );
    const result = await call({ think: 'nawak' });

    expect(result.content).toBe('review quand même raisonnée');
    // Une coquille dans un input ne doit coûter que le niveau demandé, pas la
    // profondeur d'analyse : on retombe sur le raisonnement par défaut.
    expect(lastBody.think).toBe(true);
  });

  it('ne rejoue pas un 400 qui ne parle pas de raisonnement', async () => {
    queue.push({ status: 400, body: '{"error":"prompt trop long"}' });
    await expect(call({ think: 'max' })).rejects.toThrow(LlmError);
    expect(calls).toBe(1);
  });

  it('rattrape aussi le refus rendu en 200 avec un corps d’erreur', async () => {
    queue.push(
      { status: 200, body: '{"error":"thinking is not supported by this model"}' },
      { status: 200, body: ok('repli') },
    );
    const result = await call({ think: 'high' });
    expect(result.content).toBe('repli');
    expect(calls).toBe(2);
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

  it('chronomètre la tentative retenue, et non la somme des essais', async () => {
    queue.push({ status: 503, body: 'ko' }, { status: 200, body: ok('enfin') });
    const result = await call({ retryDelayMs: 300 });

    expect(result.content).toBe('enfin');
    // Une durée cumulée est pire qu'absente : sur wolfgangparis#578 elle a
    // affiché « 611 s » pour deux tentatives de ~300 s, ce qui a rendu invisible
    // le plafond de 300 s que chacune venait de heurter.
    expect(result.durationMs).toBeLessThan(300);
  });

  it('abandonne après un second échec, sans troisième tentative', async () => {
    queue.push({ status: 503, body: 'ko' }, { status: 503, body: 'toujours ko' });
    await expect(call()).rejects.toThrow(LlmError);
    expect(calls).toBe(2);
  });
});

describe('chat · panne de transport', () => {
  it('nomme la cause, que « fetch failed » seul rend indéchiffrable', async () => {
    // `fetch` rend un « fetch failed » nu et range tout ce qui sert au
    // diagnostic (ECONNREFUSED, UND_ERR_HEADERS_TIMEOUT…) dans `cause`. Sans
    // cette remontée, un journal de CI ne permet pas de distinguer un port
    // fermé d'un délai dépassé : mesuré sur wolfgangparis#578, où il a fallu
    // rejouer la panne à côté pour l'identifier.
    // Un port éphémère refermé aussitôt : la connexion est refusée pour de bon.
    // Surtout pas un port bas « jamais écouté » (1, 22…) : `fetch` en refuse
    // toute une liste avant même de tenter la connexion, et rend un « bad port »
    // qui ne dit rien du transport.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    await withHost(`http://127.0.0.1:${port}`, async () => {
      await expect(call()).rejects.toThrow(/ECONNREFUSED/);
    });
  });

  it('ne recopie pas les identifiants d’une URL dans le message', async () => {
    // Mesuré : `fetch` refuse une URL portant des identifiants, et son refus
    // les cite en clair — « Request cannot be constructed from a URL that
    // includes credentials: http://user:motdepasse@… ». Le message part
    // directement dans le journal d'un dépôt public, alors même que le refus
    // garantit qu'aucune connexion n'a eu lieu.
    await withHost('http://sonde:motdepasse@127.0.0.1:11434', async () => {
      await expect(call()).rejects.toThrow(/identifiants|credentials/i);
      await expect(call()).rejects.not.toThrow(/motdepasse/);
    });
  });

  it('nomme le code même quand aucun message ne le porte', async () => {
    // Une connexion coupée en plein flux — le risque propre à un appel de
    // plusieurs minutes. Mesuré : « terminated » puis « other side closed », et
    // le seul terme identifiant la panne, UND_ERR_SOCKET, n'est que dans `code`.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { content: 'coupé net' }, done: false })}\n`);
        res.destroy();
      },
      async () => {
        await expect(call()).rejects.toThrow(/UND_ERR_SOCKET/);
      },
    );
  });
});

describe('chat · réponses inexploitables', () => {
  it('refuse une réponse vide plutôt que de poster un commentaire blanc', async () => {
    // Génération bel et bien terminée, mais qui n'a rien produit d'affichable :
    // tout est parti dans le raisonnement.
    queue.push({ status: 200, body: JSON.stringify({ message: { content: '   ' }, done: true }) });
    await expect(call()).rejects.toThrow(/réponse vide/);
    expect(calls).toBe(1);
  });

  it('remonte une erreur applicative arrivée en 200', async () => {
    queue.push({ status: 200, body: JSON.stringify({ error: 'model is loading' }) });
    await expect(call()).rejects.toThrow(/model is loading/);
  });

  it('refuse un flux interrompu avant la fin plutôt que de poster une review tronquée', async () => {
    // Ni erreur ni statut : le flux s'arrête, simplement. Sans le marqueur
    // `done`, rien ne distingue ça d'une génération terminée — sinon ce test.
    const truncated = {
      status: 200,
      body: [
        JSON.stringify({ message: { content: '## Verdict\nla revue commence' }, done: false }),
        JSON.stringify({ message: { content: ' et se fait couper' }, done: false }),
      ].join('\n'),
    };
    // Deux fois : la coupure vaut une reprise (test suivant), c'est donc la
    // seconde qui décide de l'abandon.
    queue.push(truncated, { ...truncated });
    await expect(call()).rejects.toThrow(/interrompu/);
    expect(calls).toBe(2);
  });

  it('reprend un flux interrompu : une coupure de transport peut ne pas se répéter', async () => {
    queue.push(
      { status: 200, body: JSON.stringify({ message: { content: 'coupé' }, done: false }) },
      { status: 200, body: ok('complet') },
    );
    const result = await call();
    expect(result.content).toBe('complet');
    expect(calls).toBe(2);
  });

  it('traite une coupure au milieu d’une ligne comme l’interruption qu’elle est', async () => {
    // Même panne que le test précédent, à ceci près qu'elle tombe au milieu
    // d'un fragment plutôt qu'entre deux. La classer « illisible » la rendrait
    // non reprisable, et perdrait la review sur un détail d'alignement des
    // octets — alors que la coupure entre deux lignes, elle, vaut une reprise.
    const cut = {
      status: 200,
      body:
        `${JSON.stringify({ message: { content: 'la revue commence' }, done: false })}\n` +
        '{"message":{"content":"et se fait couper au mil',
    };
    queue.push(cut, { ...cut });
    await expect(call()).rejects.toThrow(/interrompu/);
    expect(calls).toBe(2);
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
    await withServer(
      () => {
        /* ne répond jamais */
      },
      async () => {
        await expect(
          call({ timeoutMs: 60 }),
        ).rejects.toThrow(/n'a pas répondu/);
      },
    );
  });

  it('couvre aussi la lecture d’un corps d’erreur qui n’arrive jamais', async () => {
    // Le corps d'un refus est court, mais rien ne garantit qu'il arrive : un
    // 503 rendu par un proxy à bout de souffle peut annoncer une taille puis se
    // taire. Sans traitement, l'abandon remonterait en `DOMException` brute,
    // hors de la classification (donc ni nommé, ni marqué non reprisable).
    await withServer(
      (_req, res) => {
        res.writeHead(503, { 'content-type': 'text/plain', 'content-length': '100' });
        res.write('le corps commence');
        /* et ne finit jamais */
      },
      async () => {
        await expect(
          call({ timeoutMs: 60 }),
        ).rejects.toThrow(/n'a pas répondu/);
      },
    );
  });

  it('couvre la lecture du flux, et pas seulement l’attente des en-têtes', async () => {
    // Le piège propre au streaming : les en-têtes arrivent, `fetch` résout, et
    // l'attente se déplace dans la boucle de lecture. Un délai qui ne couvrirait
    // que l'appel laisserait le job pendre jusqu'à ce que GitHub le tue.
    await withServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { content: 'je commence' }, done: false })}\n`);
        /* puis plus jamais rien */
      },
      async () => {
        await expect(
          call({ timeoutMs: 60 }),
        ).rejects.toThrow(/n'a pas répondu/);
      },
    );
  });
});

describe('« couper le raisonnement » a une seule définition', () => {
  /**
   * Cette liste ignorait « no » et « 0 », que le client OpenAI-compatible
   * accepte pourtant : un dépôt qui écrivait « thinking: no » envoyait la
   * chaîne à Ollama, qui la refusait, et le repli le remontait à « true ».
   * L'extinction demandée était donc ignorée chez un provider et appliquée
   * chez l'autre.
   */
  it.each(['false', 'off', 'none', 'no', '0', 'NO'])('traduit « %s » en refus explicite', async (value) => {
    queue.push({ status: 200, body: ok('ok') });
    await call({ think: value });
    expect(lastBody.think).toBe(false);
  });

  it('laisse passer un niveau, qui n’est pas une extinction', async () => {
    queue.push({ status: 200, body: ok('ok') });
    await call({ think: 'low' });
    expect(lastBody.think).toBe('low');
  });
});

describe('les secrets ne sortent pas dans un message d’erreur', () => {
  it('masque la clé qu’Ollama renverrait dans le corps d’un refus', async () => {
    queue.push({ status: 400, body: 'rejected header Bearer cle-tres-secrete' });
    const error = await call({ apiKey: 'cle-tres-secrete' }).then(
      () => new Error('aurait dû échouer'),
      (caught: Error) => caught,
    );
    expect(error.message).not.toContain('cle-tres-secrete');
    expect(error.message).toContain('***');
  });

  it('masque la clé dans une erreur applicative arrivée en 200', async () => {
    queue.push({ status: 200, body: JSON.stringify({ error: 'clé cle-tres-secrete refusée' }) });
    const error = await call({ apiKey: 'cle-tres-secrete' }).then(
      () => new Error('aurait dû échouer'),
      (caught: Error) => caught,
    );
    expect(error.message).not.toContain('cle-tres-secrete');
  });
});
