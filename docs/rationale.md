# Rationale

## Three passes rather than one

A single call once carried the doctrine, six axes, and the output template over 90 KB of code:
the axes listed last got honored least. Three passes now run one objective each (functional
regression, doctrine, data and access), and a fourth merges them without seeing the code. Wall
time is the slowest pass plus the merge (`timeout-minutes: 45`), not their sum.

## Why not an agentic review

An agentic round trip resends everything that came before, not just the question. With a
50,000-token floor and eight read turns, the bill reaches 400,000 tokens where sending
everything up front costs 65,000: the better the reviewer works, the more it costs.

Ollama Cloud serves no prompt cache ([#15600](https://github.com/ollama/ollama/issues/15600),
[#16714](https://github.com/ollama/ollama/issues/16714)), and an LSP shrinks tool answers, not
the floor. Worth reopening on a provider whose cache covers intermediate turns.

## Why the temperature is not zero

The reflex, for reproducibility, is `temperature: 0`, a bad trade on a reasoning model: greedy
decoding shortens the chain of thought and loops it, paying analysis depth for a reproducibility
the cloud doesn't guarantee anyway. Day-to-day stability comes from `seed` instead, at no cost;
`seed: off` re-reads a PR from another angle, which two passes at fixed temperature can't.

## What the model returns

Three sections by default: Verdict, Blocking, To fix. Suggestions and To verify publish only
when `soft-sections` is `true`. Over `avolo-shorts`'s last 20 PRs, Aristarque returned 55
findings, 15 actionable; the other 40 fell into those two. The merge still arbitrates severity
across all five before publishing only three.

## The doctrine

The system prompt carries **no** project rule of its own; it injects the files the repo names,
one source of truth shared with Copilot (`.github/copilot-instructions.md`) and Claude Code
(`CLAUDE.md`). Defaults: those two plus `AGENTS.md`, missing ones skipped silently. A good file
states what's specific and costly to forget, not what the linter already catches.

## What is sent to the model

The diff **and** the full, line-numbered content of every touched file: the neighborhood is what
says whether a hardcoded string is editorial or a technical label.

A separate section adds the files those touch at one import level (`@/` tried against `src/`, root, `app/`); one real PR
sent 92,000 tokens into a 976,000 window this way, a failed lookup skipped silently rather than
canceling the review. These files are off-limits for findings; the footer states any truncation
and the import count.

## Exclusions

A non-optional floor covers lockfiles, `node_modules`, binaries, and minified files. The `skip`
input adds to it, `.gitignore`-style: no slash matches by name at any depth (`*.snap`), a slash
anchors to the repo root (`src/generated/**`), and `**` crosses a slash where `*` doesn't.

## Why the review is in French

The template's headings (`## Verdict`, `## Bloquant`, `## À corriger`, `## Suggestions`) double
as parsing anchors: rendering cuts the response at the last `## Verdict`, the only reliable way
to separate reasoning from review. Translating them via an input would break that extraction,
hence none.
