#!/usr/bin/env node

// pr-review/src/index.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

// pr-review/src/context.ts
function hasContent(file, isSkipped) {
  return !isSkipped(file.path) && file.status !== "removed";
}
function splitDiffByFile(diff) {
  const chunks = [];
  const lines = diff.split("\n");
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.join("\n");
    chunks.push({ path: pathOfChunk(current), body });
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  flush();
  return chunks;
}
function pathOfChunk(lines) {
  let fromA = "";
  for (const line of lines) {
    if (line.startsWith("+++ b/")) return line.slice("+++ b/".length).trim();
    if (line.startsWith("--- a/") && !fromA) fromA = line.slice("--- a/".length).trim();
    if (line.startsWith("@@")) break;
  }
  if (fromA) return fromA;
  const header = lines[0] ?? "";
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  return match?.[2] ?? match?.[1] ?? "";
}
function filterDiff(diff, isSkipped) {
  const chunks = splitDiffByFile(diff);
  const kept = [];
  const skipped = [];
  for (const chunk of chunks) {
    if (isSkipped(chunk.path)) skipped.push(chunk.path);
    else kept.push(chunk.body);
  }
  return { diff: kept.join("\n"), skipped };
}
function numberLines(content) {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const width = String(lines.length).length;
  return lines.map((line, index) => `${String(index + 1).padStart(width, " ")}| ${line}`).join("\n");
}
function assembleContext({
  rawDiff,
  prFiles,
  readFile,
  isSkipped,
  budget
}) {
  const { diff, skipped } = filterDiff(rawDiff, isSkipped);
  const files = [];
  const omitted = [];
  let used = 0;
  const candidates = prFiles.filter((file) => hasContent(file, isSkipped)).sort((a, b) => a.additions + a.deletions - (b.additions + b.deletions));
  for (const file of candidates) {
    const content = readFile(file.path);
    if (content === null) continue;
    if (content.length > budget.perFileChars || used + content.length > budget.totalChars) {
      omitted.push(file.path);
      continue;
    }
    used += content.length;
    files.push({ path: file.path, numbered: numberLines(content) });
  }
  const order = new Map(prFiles.map((file, index) => [file.path, index]));
  files.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  return { diff, files, skipped, omitted };
}

