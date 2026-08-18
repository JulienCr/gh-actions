#!/usr/bin/env node

// pr-review/src/index.ts
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// pr-review/src/imports.ts
var EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"];
var ALIAS_BASES = ["src/", "", "app/"];
var PATTERNS = [
  // import x from 'y' ; export { a } from 'y' ; export * from 'y'
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  // import 'y' (effet de bord : feuille de style, polyfill)
  /\bimport\s+['"]([^'"\n]+)['"]/g,
  // import('y'), et import('y', { with: { type: 'json' } }) : la parenthèse
  // fermante n'est pas exigée, sans quoi un import à attributs serait raté et
  // le fichier ne serait jamais joint.
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
  // require('y')
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g
];
function isInternal(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("@/");
}
function extractImports(content) {
  const found = /* @__PURE__ */ new Map();
  for (const pattern of PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier || !isInternal(specifier) || found.has(specifier)) continue;
      found.set(specifier, match.index);
    }
  }
  return [...found].sort((a, b) => a[1] - b[1]).map(([specifier]) => specifier);
}
function normalizePath(path) {
  const segments = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    if (segments.length === 0) return null;
    segments.pop();
  }
  return segments.length > 0 ? segments.join("/") : null;
}
function dirOf(path) {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}
function candidates(base) {
  const list = [base];
  const jsToTs = /\.(js|jsx|mjs|cjs)$/.exec(base);
  if (jsToTs) {
    const stem = base.slice(0, -jsToTs[0].length);
    list.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  }
  for (const extension of EXTENSIONS) list.push(`${base}${extension}`);
  for (const extension of EXTENSIONS) list.push(`${base}/index${extension}`);
  return list;
}
function resolveImport(fromPath, specifier, exists) {
  const bases = [];
  if (specifier.startsWith("@/")) {
    const rest = specifier.slice("@/".length);
    for (const base of ALIAS_BASES) bases.push(`${base}${rest}`);
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    bases.push(`${dirOf(fromPath)}/${specifier}`);
  } else {
    return null;
  }
  for (const base of bases) {
    const normalized = normalizePath(base);
    if (normalized === null) continue;
    for (const candidate of candidates(normalized)) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
function collectImports(sources, options) {
  const seen = new Set(sources.map((source) => source.path));
  const collected = [];
  for (const source of sources) {
    for (const specifier of extractImports(source.content)) {
      const resolved = resolveImport(source.path, specifier, options.exists);
      if (resolved === null || seen.has(resolved)) continue;
      seen.add(resolved);
      if (options.isExcluded(resolved)) continue;
      collected.push(resolved);
    }
  }
  return collected;
}

// pr-review/src/context.ts
function hasContent(file, isSkipped) {
  return !isSkipped(file.path) && file.status !== "removed";
}
function touchesLines(file) {
  return file.additions + file.deletions > 0 || file.status === "added";
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
var FOLDED_NOTE = "(entirely new file: every line is an addition, see its full numbered content below)";
function foldAddedFiles(diff, folded) {
  if (folded.size === 0) return diff;
  return splitDiffByFile(diff).map((chunk) => {
    if (!folded.has(chunk.path)) return chunk.body;
    const lines = chunk.body.split("\n");
    const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
    if (firstHunk === -1) return chunk.body;
    return [...lines.slice(0, firstHunk), FOLDED_NOTE].join("\n");
  }).join("\n");
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
  exists,
  isSkipped,
  budget
}) {
  const { diff, skipped } = filterDiff(rawDiff, isSkipped);
  const sources = [];
  const omitted = [];
  let used = 0;
  const candidates2 = prFiles.filter((file) => hasContent(file, isSkipped) && touchesLines(file)).sort((a, b) => a.additions + a.deletions - (b.additions + b.deletions));
  for (const file of candidates2) {
    const content = readFile(file.path);
    if (content === null) continue;
    if (content.length > budget.perFileChars || used + content.length > budget.totalChars) {
      omitted.push(file.path);
      continue;
    }
    used += content.length;
    sources.push({ path: file.path, content });
  }
  const order = new Map(prFiles.map((file, index) => [file.path, index]));
  sources.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));
  const files = sources.map((source) => ({
    path: source.path,
    numbered: numberLines(source.content)
  }));
  const imported = readImported({ sources, readFile, exists, isSkipped, budget });
  const supplied = new Set(sources.map((source) => source.path));
  const added = new Set(
    prFiles.filter((file) => file.status === "added" && supplied.has(file.path)).map((file) => file.path)
  );
  return { diff: foldAddedFiles(diff, added), files, imported, skipped, omitted };
}
function contextFor(context, imports) {
  return imports ? context : { ...context, imported: [] };
}
function readImported({ sources, readFile, exists, isSkipped, budget }) {
  if (budget.importedChars <= 0) return [];
  const paths = collectImports(sources, { exists, isExcluded: isSkipped });
  const contents = /* @__PURE__ */ new Map();
  for (const path of paths) {
    const content = readFile(path);
    if (content !== null && content.length <= budget.perFileChars) contents.set(path, content);
  }
  const kept = /* @__PURE__ */ new Set();
  let used = 0;
  for (const [path, content] of [...contents].sort((a, b) => a[1].length - b[1].length)) {
    if (used + content.length > budget.importedChars) continue;
    used += content.length;
    kept.add(path);
  }
  return paths.filter((path) => kept.has(path)).map((path) => ({ path, numbered: numberLines(contents.get(path)) }));
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
function statusOf(changeType) {
  switch (changeType?.toUpperCase()) {
    case "ADDED":
      return "added";
    case "DELETED":
      return "removed";
    case "RENAMED":
      return "renamed";
    default:
      return "modified";
  }
}
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
      status: statusOf(file.changeType)
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

// pr-review/src/prompt.ts
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
function buildPreamble(options) {
  const summary = options.projectSummary.trim();
  return `You are reviewing a pull request on the \`${options.repo}\` repository.
${summary ? `
${summary}
` : ""}
You run when the PR is opened, before any human reads it. Your job is to catch what a generic
linter cannot see: this project's own rules, functional regressions, and data leaks.

${renderDoctrine(options.doctrine)}

# How hard to look

Your job is coverage, not curation. A finding you swallowed because you were not sure enough
is a bug that ships. Report what you find and let its label carry your confidence: a doubt is
reported as a doubt, never dropped.

- **Read every file you were given in full**, not only the changed lines. The diff says what
  moved; the code around it says what that broke. A reviewer who only reads \xAB + \xBB lines finds
  only typos.
- **Do not soften a finding into silence.** When something looks wrong but you cannot prove it
  from what you were given, say what you saw, what you suspect, and which file would settle it.
- **Finding nothing is a claim, not a default.** If this pass turns up nothing, say what you
  checked in order to say it. If you cannot name what you checked, you have not checked.

# Citing code

- Every finding starts with a \`path:line\` in backticks, path relative to the repository root.
- A line number is read, never estimated. Only cite numbers visible in the numbered excerpts you
  were given. When a file comes as diff only, cite the path with no line number.
- **Never state what a file contains unless that file was included in your context**, not even
  to support a comparison. If your point depends on a file you were not given, say so.

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

   Assert a file's contents only by quoting a string you can see in one of its excerpts.`;
}
function buildUserPrompt(meta, context) {
  const fileList = meta.files.map((file) => {
    const flag = context.skipped.includes(file.path) ? " (not reviewed)" : "";
    return `- ${file.path} (+${file.additions} / -${file.deletions}, ${file.status})${flag}`;
  }).join("\n");
  const contents = context.files.length > 0 ? context.files.map(renderFile).join("\n\n") : "(no full content available, work from the diff alone)";
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

Lines are numbered. That number is the one you cite in \`path:line\`. Any file absent from ${context.imported.length > 0 ? "this section and from the next one" : "this section"} was not given to you: do not describe its contents.

${contents}${renderImported(context.imported)}`;
}
var renderFile = (file) => `### ${file.path}

\`\`\`
${file.numbered}
\`\`\``;
function renderImported(files) {
  if (files.length === 0) return "";
  return `

## Context files, NOT modified by this PR

These are here so you can settle a question instead of asking it: what a caller expects, what an
enum actually contains, whether a helper counts characters or bytes. Same numbering, and you may
cite them as evidence.

**Do not review them.** Every finding must be about a changed file listed above. A defect that
lives only in one of these files is out of scope: this PR did not introduce it, and its author
did not ask. Use them to prove or to kill a doubt about the change itself.

${files.map(renderFile).join("\n\n")}`;
}

// pr-review/src/passes.ts
var PASS_HEADING = "## Trouvailles";
var passOutput = (hasImports) => `# What to return

Return \`${PASS_HEADING}\` followed by one bullet per finding, in French, nothing else. No verdict,
no summary, no closing paragraph: another pass writes those.

${PASS_HEADING}
- [bloquant] \`chemin/fichier.ts:42\` : ce qui casse, et ce que \xE7a produit ici.
- [corriger] \`chemin/fichier.tsx:17\` : \u2026
- [suggestion] \`chemin/fichier.ts:88\` : \u2026
- [doute] \`chemin/fichier.ts:120\` : ce que tu soup\xE7onnes sans pouvoir le prouver, et ce qu'il
  faudrait regarder pour trancher.

Labels, one per bullet:

- **bloquant**: breaks production, loses or exposes data, leaks a secret or personal data, or
  introduces a certain functional regression.
- **corriger**: breaks a rule from the doctrine above, or a probable but undemonstrated bug.
- **suggestion**: optional improvement, debt, test blind spot. A finding outside this PR's scope
  goes here, labelled as such, and proposes opening an issue. It never blocks.
- **doute**: what you cannot settle with the files you were given. Say what would settle it.${hasImports ? "\n  A doubt that the context files above DO settle is not a doubt: read them and conclude." : ""}

No ceiling on this pass: report everything you found on your axis. Ranking happens later.

Do not recite the rule, say what breaks HERE and what it produces. \xAB Cha\xEEne FR en dur \xBB is
worthless; \xAB ce libell\xE9 de bouton est \xE9ditorial, il doit vivre dans le contenu sinon il \xE9chappe \xE0
l'admin et \xE0 la traduction \xBB is worth something.

Never use an em dash. The merge pass is told not to rewrite your wording, so anything you write
here reaches the posted comment as is.

Found nothing? Return \`${PASS_HEADING}\` and a single bullet \xAB - [rien] : \xBB followed by what you
actually checked to be able to say it. Never an empty section.`;
var EFFORTS = ["full", "balanced", "lean"];
var isEffort = (value) => EFFORTS.includes(value);
var LEVELS = ["low", "medium", "high", "max"];
function stepDown(level, steps) {
  if (steps <= 0) return level;
  const index = LEVELS.indexOf(level.trim().toLowerCase());
  if (index === -1) return level;
  return LEVELS[Math.max(0, index - steps)];
}
var PROSE_ONLY = [".md", ".mdx", ".txt", ".rst", ".adoc"];
function extensionOf(path) {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}
var runsSomething = (files) => files.some((file) => !PROSE_ONLY.includes(extensionOf(file.path)));
var PASSES = [
  {
    id: "regression",
    label: "r\xE9gression fonctionnelle",
    axis: "functional regressions",
    // Sa matière première : son premier axe s'appelle « The caller's side ».
    imports: { full: true, balanced: true, lean: true },
    // L'axe le plus coûteux à creuser, et celui qui le mérite : tracer un
    // appelant, un chemin d'erreur ou une course est une recherche, pas un
    // parcours de liste. Il garde son raisonnement à tous les crans.
    thinkingSteps: { full: 0, balanced: 0, lean: 0 },
    skipWhen: ({ files }) => runsSomething(files) ? null : "aucun fichier ex\xE9cutable dans cette PR",
    objective: `# Your one job in this pass: functional regressions

You are not looking at conventions, style, or data access. Another pass covers those. You are
looking for code that will misbehave at runtime. Walk these deliberately, on every changed file.
None of them is visible in a diff read line by line, which is exactly why they survive until
production.

1. **The caller's side.** A changed signature, return shape, thrown error or nullability breaks
   whoever calls it. The context files include what the changed files import: use them. When the
   caller is genuinely absent from your context, report a doubt.
2. **Error paths.** What happens when this throws, returns null, times out, or gets an empty
   list? An error caught, logged and swallowed is a silent failure: the feature is dead and
   nobody is told.
3. **Edge inputs.** Empty, zero, one element, duplicates, very large. Boundaries of a loop, a
   slice, a pagination. Off-by-one on both ends.
4. **State and ordering.** Two runs racing, a retry replaying a side effect, a cache or a ledger
   written before the thing it records actually succeeded, a missing await.
5. **What the change forgot.** A rename applied in two places out of three, a new branch with no
   test, a migration with no way back, a flag read but never set.`
  },
  {
    id: "doctrine",
    label: "doctrine du d\xE9p\xF4t",
    axis: "the repository's own conventions",
    // Elle juge la PR contre un document qu'elle a déjà sous les yeux, et son
    // prompt lui interdit de relever quoi que ce soit dans un fichier non
    // modifié : les appelants et les enums ne lui apprennent rien.
    imports: { full: true, balanced: false, lean: false },
    thinkingSteps: { full: 0, balanced: 0, lean: 2 },
    // Son propre prompt lui dicte alors sa sortie mot pour mot (« say so in a
    // single « - [rien] : » bullet and stop »). La lancer revient à payer un
    // contexte entier et un raisonnement pour une réponse écrite d'avance,
    // ce qui n'a de sens à aucun cran.
    skipWhen: ({ hasDoctrine }) => hasDoctrine ? null : "ce d\xE9p\xF4t ne fournit aucun fichier de doctrine",
    objective: `# Your one job in this pass: the repository's own rules

Judge this PR against the doctrine quoted above, and against nothing else. Other passes cover
runtime bugs and data access; a remark of yours that does not trace back to a written rule of
this repository does not belong in this pass.

- Go rule by rule through the doctrine, and check the changed files against each one that
  applies. A rule nobody checks is a rule that decays.
- **Quote the rule you are applying**, in a few words, so the author can tell a project rule from
  a personal habit. If you cannot point to the rule, you are inventing it.
- Silence is a claim here too: if the PR respects the doctrine, say which rules you actually
  checked it against.
- Ignore formatting and style that lint and Prettier already settle. A doctrine is what a linter
  cannot enforce.

If this repository ships no doctrine, say so in a single \xAB - [rien] : \xBB bullet and stop. Do not
substitute your own conventions for the ones it did not write.`
  },
  {
    id: "data",
    label: "donn\xE9es et acc\xE8s",
    axis: "data access",
    // Son cinquième axe compare la forme exposée avant et après, et sa règle de
    // preuve renvoie aux extraits fournis : lui couper le contexte
    // transformerait des trouvailles en « doute », soit exactement le régime que
    // le contexte importé a été introduit pour supprimer.
    imports: { full: true, balanced: true, lean: false },
    thinkingSteps: { full: 0, balanced: 0, lean: 1 },
    // Aucune règle, à aucun cran. Un README fuit une clé aussi bien qu'un .ts,
    // une doc d'API publie un endpoint interne, une capture collée porte une
    // adresse. Le coût d'une fuite dépasse de plusieurs ordres celui d'une
    // passe : ce trou ne doit pas être « optimisé » dans six mois.
    objective: `# Your one job in this pass: data, secrets, and access boundaries

Not runtime bugs, not conventions. Who can read what, and what escapes to where.

1. **Role boundaries.** A query that returns rows the caller has no right to see. A filter on
   tenant, owner or role that the change dropped, widened, or moved after the fetch instead of
   into it. An admin path reachable without the check.
2. **Secrets.** A key, token or password reaching a log, an error message, a client bundle, a URL
   or a third party. A secret read from the wrong place, or committed.
3. **Personal data.** An email, a phone number, an address, an IP in a log line, an analytics
   payload, a redirect, or a message to an external service. Ask what the recipient can see.
4. **Trust in inputs.** Data from a request used unvalidated in a query, a path, a redirect, a
   command, or rendered as HTML.
5. **What the endpoint exposes.** A new route, field or serializer that widens what leaves the
   server. Compare with what the previous shape returned.

Prove it from what you were given: a boundary crossing you cannot see in the excerpts is a
\xAB doute \xBB, with the file that would settle it named.`
  }
];
function selectPasses(input, options) {
  if (options.forced.length > 0) {
    const wanted = new Set(options.forced.map((id) => id.trim().toLowerCase()));
    const run3 = PASSES.filter((pass) => wanted.has(pass.id));
    if (run3.length > 0) {
      return { run: [...run3], skipped: [] };
    }
    options.warn?.(
      `input \xAB passes \xBB : aucun identifiant connu dans \xAB ${options.forced.join(", ")} \xBB.
  Connus : ${PASSES.map((pass) => pass.id).join(", ")}. On lance les trois.`
    );
    return { run: [...PASSES], skipped: [] };
  }
  const run2 = [];
  const skipped = [];
  for (const pass of PASSES) {
    const applies = options.auto || pass.id === "doctrine";
    const reason = applies ? pass.skipWhen?.(input) ?? null : null;
    if (reason === null) run2.push(pass);
    else skipped.push({ label: pass.label, reason });
  }
  if (run2.length === 0) return { run: [...PASSES], skipped: [] };
  return { run: run2, skipped };
}
function buildPassSystemPrompt(pass, options, hasImports) {
  return `${buildPreamble(options)}

${pass.objective}

${passOutput(hasImports)}`;
}
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
function enumerate(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
var WORDS = ["no", "a single", "two", "three", "four", "five"];
function opening(repo, passes) {
  const axes = enumerate(passes.map((pass) => pass.axis));
  if (passes.length === 1) {
    return `One reviewer has just read a pull request on \`${repo}\`, on a single axis: ${axes}.`;
  }
  const word = WORDS[passes.length] ?? String(passes.length);
  return `${word[0].toUpperCase()}${word.slice(1)} reviewers have just read the same pull request on \`${repo}\`, each on one axis: ${axes}.`;
}
function buildMergeSystemPrompt(options) {
  return `${opening(options.repo, options.passes)} You are assembling
their findings into the single comment that gets posted on the PR.

**You do not have the code.** You only have what they wrote. So:

- Never add a finding. If it is not in their lists, it does not exist.
- Never invent a line number, a path, or a detail to make a bullet sound firmer. Keep the
  \`path:line\` they wrote, exactly as they wrote it.
- When a bullet is too vague to be useful, keep it as is or drop it. Do not complete it.

# What to do with their findings

1. **Deduplicate.** Two reviewers describe the same defect in different words: keep one bullet,
   the one that says best what breaks and what it produces. Two defects in the same file are not
   duplicates.
2. **Arbitrate the label.** They each judged on their own axis and could not see the others. A
   \xAB corriger \xBB that turns out to lose data is \xAB Bloquant \xBB. A \xAB bloquant \xBB resting on an
   unverified assumption belongs under \xAB \xC0 v\xE9rifier \xBB.
3. **Rank, then cut.** ${options.maxFindings} bullets maximum across Bloquant, \xC0 corriger and
   Suggestions, plus at most five under \xC0 v\xE9rifier. Past that nobody reads. Keep the costly ones.
   **When you cut, say so in the Verdict**: this ceiling ranks findings, it never justifies
   dropping one in silence.
4. **Drop the \xAB rien \xBB bullets**, but remember what they checked: that is what makes a
   \xAB Rien \xE0 signaler \xBB credible.

# Expected output

Return exactly these five sections, in this order, as markdown, and nothing before them.

${OUTPUT_TEMPLATE}

- A section with nothing in it says what was checked, on the same line:
  \xAB Rien \xE0 signaler (chemins d'erreur et valeurs de retour relus) \xBB. Take that from what the
  reviewers said they checked. If they said nothing, write \xAB Rien \xE0 signaler \xBB.
- No summary of the PR, no compliments, no closing paragraph. The author wrote it.
- Write in French. Never use an em dash.`;
}
function buildMergeUserPrompt(meta, results) {
  const blocks = results.map((result) => `## Reviewer: ${result.pass.label}

${result.findings.trim()}`).join("\n\n");
  const fileList = meta.files.map((file) => `- ${file.path} (+${file.additions} / -${file.deletions}, ${file.status})`).join("\n");
  return `# PR #${meta.number} \u2014 ${meta.title}

## Author's description

${meta.body.trim() || "(empty)"}

## Files changed by this PR

Every finding you keep must be about one of these. A path that is not in this list came from a
context file, which this PR does not touch: drop that finding.

${fileList}

# What the reviewers found

${blocks}`;
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
  /**
   * Budget des fichiers importés, distinct de celui des fichiers touchés.
   *
   * Mesuré sur une PR réelle : 92 000 tokens envoyés pour une fenêtre de
   * 976 000. La place existe, et elle sert exactement là où le modèle devait
   * renoncer à trancher faute d'avoir l'appelant sous les yeux. `0` désactive.
   */
  importsBudgetChars: 3e5,
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
   * Effort de raisonnement de la fusion, plus bas que celui des passes.
   *
   * Les passes lisent quatre-vingt-dix kilo-octets de code, la fusion trie une
   * trentaine de puces sans avoir le code sous les yeux : `max` n'y achèterait
   * que de la latence. Les passes tournant en parallèle, elles coûtent le temps
   * d'une seule, et c'est la fusion qui s'ajoute au mur du job.
   */
  mergeThinking: "high",
  /**
   * Surtout pas 0. Le décodage glouton sur un modèle de raisonnement raccourcit
   * la chaîne de pensée et la fait tourner en rond ; 1 est la valeur des
   * exemples officiels de GLM-5. La stabilité d'un jour à l'autre est confiée à
   * la graine, qui la sert sans coûter en profondeur.
   */
  temperature: 1,
  seed: 1,
  /** Nom du bras quand on n'en donne pas : celui du réglage livré. */
  variant: "default",
  /**
   * Le cran par défaut.
   *
   * « balanced » et non « full » : ce que `full` garde en plus, ce sont des
   * envois dont la mesure n'a pas montré qu'ils rapportaient une trouvaille.
   * Un dépôt qui veut la lecture la plus large l'écrit, et le sait.
   */
  effort: "balanced",
  /** Plafond des imports au cran « lean », où le contexte se resserre. */
  leanImportsBudgetChars: 12e4
};
var UsageError = class extends Error {
};
function readInput(env, name) {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
function readNumber(env, name, fallback, warn, minimum = 1) {
  const raw = readInput(env, name);
  if (raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    warn(`input \xAB ${name} \xBB illisible (\xAB ${raw} \xBB) : on garde ${fallback}.`);
    return fallback;
  }
  return parsed;
}
function readEffort(env, warn) {
  const raw = readInput(env, "effort").toLowerCase();
  if (raw === "") return DEFAULTS.effort;
  if (isEffort(raw)) return raw;
  warn(
    `input \xAB effort \xBB inconnu (\xAB ${raw} \xBB) : on garde ${DEFAULTS.effort}.
  Valeurs accept\xE9es : ${EFFORTS.join(", ")}.`
  );
  return DEFAULTS.effort;
}
function readBoolean(env, name) {
  return /^(true|1|yes)$/i.test(readInput(env, name));
}
function isEnabled(env) {
  return !/^(false|0|no|off)$/i.test(readInput(env, "enable"));
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
  let countOnly2 = false;
  let variant = readInput(env, "variant") || DEFAULTS.variant;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--count-only") {
      countOnly2 = true;
      dryRun = true;
    } else if (arg === "--model") {
      const value = argv[++index];
      if (!value) throw new UsageError("\xAB --model \xBB attend un nom de mod\xE8le.");
      model = value;
    } else if (arg === "--variant") {
      const value = argv[++index];
      if (!value) throw new UsageError("\xAB --variant \xBB attend un nom.");
      variant = value;
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
  const effort = readEffort(env, warn);
  return {
    pr,
    dryRun,
    model,
    // Pas de validation contre une liste de niveaux : ils varient d'un modèle à
    // l'autre, et un niveau refusé est rattrapé à l'appel.
    thinking: readInput(env, "thinking") || DEFAULTS.thinking,
    mergeThinking: readInput(env, "merge-thinking") || DEFAULTS.mergeThinking,
    temperature: readTemperature(env, warn),
    seed: readSeed(env, warn),
    maxFindings: readNumber(env, "max-findings", DEFAULTS.maxFindings, warn),
    budgetChars: readNumber(env, "budget-chars", DEFAULTS.budgetChars, warn),
    perFileChars: readNumber(env, "per-file-chars", DEFAULTS.perFileChars, warn),
    effort,
    passes: parseList(readInput(env, "passes")),
    // Le cran pose le défaut, l'input explicite l'écrase : régler « effort » ne
    // doit pas rendre un budget écrit à la main silencieusement inopérant.
    importsBudgetChars: readNumber(
      env,
      "imports-budget-chars",
      effort === "lean" ? DEFAULTS.leanImportsBudgetChars : DEFAULTS.importsBudgetChars,
      warn,
      0
    ),
    timeoutMs: readNumber(env, "timeout-minutes", DEFAULTS.timeoutMinutes, warn) * 6e4,
    doctrine: doctrineInput.length > 0 ? doctrineInput : [...DEFAULT_DOCTRINE],
    // Le plancher d'abord : ce qui suit ne peut qu'ajouter, jamais retirer.
    skip: [...ALWAYS_SKIPPED, ...parseList(readInput(env, "skip"))],
    projectSummary: readInput(env, "project-summary"),
    countOnly: countOnly2,
    variant,
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
async function* streamLines(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut = buffer.indexOf("\n");
    while (cut !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (line) yield line;
      cut = buffer.indexOf("\n");
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest) yield rest;
}
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
async function attempt(options) {
  const started = Date.now();
  const payload = await request(options);
  return {
    content: payload.message?.content ?? "",
    promptTokens: payload.prompt_eval_count ?? 0,
    evalTokens: payload.eval_count ?? 0,
    thinkingChars: payload.message?.thinking?.length ?? 0,
    durationMs: Date.now() - started
  };
}
async function chat(options) {
  try {
    return await attempt(options);
  } catch (error) {
    if (!(error instanceof OllamaError)) throw error;
    if (error.thinkingRejected && options.think) {
      const fallback = rejectsThinkingValue(error.message) ? "true" : "";
      options.onDowngrade?.(error.message);
      return attempt({ ...options, think: fallback });
    }
    if (!error.retryable) throw error;
    options.onRetry?.(error.message);
    await sleep(options.retryDelayMs ?? RETRY_DELAY_MS);
    return attempt(options);
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
        stream: true,
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
    throw transportError(error, timeoutMs);
  }
  try {
    if (!response.ok) {
      const text = await response.text();
      throw new OllamaError(
        `HTTP ${response.status} ${describeStatus(response.status)}${detail(text)}`,
        worthRetrying(response.status),
        rejectsThinking(response.status, text)
      );
    }
    return await collect(response);
  } catch (error) {
    if (error instanceof OllamaError) throw error;
    throw transportError(error, timeoutMs);
  }
}
function transportError(error, timeoutMs) {
  if (error instanceof Error && error.name === "TimeoutError") {
    return new OllamaError(`Ollama n'a pas r\xE9pondu en ${Math.round(timeoutMs / 6e4)} min`);
  }
  return new OllamaError(`appel \xE0 Ollama impossible (${describeCause(error)})`, true);
}
function describeCause(error) {
  const chain = [];
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const code = current.code;
    chain.push(typeof code === "string" ? `${current.message} [${code}]` : current.message);
    current = current.cause;
  }
  return redact(chain.length > 0 ? chain.join(" \u2190 ") : String(error));
}
var redact = (text) => text.replace(/\/\/[^/\s@]+@/g, "//***@");
async function collect(response) {
  let content = "";
  let thinking = "";
  let promptTokens = 0;
  let evalTokens = 0;
  let complete = false;
  let fragments = 0;
  for await (const line of streamLines(response.body)) {
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      if (fragments > 0) break;
      throw new OllamaError(`r\xE9ponse illisible d'Ollama (${line.slice(0, 200)})`);
    }
    fragments += 1;
    if (chunk.error) {
      throw new OllamaError(
        `Ollama a r\xE9pondu une erreur : ${chunk.error}`,
        false,
        /think/i.test(chunk.error)
      );
    }
    content += chunk.message?.content ?? "";
    thinking += chunk.message?.thinking ?? "";
    if (chunk.prompt_eval_count !== void 0) promptTokens = chunk.prompt_eval_count;
    if (chunk.eval_count !== void 0) evalTokens = chunk.eval_count;
    if (chunk.done) complete = true;
  }
  if (!complete) {
    throw new OllamaError("le flux d'Ollama s'est interrompu avant la fin de la r\xE9ponse", true);
  }
  if (!content.trim()) {
    throw new OllamaError("Ollama a rendu une r\xE9ponse vide");
  }
  return {
    message: { content, thinking },
    prompt_eval_count: promptTokens,
    eval_count: evalTokens
  };
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

// pr-review/src/render.ts
var MARKER = "<!-- aristarque -->";
var HEADING = "## Aristarque \u2014 review automatique";
var FIRST_HEADING = "## Verdict";
var MAX_LENGTH = 12e3;
function extractReview(content, heading = FIRST_HEADING) {
  const withoutTags = content.replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "").trim();
  const start = withoutTags.lastIndexOf(heading);
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
  if (footer.imported > 0) {
    bits.push(`${footer.imported} fichier(s) import\xE9s joints en contexte`);
  }
  if (footer.skipped.length > 0) {
    bits.push(`${footer.skipped.length} fichier(s) g\xE9n\xE9r\xE9s ignor\xE9s`);
  }
  if (footer.omitted.length > 0) {
    bits.push(`diff seul (sans contexte complet) pour ${footer.omitted.join(", ")}`);
  }
  for (const { label, reason } of footer.skippedPasses) {
    bits.push(`passe \xAB ${label} \xBB non lanc\xE9e (${reason})`);
  }
  if (footer.failedPasses.length > 0) {
    const quoted = footer.failedPasses.map((pass) => `\xAB ${pass} \xBB`);
    const plural = quoted.length > 1 ? "s" : "";
    bits.push(`\u26A0 passe${plural} ${enumerate2(quoted)} non aboutie${plural}`);
  }
  return `<sub>${bits.join(" \xB7 ")}</sub>`;
}
function enumerate2(items) {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}
function renderComment(input) {
  const body = linkifyPaths(extractReview(input.review), input);
  return `${MARKER}
${HEADING}

${body}

---

${renderFooter(input.footer)}`;
}
function renderPartialComment(input) {
  const blocks = input.passes.map((pass) => `### ${pass.label}

${linkifyPaths(pass.findings.trim(), input)}`).join("\n\n");
  return `${MARKER}
${HEADING}

_La synth\xE8se n'a pas pu \xEAtre produite (${input.reason}). Voici les trouvailles brutes des passes qui
ont abouti : ni tri\xE9es, ni d\xE9dupliqu\xE9es, ni plafonn\xE9es._

${blocks}

---

${renderFooter(input.footer)}`;
}
function renderFailureComment(reason, model) {
  return `${MARKER}
${HEADING}

La review n'a pas pu \xEAtre produite : ${reason}

<sub>Mod\xE8le vis\xE9 : ${model}. Le check reste vert, cette review n'est pas bloquante.</sub>`;
}

// pr-review/src/stats.ts
var CHARS_PER_TOKEN = 3.5;
var estimateTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);
var count2 = (value) => value.toLocaleString("fr-FR");
function totals(calls) {
  return calls.reduce(
    (sum, call) => ({
      promptTokens: sum.promptTokens + call.promptTokens,
      evalTokens: sum.evalTokens + call.evalTokens,
      thinkingChars: sum.thinkingChars + call.thinkingChars
    }),
    { promptTokens: 0, evalTokens: 0, thinkingChars: 0 }
  );
}
function reasoningShare(call) {
  const total = call.thinkingChars + call.contentChars;
  if (call.thinkingChars === 0 || total === 0) return null;
  return call.thinkingChars / total;
}
function describeCall(call) {
  const share = reasoningShare(call);
  const reasoning = share === null ? "" : ` dont ~${Math.round(share * 100)} % de raisonnement`;
  const think = call.think ? `, think=${call.think}` : "";
  return `${call.label} en ${Math.round(call.durationMs / 1e3)} s (${count2(call.promptTokens)} tokens en entr\xE9e, ${count2(call.evalTokens)} en sortie${reasoning}${think}).`;
}
var pad = (text, width) => text.padEnd(width);
var padStart = (text, width) => text.padStart(width);
function renderBreakdown(calls, blocks) {
  const labels = calls.map((call) => call.label);
  const width = Math.max(...labels.map((label) => label.length), "appel".length);
  const rows = calls.map((call) => {
    const total = call.systemChars + call.userChars;
    return `  ${pad(call.label, width)}  ${padStart(count2(call.systemChars), 9)}  ${padStart(count2(call.userChars), 10)}  ${padStart(count2(total), 10)}  ${padStart(`~${count2(estimateTokens(total))}`, 10)}`;
  });
  const grand = calls.reduce((sum, call) => sum + call.systemChars + call.userChars, 0);
  const header = `  ${pad("appel", width)}  ${padStart("syst\xE8me", 9)}  ${padStart("user", 10)}  ${padStart("total", 10)}  ${padStart("\u2248 tokens", 10)}`;
  const rule = `  ${"\u2500".repeat(width + 46)}`;
  return [
    header,
    ...rows,
    rule,
    `  ${pad("total entr\xE9e", width)}  ${padStart("", 9)}  ${padStart("", 10)}  ${padStart(count2(grand), 10)}  ${padStart(`~${count2(estimateTokens(grand))}`, 10)}`,
    `  dont : ${describeBlocks(blocks)}`,
    "",
    "  Tokens estim\xE9s : caract\xE8res \xF7 " + CHARS_PER_TOKEN + ". Les caract\xE8res, eux, sont exacts."
  ].join("\n");
}
function describeBlocks(blocks) {
  const total = blocks.system + blocks.diff + blocks.touched + blocks.imported + blocks.meta;
  if (total === 0) return "rien";
  const share = (value) => `${Math.round(value / total * 100)} %`;
  return [
    `diff ${share(blocks.diff)}`,
    `fichiers touch\xE9s ${share(blocks.touched)}`,
    `imports ${share(blocks.imported)}`,
    `syst\xE8me ${share(blocks.system)}`,
    `reste ${share(blocks.meta)}`
  ].join(" \xB7 ");
}
var statsLine = (payload) => `::stats::${JSON.stringify(payload)}`;

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
async function callModel(config, run2, args) {
  const sizes = { systemChars: args.system.length, userChars: args.user.length };
  let result;
  try {
    result = await chat({
      apiKey: config.apiKey,
      model: config.model,
      system: args.system,
      user: args.user,
      think: args.think,
      temperature: config.temperature,
      seed: config.seed,
      timeoutMs: config.timeoutMs,
      onRetry: (reason) => console.warn(`\u26A0 [${args.label}] ${reason} \u2014 nouvelle tentative dans 20 s.`),
      onDowngrade: (reason) => console.warn(
        `\u26A0 [${args.label}] ${config.model} n'a pas accept\xE9 \xAB thinking: ${args.think} \xBB (${reason}).
  Relanc\xE9 sans raisonnement explicite : ce sera moins fouill\xE9.`
      )
    });
  } catch (error) {
    const reason = error instanceof OllamaError ? error.message : String(error);
    console.error(`\u2717 ${args.label} : ${reason}`);
    run2.failures.push(reason);
    run2.calls.push({
      id: args.id,
      label: args.label,
      think: args.think,
      ...sizes,
      promptTokens: 0,
      evalTokens: 0,
      thinkingChars: 0,
      contentChars: 0,
      durationMs: 0,
      ok: false
    });
    return null;
  }
  const stat = {
    id: args.id,
    label: args.label,
    think: args.think,
    ...sizes,
    promptTokens: result.promptTokens,
    evalTokens: result.evalTokens,
    thinkingChars: result.thinkingChars,
    contentChars: result.content.length,
    durationMs: result.durationMs,
    ok: true
  };
  run2.calls.push(stat);
  console.log(`\u2713 ${describeCall(stat)}`);
  return result;
}
async function runPasses(config, run2, plan) {
  const results = await Promise.all(
    plan.map(async ({ pass, system, user, think }) => {
      const result = await callModel(config, run2, {
        id: pass.id,
        system,
        user,
        think,
        label: `passe ${pass.label}`
      });
      if (result === null) return null;
      return { pass, findings: extractReview(result.content, PASS_HEADING) };
    })
  );
  return results.filter((result) => result !== null);
}
function planPasses(config, promptOptions, meta, context, passes) {
  return passes.map((pass) => {
    const wantsImports = pass.imports[config.effort];
    const seen = contextFor(context, wantsImports);
    return {
      pass,
      // La consigne sur les doutes ne s'écrit que s'il y a bien une section de
      // fichiers de contexte à lire : sinon elle désigne du vide.
      system: buildPassSystemPrompt(pass, promptOptions, seen.imported.length > 0),
      user: buildUserPrompt(meta, seen),
      think: stepDown(config.thinking, pass.thinkingSteps[config.effort])
    };
  });
}
function breakdown(plan, context) {
  const first = plan[0];
  const sum = (files) => files.reduce((total, file) => total + file.numbered.length, 0);
  const system = first?.system.length ?? 0;
  const diff = context.diff.length;
  const touched = sum(context.files);
  const imported = sum(context.imported);
  return {
    system,
    diff,
    touched,
    imported,
    // Ce qui reste du prompt user : titre, description, liste des fichiers et
    // consignes. Déduit plutôt que recompté, pour que la somme des parts fasse
    // toujours exactement le prompt envoyé.
    meta: Math.max(0, (first?.user.length ?? 0) - diff - touched - imported)
  };
}
function countOnly(config, plan, context) {
  const calls = plan.map(({ pass, system, user, think }) => ({
    id: pass.id,
    label: `passe ${pass.label}`,
    think,
    systemChars: system.length,
    userChars: user.length,
    promptTokens: 0,
    evalTokens: 0,
    thinkingChars: 0,
    contentChars: 0,
    durationMs: 0,
    ok: true
  }));
  console.log(
    `
PR #${config.pr} \xB7 ${context.files.length} fichier(s) touch\xE9s \xB7 ${context.imported.length} import\xE9(s) \xB7 variante \xAB ${config.variant} \xBB
`
  );
  console.log(renderBreakdown(calls, breakdown(plan, context)));
  console.log(
    "\n  La fusion n\u2019est pas compt\xE9e : son entr\xE9e est faite des trouvailles des passes,\n  qui n\u2019existent pas sans appel. Mesur\xE9e en production, elle p\xE8se ~2 000 tokens."
  );
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
  const isSkipped = compileMatcher(config.skip);
  const context = assembleContext({
    rawDiff,
    prFiles: meta.files,
    isSkipped,
    budget: {
      totalChars: config.budgetChars,
      perFileChars: config.perFileChars,
      importedChars: config.importsBudgetChars
    },
    readFile: (path) => {
      try {
        return readFileSync(join(root, path), "utf-8");
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
    }
  });
  if (context.diff.trim() === "") {
    console.log("Aucun fichier relisible dans cette PR (g\xE9n\xE9r\xE9s, binaires ou lockfiles seulement).");
    return;
  }
  const promptOptions = {
    repo,
    projectSummary: config.projectSummary,
    doctrine: readDoctrine(root, config.doctrine)
  };
  const doctrine = promptOptions.doctrine;
  const selection = selectPasses(
    { files: meta.files.filter((file) => !isSkipped(file.path)), hasDoctrine: doctrine.length > 0 },
    {
      auto: config.effort !== "full",
      forced: config.passes,
      warn: (message) => console.warn(`\u26A0 ${message}`)
    }
  );
  const plan = planPasses(config, promptOptions, meta, context, selection.run);
  console.log(
    `Contexte : ${context.files.length} fichier(s) touch\xE9s, ${context.imported.length} import\xE9(s), ${plan.length} passe(s) + fusion (${config.model}, effort ${config.effort}).`
  );
  for (const { label, reason } of selection.skipped) {
    console.log(`\xB7 passe \xAB ${label} \xBB non lanc\xE9e : ${reason}.`);
  }
  if (config.countOnly) {
    countOnly(config, plan, context);
    return;
  }
  const started = Date.now();
  const run2 = { calls: [], failures: [] };
  const outcomes = await runPasses(config, run2, plan);
  if (outcomes.length === 0) {
    const reason = run2.failures[0] ?? "raison inconnue";
    console.error(`\xC9chec de la review : aucune passe n'a abouti (${reason}).`);
    if (!config.dryRun) await postComment(config.pr, renderFailureComment(reason, config.model));
    return;
  }
  const merged = await callModel(config, run2, {
    id: "merge",
    // Les passes qui ont abouti, pas celles qui étaient prévues : annoncer un
    // relecteur qui n'a rien rendu ferait chercher à la fusion un axe absent.
    system: buildMergeSystemPrompt({
      repo,
      maxFindings: config.maxFindings,
      passes: outcomes.map((outcome) => outcome.pass)
    }),
    user: buildMergeUserPrompt(meta, outcomes),
    think: config.mergeThinking,
    label: "fusion"
  });
  const server = (process.env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
  const shared = {
    repoUrl: `${server}/${repo}`,
    headSha: meta.headSha,
    // Les fichiers importés sont de vrais fichiers du dépôt : les lier est juste.
    // Le filtre garde son rôle contre les chemins que le modèle invente.
    knownPaths: knownPaths(meta, context),
    footer: {
      model: config.model,
      durationMs: Date.now() - started,
      ...totals(run2.calls),
      skipped: context.skipped,
      omitted: context.omitted,
      imported: context.imported.length,
      // Les passes lancées qui n'ont pas abouti : un incident. Distinct de
      // celles qu'on n'a pas lancées, qui est une décision.
      failedPasses: selection.run.filter((pass) => !outcomes.some((outcome) => outcome.pass === pass)).map((pass) => pass.label),
      skippedPasses: selection.skipped
    }
  };
  const comment = merged === null ? renderPartialComment({
    ...shared,
    reason: run2.failures.at(-1) ?? "raison inconnue",
    passes: outcomes.map((outcome) => ({ label: outcome.pass.label, findings: outcome.findings }))
  }) : renderComment({ ...shared, review: merged.content });
  console.log(
    statsLine({
      pr: config.pr,
      model: config.model,
      variant: config.variant,
      calls: run2.calls,
      blocks: breakdown(plan, context),
      findings: Object.fromEntries(outcomes.map((outcome) => [outcome.pass.id, outcome.findings]))
    })
  );
  if (config.dryRun) {
    console.log("\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 review (dry-run, non post\xE9e) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n");
    console.log(comment);
    return;
  }
  await postComment(config.pr, comment);
  console.log(`Review post\xE9e sur la PR #${config.pr}.`);
}
function knownPaths(meta, context) {
  return /* @__PURE__ */ new Set([
    ...meta.files.map((file) => file.path),
    ...context.imported.map((file) => file.path)
  ]);
}
async function main() {
  if (!isEnabled(process.env)) {
    console.log("Review d\xE9sactiv\xE9e (input \xAB enable \xBB).");
    return;
  }
  const config = resolveConfig({
    argv: process.argv.slice(2),
    env: process.env,
    warn: (message) => console.warn(`\u26A0 ${message}`)
  });
  if (config.githubToken) process.env.GH_TOKEN = config.githubToken;
  if (!config.apiKey && !config.countOnly) config.apiKey = await keyFrom1Password();
  if (!config.apiKey && !config.countOnly) {
    console.log("Cl\xE9 Ollama absente : review ignor\xE9e.");
    return;
  }
  await review(config);
}
main().catch((error) => {
  console.error(`Review interrompue : ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof UsageError ? 1 : 0;
});
