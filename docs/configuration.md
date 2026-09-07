# Configuration

## All inputs

Only `pr` is required.

| Input | Default | |
| --- | --- | --- |
| `pr` | *(required)* | PR number to review. |
| `enable` | `true` | `false`: the action exits without reading or calling anything. Turns the review off without dismantling the workflow. |
| `announce` | `true` | Posts "review in progress" before the calls; the final report replaces it in place. `false`: nothing until the report. |
| `status-check` | `false` | Posts the commit status that [makes the review wait](#making-the-review-wait). Needs `statuses: write`. |
| `status-context` | `aristarque/review` | Status name, copied verbatim into branch protection. |
| `mode` | `review` | `abort`: read nothing, call nothing: only close out what a killed run left pending. |
| `ollama-api-key` | `''` | Ollama Cloud key. Empty: review skipped quietly, job green. |
| `deepseek-api-key` | `''` | Routes the [per-pass mix](providers.md#the-per-pass-mix) through DeepSeek's direct API, which adds a prefix cache. Empty: same model, served by Ollama. |
| `openai-api-key` / `openai-base-url` | `''` / `''` | Key and base URL for a generic OpenAI-compatible endpoint (Fireworks, Z.ai, OpenRouter...). Both are needed together. |
| `openai-prefix-cache` | `false` | `true` if that endpoint caches prefixes. Otherwise its passes are never sequenced. |
| `aws-region` | `''` | Bedrock region for `provider: aws`, e.g. `eu-north-1`. Without it this provider is unusable, and the action says so. |
| `github-token` | `${{ github.token }}` | Token for the `gh` CLI. The job token suffices, with `pull-requests: write`. |
| `provider` | `ollama` | Provider for passes that don't name their own: `ollama`, `deepseek`, `openai`, `aws`. |
| `model` | *(empty, resolves to `glm-5.2:cloud`)* | Model for the global provider, hence for the "regression" pass alone. Writing it puts **all four calls** on it: see [the per-pass mix](providers.md#the-per-pass-mix). |
| `<pass>-provider` / `<pass>-model` / `<pass>-thinking` | `''` | Provider, model, and reasoning effort for one pass: `regression`, `doctrine`, `data` (all three) or `merge` (provider/model only). `-thinking` written here escapes the effort tier. |
| `effort` | `balanced` | How much gets cut from what's sent: `full`, `balanced`, `lean`. See [the effort tier](#the-effort-tier). |
| `passes` | `''` | Passes to run (`regression`, `doctrine`, `data`), one per line. Empty: `effort` decides. |
| `thinking` | *(empty, resolves to `max`)* | Reasoning effort of the three reading passes: `low`, `medium`, `high`, `max`, `off`. A model that refuses a level is retried without it. |
| `merge-thinking` | *(empty, resolves to `low`, `high` outside the mix)* | Same, for the merge, which sorts findings without seeing the code. |
| `temperature` | `1` | Don't set it to `0`: on a reasoning model, greedy decoding shortens and flattens the output. Fix `seed` instead for stability. |
| `seed` | `1` | Sampling seed, so two reads of the same diff resemble each other. `off` returns variance to the model. |
| `doctrine` | *(see below)* | Convention files injected into the prompt, one path per line. Default: `.github/copilot-instructions.md`, `CLAUDE.md`, `AGENTS.md`. |
| `skip` | `''` | File patterns to skip, one per line, `.gitignore` syntax. Adds to the built-in floor. |
| `project-summary` | `''` | Two or three lines placing the project, if the doctrine doesn't already. |
| `soft-sections` | `false` | Publish "Suggestions" and "To verify" too. |
| `max-findings` | `20` | Cap on bullets for Blocking, To fix, and Suggestions. "To verify" has its own cap of five. |
| `budget-chars` | `500000` | Cap on the full content of changed files. |
| `per-file-chars` | `80000` | Cap per file. |
| `window-min-lines` | *(empty, depends on tier)* | Size above which a file is sent in excerpts instead of whole. `0`: never. |
| `imports-budget-chars` | *(empty, resolves to `300000`, `120000` at `lean`)* | Cap on imported files joined as context. `0`: none. |
| `timeout-minutes` | `15` | Timeout for one request. Job wall time: "largest sequenced group, plus the merge": see [call sequencing](providers.md#call-sequencing). |
| `max-output-tokens` | *(empty)* | Cap on a request's output tokens; `budget-chars` bounds the input. Empty: the model's own cap. |
| `dry-run` | `false` | `true`: the review goes to the logs, nothing is posted. |

## The effort tier

Input spend happens once, seconds after the review starts. `effort` sets how much gets cut, and every cut is declared in the comment's footer.

| | `full` | `balanced` (default) | `lean` |
| --- | --- | --- | --- |
| Changed files | whole | excerpted above 250 lines | excerpted above 120 lines |
| Imported files | to all three passes | not to "doctrine" | to "regression" only, 120,000 budget |
| Passes | all three | skips a pass a PR can't trigger | same |
| `thinking` | unchanged | unchanged | two tiers down on "doctrine", one on "data" |

`full` still skips pure duplicates and a doctrine-less "doctrine" pass: neither removes anything the model didn't already have. **"Data and access" always runs, and no tier drops to fewer axes**: a README leaks a key as well as a `.ts` file does, and a model juggling several axes at once shortchanges the last ones. Measured on this repo, same disk content, per-review input:

| PR | before | `full` | `balanced` | `lean` |
| --- | --- | --- | --- | --- |
| 18 files, 5 imported | 841,060 chars | -11.0% | -13.5% | -16.0% |
| README only | 108,115 chars | -0.3% | **-33.7%** | -33.7% |
| 2 files, no imports | 229,780 chars | -0.1% | -0.1% | -0.1% |

The `-33.7%` on a documentation PR is the "functional regression" pass not running: it could only return nothing.

Windowing measures **zero** on this repo. With 60 lines of margin on each side a single hunk
already covers 120, so under 400 lines there is nothing to win: the windows cover 100% of every
candidate file and the action sends it whole. Expect the payoff on an application repo whose
1,000-line files get localized edits.

## Making the review wait

A comment blocks nothing: `mergeStateStatus` doesn't see it, and an armed auto-merge goes ahead of a review still running (measured on `avolo-shorts`: a PR merged ten minutes after starting a review that needed fifteen, its run still going on an already-closed PR). `status-check: true` makes the action post a commit status on the PR head:

| Moment | State | Meaning |
| --- | --- | --- |
| at start, before any call | `pending` | a review is scheduled, not yet done |
| report posted | `success` | the PR has been reviewed |
| no pass could run, or none completed | `failure` | the PR has **not** been reviewed |
| run cancelled or timed out (`mode: abort` step) | `error` | the review was interrupted |

**The status doesn't judge content**: a report full of "Blocking" exits `success`, attesting only that the PR was read. Declare it required, once, on the repo:

```bash
gh api -X PUT repos/<owner>/<repo>/branches/main/protection/required_status_checks \
  -f 'checks[][context]=aristarque/review'
```

**A required but absent status also blocks the merge**, which an ordinary check misses. Still on `avolo-shorts`, a PR marked "ready" produced no run at all: `ready_for_review` shows in the timeline, but the workflow never started, so an absent comment there looks identical to a flawless PR. Same failure as a PR in conflict, which emits no `pull_request` event and triggers no review.

**Only turn on `status-check` where the key is set.** Without a key the action exits before
posting anything, the silence promised to fork PRs, so the check stays absent and the merge stays
blocked with no recourse.

## Announcing a review

`announce` defaults on. Before the first model call, Aristarque posts a "review in progress" comment naming the passes and linking the run; the final report replaces this comment in place, via its `<!-- aristarque -->` marker.

A PR with no comment used to leave four cases indistinguishable:

- the review hasn't triggered
- it's still running
- the key is missing (the action is then entirely silent)
- there was nothing to review

The announcement resolves the second case, the status above the other three. Intended side effect: a PR reviewed several times (`@aristarque review` after fixes) carries only one comment, the latest, so stale reports no longer pile up under the current one.

## Cost before running

`--count-only` builds the context, assembles the prompts, prints the breakdown, and calls nothing. Input is deterministic, so it's countable without a key or a quota:

```
pr-review 154 --count-only
```

```
  call                          destination                      system    context       total    ~ tokens
  functional regression pass    ollama/glm-5.2:cloud               8,208     520,705     528,913    ~151,118
  repo doctrine pass            ollama/deepseek-v4-flash:cloud      7,828     495,127     502,955    ~143,701
  data and access pass          ollama/deepseek-v4-flash:cloud      8,092     520,705     528,797    ~151,085
  ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  total input                                                                          1,560,665    ~445,904
  of which: diff 36% · changed files 56% · imports 5% · system 2% · rest 1%
```

The breakdown says where to cut, and it isn't guessable: on this repo the diff runs 10-37% of input depending on the PR, imported files 0-11%.

"system" bundles the shared preamble and the pass's own objective, and a price column also appears when the model's rate is known (not Ollama Cloud, sold by GPU time rather than by token), pricing input only, since output isn't guessable before the call.

A review with at least one successful pass also prints an `::stats::{...}` JSON line, greppable in a CI log; `--count-only` prints none. Each call now carries its provider, model, cache share, cost, and reasoning tokens when the provider exposes them, and `promptTokens`/`evalTokens` are now `inputTokens`/`outputTokens`: a script reading the old names needs updating.

**Raw findings appear only locally**, under `--dry-run`: the "data and access" pass hunts for secrets, and a finding that quotes one would land in a runner's log. Tokens say which setting is cheaper; only the findings say which one lost something, and that comparison stays on a workstation.