// pr-review/src/exec.ts
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var MAX_BUFFER = 32 * 1024 * 1024;
async function run(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`\xAB ${command} ${args.slice(0, 3).join(" ")} \u2026 \xBB a \xE9chou\xE9 : ${message}`);
  }
}
function runWithStdin(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", (error) => reject(new Error(`impossible de lancer \xAB ${command} \xBB : ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`\xAB ${command} ${args.slice(0, 3).join(" ")} \u2026 \xBB a quitt\xE9 avec ${code}
${stderr.slice(-2e3)}`));
    });
    child.stdin.end(input);
  });
}

// pr-review/src/gh.ts
async function fetchPrMeta(pr) {
  const stdout = await run("gh", [
    "pr",
    "view",
    String(pr),
    "--json",
    "number,title,body,headRefOid,baseRefName,isDraft,files"
  ]);
  const raw = JSON.parse(stdout);
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    headSha: raw.headRefOid,
    baseRefName: raw.baseRefName,
    isDraft: raw.isDraft,
    files: (raw.files ?? []).map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      status: file.status ?? "modified"
    }))
  };
}
function fetchPrDiff(pr) {
  return run("gh", ["pr", "diff", String(pr)]);
}
async function postComment(pr, body) {
  await runWithStdin("gh", ["pr", "comment", String(pr), "--body-file", "-"], body);
}
async function currentHeadSha() {
  try {
    return (await run("git", ["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}
async function resolveRepo() {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (fromEnv) return fromEnv;
  const stdout = await run("gh", ["repo", "view", "--json", "nameWithOwner"]);
  return JSON.parse(stdout).nameWithOwner;
}

// pr-review/src/globs.ts
var SPECIAL = /[.+^${}()|[\]\\]/g;
function translate(pattern) {
  let source = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "*") {
      const isDouble = pattern[index + 1] === "*";
      if (isDouble) {
        if (pattern[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 3;
          continue;
        }
        source += ".*";
        index += 2;
        continue;
      }
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += char.replace(SPECIAL, "\\$&");
    index += 1;
  }
  return source;
}
function compileGlob(raw) {
  let pattern = raw.trim();
  if (pattern === "" || pattern.startsWith("#")) return null;
  pattern = pattern.replace(/^\.\//, "").replace(/^\/+/, "");
  if (pattern === "") return null;
  const basenameOnly = !pattern.includes("/");
  if (pattern.endsWith("/")) pattern += "**";
  return { regexp: new RegExp(`^${translate(pattern)}$`), basenameOnly };
}
function compileMatcher(patterns) {
  const compiled = patterns.map(compileGlob).filter((entry) => entry !== null);
  if (compiled.length === 0) return () => false;
  return (path) => {
    const normalized = path.replace(/^\.\//, "");
    const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
    return compiled.some((entry) => entry.regexp.test(entry.basenameOnly ? basename : normalized));
  };
}
function parseList(value) {
  return value.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
}

// pr-review/src/inputs.ts
var ALWAYS_SKIPPED = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "poetry.lock",
  "go.sum",
  // Ancré nulle part : un monorepo a aussi des `packages/x/node_modules/`.
  "**/node_modules/**",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.webp",
  "*.avif",
  "*.gif",
  "*.ico",
  "*.pdf",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.eot",
  "*.otf",
  "*.mp3",
  "*.mp4",
  "*.mov",
  "*.zip",
  "*.gz",
  "*.tar"
];
var DEFAULT_DOCTRINE = [
  ".github/copilot-instructions.md",
  "CLAUDE.md",
  "AGENTS.md"
];
var DEFAULTS = {
  model: "glm-5.2:cloud",
  maxFindings: 20,
  budgetChars: 5e5,
  perFileChars: 8e4,
  timeoutMinutes: 15,
  /**
   * Effort de raisonnement demandé au modèle.
   *
   * `max` parce qu'une review vaut par ce qu'elle trouve, pas par sa latence :
   * le job tourne pendant que l'auteur fait autre chose. Un modèle qui ne sait
   * pas raisonner rejoue sans (cf. `chat`), donc ce défaut ne ferme la porte à
   * aucun modèle.
   */
  thinking: "max",
  /**
   * Surtout pas 0. Le décodage glouton sur un modèle de raisonnement raccourcit
   * la chaîne de pensée et la fait tourner en rond ; 1 est la valeur des
   * exemples officiels de GLM-5. La stabilité d'un jour à l'autre est confiée à
   * la graine, qui la sert sans coûter en profondeur.
   */
  temperature: 1,
  seed: 1
};
var UsageError = class extends Error {
};
function readInput(env, name) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
function readNumber(env, name, fallback, warn) {
  const raw = readInput(env, name);
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`input \xAB ${name} \xBB illisible (\xAB ${raw} \xBB) : on garde ${fallback}.`);
    return fallback;
  }
  return parsed;
}
function readBoolean(env, name) {
  return /^(true|1|yes)$/i.test(readInput(env, name));
}
function readTemperature(env, warn) {
  const raw = readInput(env, "temperature");
  if (raw === "") return DEFAULTS.temperature;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    warn(`input \xAB temperature \xBB illisible (\xAB ${raw} \xBB) : on garde ${DEFAULTS.temperature}.`);
    return DEFAULTS.temperature;
  }
  if (parsed === 0) {
    warn(
      "temperature = 0 sur un mod\xE8le de raisonnement : la review sera plus courte et plus\n  superficielle. Pour de la stabilit\xE9, garde la temp\xE9rature et fixe \xAB seed \xBB."
    );
  }
  return parsed;
}
function readSeed(env, warn) {
  const raw = readInput(env, "seed");
  if (raw === "") return DEFAULTS.seed;
  if (/^(off|none|false)$/i.test(raw)) return void 0;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    warn(`input \xAB seed \xBB illisible (\xAB ${raw} \xBB) : on garde ${DEFAULTS.seed}.`);
    return DEFAULTS.seed;
  }
  return parsed;
}
function resolveConfig({ argv, env, warn = () => {
} }) {
  let pr = null;
  let dryRun = readBoolean(env, "dry-run");
  let model = readInput(env, "model") || env.OLLAMA_REVIEW_MODEL?.trim() || DEFAULTS.model;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--model") {
      const value = argv[++index];
      if (!value) throw new UsageError("\xAB --model \xBB attend un nom de mod\xE8le.");
      model = value;
    } else if (/^#?\d+$/.test(arg)) pr = Number(arg.replace("#", ""));
    else throw new UsageError(`argument inconnu : ${arg}`);
  }
  if (pr === null) {
    const fromInput = readInput(env, "pr");
    if (/^#?\d+$/.test(fromInput)) pr = Number(fromInput.replace("#", ""));
  }
  if (pr === null) {
    const fromEvent = env.PR_NUMBER?.trim();
    if (fromEvent && /^\d+$/.test(fromEvent)) pr = Number(fromEvent);
  }
  if (pr === null) {
    throw new UsageError(
      "num\xE9ro de PR manquant. En CI, renseigne l'input \xAB pr \xBB ; en local : pr-review <num\xE9ro> [--dry-run] [--model <nom>]"
    );
  }
  const doctrineInput = parseList(readInput(env, "doctrine"));
  return {
    pr,
    dryRun,
    model,
    // Pas de validation contre une liste de niveaux : ils varient d'un modèle à
    // l'autre, et un niveau refusé est rattrapé à l'appel.
    thinking: readInput(env, "thinking") || DEFAULTS.thinking,
    temperature: readTemperature(env, warn),
    seed: readSeed(env, warn),
    maxFindings: readNumber(env, "max-findings", DEFAULTS.maxFindings, warn),
    budgetChars: readNumber(env, "budget-chars", DEFAULTS.budgetChars, warn),
    perFileChars: readNumber(env, "per-file-chars", DEFAULTS.perFileChars, warn),
    timeoutMs: readNumber(env, "timeout-minutes", DEFAULTS.timeoutMinutes, warn) * 6e4,
    doctrine: doctrineInput.length > 0 ? doctrineInput : [...DEFAULT_DOCTRINE],
    // Le plancher d'abord : ce qui suit ne peut qu'ajouter, jamais retirer.
    skip: [...ALWAYS_SKIPPED, ...parseList(readInput(env, "skip"))],
    projectSummary: readInput(env, "project-summary"),
    apiKey: readInput(env, "ollama-api-key") || env.OLLAMA_API_KEY?.trim() || "",
    githubToken: readInput(env, "github-token") || env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || ""
  };
}

// pr-review/src/ollama.ts
var DEFAULT_HOST = "https://ollama.com";
var DEFAULT_TIMEOUT_MS = 15 * 6e4;
var RETRY_DELAY_MS = 2e4;
var OllamaError = class extends Error {
  /** Une seconde tentative a-t-elle une chance d'aboutir ? */
  retryable;
  /** Le modèle a refusé `think` : rejouer sans est la seule issue. */
  thinkingRejected;
  constructor(message, retryable = false, thinkingRejected = false) {
    super(message);
    this.name = "OllamaError";
    this.retryable = retryable;
    this.thinkingRejected = thinkingRejected;
  }
};
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var worthRetrying = (status) => status === 429 || status >= 500;
function parseThink(value) {
  const normalised = value.trim().toLowerCase();
  if (normalised === "true") return true;
  if (/^(false|off|none)$/.test(normalised)) return false;
  return normalised;
}
var rejectsThinking = (status, body) => status === 400 && /think/i.test(body);
var rejectsThinkingValue = (body) => /invalid think value/i.test(body);
async function chat(options) {
  const started = Date.now();
  const done = (payload) => ({
    content: payload.message?.content ?? "",
    promptTokens: payload.prompt_eval_count ?? 0,
    evalTokens: payload.eval_count ?? 0,
    thinkingChars: payload.message?.thinking?.length ?? 0,
    durationMs: Date.now() - started
  });
  try {
    return done(await request(options));
  } catch (error) {
    if (!(error instanceof OllamaError)) throw error;
    if (error.thinkingRejected && options.think) {
      const fallback = rejectsThinkingValue(error.message) ? "true" : "";
      options.onDowngrade?.(error.message);
      return done(await request({ ...options, think: fallback }));
    }
    if (!error.retryable) throw error;
    options.onRetry?.(error.message);
    await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
    return done(await request(options));
  }
}
async function request(options) {
  const host = (process.env.OLLAMA_HOST ?? DEFAULT_HOST).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response;
  try {
    response = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        ...options.think ? { think: parseThink(options.think) } : {},
        // Une review doit rester comparable d'un jour à l'autre : c'est la
        // graine qui s'en charge, pas une température nulle, qui sur un modèle
        // de raisonnement coûterait la moitié de sa profondeur d'analyse.
        options: {
          temperature: options.temperature ?? 1,
          ...options.seed === void 0 ? {} : { seed: options.seed }
        },
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user }
        ]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new OllamaError(`Ollama n'a pas r\xE9pondu en ${Math.round(timeoutMs / 6e4)} min`);
    }
    throw new OllamaError(`appel \xE0 Ollama impossible (${reason})`, true);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new OllamaError(
      `HTTP ${response.status} ${describeStatus(response.status)}${detail(text)}`,
      worthRetrying(response.status),
      rejectsThinking(response.status, text)
    );
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new OllamaError(`r\xE9ponse illisible d'Ollama (${text.slice(0, 200)})`);
  }
  if (payload.error) {
    throw new OllamaError(
      `Ollama a r\xE9pondu une erreur : ${payload.error}`,
      false,
      /think/i.test(payload.error)
    );
  }
  if (!payload.message?.content?.trim()) {
    throw new OllamaError("Ollama a rendu une r\xE9ponse vide");
  }
  return payload;
}
function describeStatus(status) {
  if (status === 401 || status === 403) return "(cl\xE9 refus\xE9e)";
  if (status === 404) return "(mod\xE8le inconnu)";
  if (status === 429) return "(quota ou limite de d\xE9bit atteinte)";
  if (status >= 500) return "(panne c\xF4t\xE9 Ollama)";
  return "";
}
function detail(body) {
  const trimmed = body.trim();
  return trimmed ? ` : ${trimmed.slice(0, 300)}` : "";
}

// pr-review/src/prompt.ts
var OUTPUT_TEMPLATE = `## Verdict
Une seule phrase : ce que tu retiens de cette PR.

## Bloquant
- \`chemin/fichier.ts:42\` : ce qui casse, et pourquoi ici.

## \xC0 corriger
- \`chemin/fichier.tsx:17\` : \u2026

## Suggestions
- \`chemin/fichier.ts:88\` : \u2026

## \xC0 v\xE9rifier
- \`chemin/fichier.ts:120\` : ce que tu soup\xE7onnes sans pouvoir le prouver ici, et ce qu'il
  faudrait regarder pour trancher.`;
function renderDoctrine(files) {
  if (files.length === 0) {
    return `This repository ships no review doctrine. Judge on general engineering grounds only, and
never present a remark as if it came from a project rule.`;
  }
  const blocks = files.map((file) => `<doctrine path="${file.path}">
${file.content}
</doctrine>`).join("\n\n");
  return `Here are the repository's own conventions, as written by its maintainer. They are
authoritative, and they outrank your general habits.

${blocks}`;
}
function buildSystemPrompt(options) {
  const summary = options.projectSummary.trim();
  return `You are reviewing a pull request on the \`${options.repo}\` repository.
${summary ? `
${summary}
` : ""}
You run when the PR is opened, before any human reads it. Your job is to catch what a generic
linter cannot see: this project's own rules, functional regressions, and data leaks.

${renderDoctrine(options.doctrine)}

# Expected output

Return exactly these five sections, in this order, as markdown. The review itself is written
in French: it is posted as a comment on the PR.

${OUTPUT_TEMPLATE}

# How hard to look

Your job is coverage, not curation. A finding you swallowed because you were not sure enough
is a bug that ships. Report what you find and let the section carry your confidence: a doubt
belongs under \xAB \xC0 v\xE9rifier \xBB, never in the bin.

- **Read every file you were given in full**, not only the changed lines. The diff says what
  moved; the code around it says what that broke. A reviewer who only reads \xAB + \xBB lines finds
  only typos.
- **Do not soften a finding into silence.** When something looks wrong but you cannot prove it
  from what you were given, say what you saw, what you suspect, and which file would settle
  it. That is a \xAB \xC0 v\xE9rifier \xBB bullet, and it is worth more than an empty section.
- **\xAB Rien \xE0 signaler \xBB is a claim, not a default.** Write it only with, on the same line, what
  you checked in order to say it: \xAB Rien \xE0 signaler (chemins d'erreur et valeurs de retour
  relus) \xBB. If you cannot name what you checked, you have not checked.

# Where the costly bugs hide

Walk these deliberately, on every changed file. None of them is visible in a diff read line by
line, which is exactly why they survive until production.

1. **The caller's side.** A changed signature, return shape, thrown error or nullability breaks
   whoever calls it. If you were not given that caller, say so and ask.
2. **Error paths.** What happens when this throws, returns null, times out, or gets an empty
   list? An error caught, logged and swallowed is a silent failure: the feature is dead and
   nobody is told.
3. **Edge inputs.** Empty, zero, one element, duplicates, very large. Boundaries of a loop, a
   slice, a pagination.
4. **State and ordering.** Two runs racing, a retry replaying a side effect, a cache or a
   ledger written before the thing it records actually succeeded, a missing await.
5. **Data and access.** A query crossing a role boundary, a secret or a personal datum reaching
   a log, a client bundle, or a third party.
6. **What the change forgot.** A rename applied in two places out of three, a new branch with
   no test, a migration with no way back.

# How to write it

- Every bullet starts with a \`path:line\` in backticks, path relative to the repository root.
- A line number is read, never estimated. Only cite numbers visible in the numbered excerpts
  below. When a file comes as diff only, cite the path with no line number.
- **Never state what a file contains unless that file was included below**, not even to support
  a comparison. If your point depends on a file you were not given, phrase it as a question.

# Two habits that ruin a review

Both are confabulation: a plausible sentence you did not verify. One wrong detail makes the
reader doubt the whole finding, and a true finding dies with its invented supporting evidence.

1. **Padding a line list.** You read one occurrence, then list neighbours you assume are alike.

   WRONG \u2014 \xAB le fichier dit encore \xAB page 2 \xBB (lignes 10, 28, 52, 384) \xBB
   RIGHT \u2014 \xAB le fichier dit encore \xAB page 2 \xBB, par exemple ligne 10, et probablement ailleurs \xBB

   Cite exactly one line number per finding: the one you actually read. Say the rest in words.

2. **Inventing the contrast.** A rename in this PR does not tell you what any other file says
   now. Do not complete the story.

   WRONG \u2014 \xAB alors que template.md dit d\xE9sormais \xAB partie 2 \xBB \xBB
   RIGHT \u2014 \xAB \xE0 confronter au vocabulaire retenu ailleurs, que je n'ai pas sous les yeux \xBB

   Assert a file's contents only by quoting a string you can see in its excerpt above.
- Do not recite the rule: say what breaks HERE and what it produces. \xAB Cha\xEEne FR en dur \xBB is
  worthless; \xAB ce libell\xE9 de bouton est \xE9ditorial, il doit vivre dans le contenu sinon il
  \xE9chappe \xE0 l'admin et \xE0 la traduction \xBB is worth something.
- ${options.maxFindings} bullets maximum across Bloquant, \xC0 corriger and Suggestions, plus at
  most five under \xC0 v\xE9rifier. Past that nobody reads you. If you have more, keep the costly
  ones. This ceiling is there to rank your findings, never to justify dropping one in silence:
  when you cut, say so in the Verdict.
- Do not comment on formatting or style that lint and Prettier already settle.
- No summary of the PR, no compliments, no closing paragraph. The author wrote it.
- A finding outside the PR's scope is labelled as such, goes under Suggestions, and proposes
  opening an issue. It never blocks.
- Write in French. Never use an em dash.

# Which section

- Bloquant: breaks production, loses or exposes data, leaks a secret or personal data, or
  introduces a certain functional regression.
- \xC0 corriger: breaks a rule from the doctrine above, or a probable but undemonstrated bug.
- Suggestions: optional improvements, debt, test blind spots.
- \xC0 v\xE9rifier: what you cannot settle with the files you were given. A suspicion about a caller
  you were not shown, an invariant you could not confirm, a behaviour that depends on data you
  cannot see. Say what would confirm or kill it. Sending a real doubt here is right; sending a
  finding you could have proven from the excerpts above is not.`;
}
function buildUserPrompt(meta, context) {
  const fileList = meta.files.map((file) => {
    const flag = context.skipped.includes(file.path) ? " (not reviewed)" : "";
    return `- ${file.path} (+${file.additions} / -${file.deletions}, ${file.status})${flag}`;
  }).join("\n");
  const contents = context.files.length > 0 ? context.files.map((file) => `### ${file.path}

\`\`\`
${file.numbered}
\`\`\``).join("\n\n") : "(no full content available, work from the diff alone)";
  const omitted = context.omitted.length > 0 ? `

No full content for these files, for lack of room. You only have their diff, so cite them without a line number:
${context.omitted.map((path) => `- ${path}`).join("\n")}` : "";
  return `# PR #${meta.number} \u2014 ${meta.title}

Base branch: ${meta.baseRefName}

## Author's description

${meta.body.trim() || "(empty)"}

## Changed files

${fileList}${omitted}

## Diff

\`\`\`diff
${context.diff}
\`\`\`

## Full content of the changed files, after the change

Lines are numbered. That number is the one you cite in \`path:line\`. Any file absent from this
section was not given to you: do not describe its contents.

${contents}`;
}

// pr-review/src/render.ts
var MARKER = "<!-- ollama-review -->";
var FIRST_HEADING = "## Verdict";
var MAX_LENGTH = 12e3;
function extractReview(content) {
  const withoutTags = content.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "").trim();
  const start = withoutTags.lastIndexOf(FIRST_HEADING);
  if (start !== -1) return withoutTags.slice(start).trim();
  if (withoutTags.length > MAX_LENGTH) {
    return `_Le mod\xE8le n'a pas suivi le gabarit. Fin de sa r\xE9ponse, tronqu\xE9e :_

${withoutTags.slice(-MAX_LENGTH)}`;
  }
  return withoutTags;
}
function linkifyPaths(markdown, options) {
  return mapOutsideFences(
    markdown,
    (segment) => segment.replace(/`([^`\n]+)`/g, (match, inner) => {
      const parsed = /^(.+?)(?::(\d+))?$/.exec(inner.trim());
      const path = parsed?.[1];
      const line = parsed?.[2];
      if (!path || !options.knownPaths.has(path)) return match;
      const anchor = line ? `#L${line}` : "";
      return `[${match}](${options.repoUrl}/blob/${options.headSha}/${path}${anchor})`;
    })
  );
}
function mapOutsideFences(markdown, transform) {
  const parts = markdown.split(/(^```[\s\S]*?^```[ \t]*$)/gm);
  return parts.map((part) => part.startsWith("```") ? part : transform(part)).join("");
}
function formatDuration(ms) {
  const seconds = Math.round(ms / 1e3);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}
var count = (value) => value.toLocaleString("fr-FR");
function renderFooter(footer) {
  const bits = [
    `${footer.model} via Ollama Cloud`,
    formatDuration(footer.durationMs),
    `${count(footer.promptTokens)} tokens en entr\xE9e, ${count(footer.evalTokens)} en sortie`
  ];
  if (footer.thinkingChars > 0) {
    bits.push(`${count(Math.round(footer.thinkingChars / 1024))} Ko de raisonnement`);
  }
  if (footer.skipped.length > 0) {
    bits.push(`${footer.skipped.length} fichier(s) g\xE9n\xE9r\xE9s ignor\xE9s`);
  }
  if (footer.omitted.length > 0) {
    bits.push(`diff seul (sans contexte complet) pour ${footer.omitted.join(", ")}`);
  }
  return `<sub>${bits.join(" \xB7 ")}</sub>`;
}
function renderComment(input) {
  const body = linkifyPaths(extractReview(input.review), input);
  return `${MARKER}
## Review automatique

${body}

---

${renderFooter(input.footer)}`;
}
function renderFailureComment(reason, model) {
  return `${MARKER}
## Review automatique

La review n'a pas pu \xEAtre produite : ${reason}

<sub>Mod\xE8le vis\xE9 : ${model}. Le check reste vert, cette review n'est pas bloquante.</sub>`;
}

// pr-review/src/index.ts
var DEFAULT_KEY_REF = "op://Personal/Ollama/add more/api_key";
function repoRoot() {
  return process.env.GITHUB_WORKSPACE ?? process.cwd();
}
function readDoctrine(root, paths) {
  const files = [];
  for (const path of paths) {
    try {
      files.push({ path, content: readFileSync(join(root, path), "utf-8") });
    } catch {
      console.log(`\xB7 ${path} : absent, ignor\xE9.`);
    }
  }
  if (files.length === 0) {
    console.warn(
      `\u26A0 Aucun fichier de doctrine trouv\xE9 parmi : ${paths.join(", ")}.
  La review tournera sur des crit\xE8res g\xE9n\xE9riques. Renseigne l'input \xAB doctrine \xBB.`
    );
  }
  return files;
}
async function warnOnDetachedContext(headSha) {
  const head = await currentHeadSha();
  if (head && head !== headSha) {
    console.warn(
      `\u26A0 Le d\xE9p\xF4t est sur ${head.slice(0, 8)}, la PR sur ${headSha.slice(0, 8)} : le contenu lu ne
  correspond pas au diff. Pour un r\xE9glage de prompt fid\xE8le, fais d'abord \xAB gh pr checkout \xBB.`
    );
  }
}
async function keyFrom1Password() {
  if (process.env.GITHUB_ACTIONS === "true") return "";
  const ref = process.env.OLLAMA_API_KEY_REF ?? DEFAULT_KEY_REF;
  try {
    return (await run("op", ["read", ref])).trim();
  } catch {
    console.warn(`\u26A0 Cl\xE9 absente et lecture de ${ref} impossible (1Password verrouill\xE9 ?).`);
    return "";
  }
}
async function review(config) {
  const root = repoRoot();
  console.log(`Lecture de la PR #${config.pr}\u2026`);
  const [repo, meta, rawDiff] = await Promise.all([
    resolveRepo(),
    fetchPrMeta(config.pr),
    fetchPrDiff(config.pr)
  ]);
  await warnOnDetachedContext(meta.headSha);
  const context = assembleContext({
    rawDiff,
    prFiles: meta.files,
    isSkipped: compileMatcher(config.skip),
    budget: { totalChars: config.budgetChars, perFileChars: config.perFileChars },
    readFile: (path) => {
      try {
        return readFileSync(join(root, path), "utf-8");
      } catch {
        return null;
      }
    }
  });
  if (context.diff.trim() === "") {
    console.log("Aucun fichier relisible dans cette PR (g\xE9n\xE9r\xE9s, binaires ou lockfiles seulement).");
    return;
  }
  const system = buildSystemPrompt({
    repo,
    projectSummary: config.projectSummary,
    doctrine: readDoctrine(root, config.doctrine),
    maxFindings: config.maxFindings
  });
  const user = buildUserPrompt(meta, context);
  console.log(
    `Contexte : ${context.files.length} fichier(s) en int\xE9gral, ${Math.round((system.length + user.length) / 1024)} Ko envoy\xE9s \xE0 ${config.model}.`
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
      onRetry: (reason) => console.warn(`\u26A0 ${reason} \u2014 nouvelle tentative dans 20 s.`),
      onDowngrade: (reason) => console.warn(
        `\u26A0 ${config.model} n'a pas accept\xE9 \xAB thinking: ${config.thinking} \xBB (${reason}).
  Review relanc\xE9e sans raisonnement explicite : elle sera moins fouill\xE9e.`
      )
    });
  } catch (error) {
    const reason = error instanceof OllamaError ? error.message : String(error);
    console.error(`\xC9chec de la review : ${reason}`);
    if (!config.dryRun) await postComment(config.pr, renderFailureComment(reason, config.model));
    return;
  }
  const server = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
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
      omitted: context.omitted
    }
  });
  if (config.dryRun) {
    console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 review (dry-run, non post\xE9e) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
    console.log(comment);
    return;
  }
  await postComment(config.pr, comment);
  console.log(`Review post\xE9e sur la PR #${config.pr}.`);
}
async function main() {
  const config = resolveConfig({
    argv: process.argv.slice(2),
    env: process.env,
    warn: (message) => console.warn(`\u26A0 ${message}`)
  });
  if (config.githubToken) process.env.GH_TOKEN = config.githubToken;
  if (!config.apiKey) config.apiKey = await keyFrom1Password();
  if (!config.apiKey) {
    console.log("Cl\xE9 Ollama absente : review ignor\xE9e.");
    return;
  }
  await review(config);
}
main().catch((error) => {
  console.error(`Review interrompue : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof UsageError ? 1 : 0;
});
