# Providers

| Provider | Auth | Default model | Prefix cache | `seed` honored |
| --- | --- | --- | --- | --- |
| `ollama` | API key | `glm-5.2:cloud` | No | Yes |
| `deepseek` | API key | `deepseek-v4-flash` | Yes | No |
| `openai` | API key | *(none, must be named)* | Declare with `openai-prefix-cache` | No |
| `aws` | AWS SigV4 | `zai.glm-5` | No | No |

## The per-pass mix

The four calls don't need the same model. "Functional regression" traces callers and error paths,
a search where GLM-5.2's value is observed on real PRs. "Repo doctrine" applies written rules
already in view. The merge sorts thirty bullets without seeing the code. Paying all four at the
same rate buys depth only one of them uses.

Three of four calls go to `deepseek-v4-flash`, with nothing to configure:

| Call | Model | `thinking` |
| --- | --- | --- |
| functional regression | `glm-5.2:cloud` | `max` |
| repo doctrine | `deepseek-v4-flash:cloud` | `high` |
| data and access | `deepseek-v4-flash:cloud` | `high` |
| merge | `deepseek-v4-flash:cloud` | `low` |

Ollama Cloud bills GPU time in usage tiers, not tokens: `glm-5.2:cloud` sits at high usage,
`deepseek-v4-flash:cloud` at medium. Moving three calls out drops them a tier on the Ollama key
alone.

Two ways to opt out: writing `model:` by hand puts all four calls back on it, or naming another
`provider:` hands the repo full control.

**The mix doesn't send fewer tokens, it changes who reads them.** Same PR, same disk content:
three-pass input went from 1,580,701 to 1,580,669 chars, a 0.002% difference.

On PR #8 it moved 66% of input tokens and 58% of output tokens off the flagship. To cut input, use
[the effort tier](configuration.md#the-effort-tier), measured at -13.5%. Input is no longer the
top cost anyway: the regression pass alone returned 41,681 output tokens, 98% of it reasoning.

## A DeepSeek key buys the prefix cache

Served directly by `api.deepseek.com`, the same model adds what Ollama lacks: an automatic prefix
cache, billed 31 times cheaper than fresh input ($0.014/M against $0.44/M at peak). Setting
`deepseek-api-key` switches the three cheap calls to that route.

DeepSeek moved from a flat rate to hourly pricing on **August 16, 2026**: peak 01:00-04:00 and
06:00-10:00 UTC, half price otherwise. `estimateCost` applies the rate of the call's hour, so any
price table older than that date is wrong by a factor of three.

"Doctrine" and "data" target the same provider and model on purpose, to share that cache. Two
conditions, both held by the action:

1. **The prefix is byte-for-byte identical.** The system prompt carries only the shared preamble;
   each pass's objective goes in the last message. Imported files render at the end of context, so
   "doctrine" (which skips them at `balanced`) is a strict prefix of "data". A unit test pins this.
2. **The second call goes out after the first**, a cache being written at the end of the input that
   produced it. Passes sharing a destination run in sequence, shortest first.

## AWS Bedrock

`provider: aws` targets Bedrock's OpenAI-compatible endpoint,
`bedrock-runtime.<region>.amazonaws.com/openai/v1`, signed SigV4. Not `bedrock-mantle`, which
needs a permission an inference role typically lacks.

No key to set. Credentials resolve in three rungs, first one that answers wins:

1. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`)
2. `AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`, which a Kubernetes runner mounts on its own
3. `aws configure export-credentials`, covering `AWS_PROFILE` and local SSO

`aws-region` has no default and has to be chosen: `eu-west-3` serves neither GLM nor DeepSeek,
`eu-north-1` serves both. Without one, the action warns and calls nothing.

| Call | Model | `thinking` | On-demand rate, `eu-north-1`, 2026-09-07 |
| --- | --- | --- | --- |
| functional regression | `zai.glm-5` | `max` | $1.20/M in, $3.84/M out |
| repo doctrine | `zai.glm-5` | `high` | idem |
| data and access | `zai.glm-4.7-flash` | `high` | $0.08/M in, $0.48/M out |
| merge | `zai.glm-5` | `low` | idem |

Only one pass downgrades here, against three on Ollama. Bedrock returns no cache counters on these
models, so pairing "doctrine" with "data" gains nothing, and "doctrine" already burned its whole
reasoning budget in four runs out of nine.

Four Bedrock quirks, all measured:

| Quirk | What it means for you |
| --- | --- |
| The endpoint applies an implicit **8,192-token** output ceiling when `max-output-tokens` is unset. At 147,000 input tokens the regression pass burned all 8,192 in reasoning without concluding, then retried with no reasoning at all: 103 output tokens for a pass that needs thousands. | **Set `max-output-tokens: 32000`.** The endpoint accepts up to 200,000. |
| No model accepts `max`: `400 'reasoning_effort' value 'max' is not supported by this model`. | Nothing. The action sends `high`, the real ceiling there. |
| At `high`, these models inline reasoning between `<reasoning>` tags instead of using a separate field. One pass returned 33,664 characters of chain-of-thought where findings belonged. | Nothing. The action strips the tags and counts them as reasoning. A review that contains the string `<reasoning>` loses that sentence. |
| One model generation behind on both families: `glm-5.2` and `deepseek-v4` exist in no Bedrock region, the catalog stopping at `zai.glm-5` and `deepseek.v3.2`. | Re-assess the regression pass, the only one whose flagship value is measured on real PRs. |

**The silence promised to forks does not apply.** A key is never exposed to a fork PR, but a role
credential is ambient on the runner. Gate the job on
`if: github.event.pull_request.head.repo.full_name == github.repository`, or a fork's code reaches
Bedrock and its report gets posted.

## Call sequencing

Sequencing applies to every provider, cached or not. The first version only chained calls that had
a cache to gain, and let two requests Ollama cannot serve at once go out together. Measured on
`avolo-shorts`, three PRs running:

| Call | Alongside | Input | Result |
| --- | --- | --- | --- |
| doctrine (flash), local | nothing | 173,109 | succeeds |
| doctrine (flash), CI | 2 other calls | ~134,000 | **empty** |
| data (flash), CI | 2 other calls | ~134,000 | **empty** |
| regression (glm-5.2), CI | 2 other calls | 366,547 | succeeds |

The largest prompt succeeds alone; the smallest fails alongside others. It is concurrency, not
context size. A caching provider buys tokens by queuing; a non-caching one buys passes that finish.

Durations are lopsided, the regression pass alone weighing five times the other two combined.
Nothing in the code guarantees that ratio:

| Call | Model | Duration |
| --- | --- | --- |
| data and access | `deepseek-v4-flash:cloud` | 67 s |
| repo doctrine | `deepseek-v4-flash:cloud` | 89 s |
| functional regression | `glm-5.2:cloud` | **470 s** |
| merge | `deepseek-v4-flash:cloud` | 18 s |

**Sequencing changes the `timeout-minutes` arithmetic.** Wall time is
`(largest sequenced group + 1) x timeout-minutes`, the merge being the `+1`:

| Configuration | Largest group | Theoretical wall |
| --- | --- | --- |
| default, mix active | 2 (doctrine then data) | 3 x 15 = **45 min** |
| `model:` set by hand | 3 (all passes, one model) | 4 x 15 = **60 min** |

Writing `model:` puts all three reading passes in one group, so `timeout-minutes: 45` would then
cut the review during the merge, with no time to post a failure comment.

Measured on this repo's PR #7, ~140,000 input tokens per pass: the second call of a sequenced pair
got 141,694 tokens served from cache out of 149,831, dropping its cost from $0.0628 to $0.0057.
`--count-only` measures the shared prefix before any call and warns if it collapses:

```
"repo doctrine" then "data and access": same destination,
run in sequence so the second replays the first's cached prefix.
shared prefix: 487,202 chars, ~139,201 reusable tokens.
```

## Tuning it differently

- **One pass alone**: `data-model: deepseek-v4-pro` is the planned first escalation if "data and
  access" recall drops on real PRs, at the cost of the cache shared with "doctrine".
- **Another endpoint**: `provider: openai` with `openai-base-url` and `openai-api-key` targets any
  OpenAI-compatible API. Name a `model` too, this endpoint having no known catalog, and set
  `openai-prefix-cache: true` only if you know it caches prefixes.
- **The reasoning level**: a hand-written `<pass>-thinking` escapes the effort tier, so the two
  mechanisms never fight over one value.
- A pass whose provider has no key falls back to the global provider, with a warning. If that one
  has none either, the pass doesn't run and the footer says so. The job stays green regardless.
- **`seed` isn't sent to DeepSeek direct**, which doesn't document it: those passes vary run to
  run, and the action says so once in the log.

## Local keys

```bash
npx --yes -p 'github:JulienCr/gh-actions#v3' pr-review 154 --dry-run
npx --yes -p 'github:JulienCr/gh-actions#v3' pr-review 154 --model qwen3-coder:480b-cloud --dry-run
```

`#v3` isn't decorative: without it npx takes the default branch, and a setting validated locally
would run against a different prompt than CI. A past version doubles as a comparison point:
`#v1.1.0` is the last to review in one call with no imported context, so running it on the same PR
at the same seed says whether a prompt change bought findings or just noise.

Each key is read from `<PROVIDER>_API_KEY`, else from 1Password at `<PROVIDER>_API_KEY_REF`, so it
never sits in a `.env` or the shell history. Only the providers a review will call get looked up.

| Provider | Variable | Default 1Password reference |
| --- | --- | --- |
| `ollama` | `OLLAMA_API_KEY` | `op://Personal/Ollama/add more/api_key` |
| `deepseek` | `DEEPSEEK_API_KEY` | `op://Personal/DeepSeek/api_key` |

`aws` has no key: it takes the `AWS_PROFILE` profile through the `aws` CLI, SSO included, and
`AWS_REGION` stands in for `aws-region`.

Before tuning anything: `gh pr checkout <n>`. The diff comes from GitHub, full file content from
disk, so on an already-merged PR the model gets yesterday's diff against today's files and draws
wrong conclusions on lines that have moved. Half of a tuning session's "hallucinations" came from
this, not from the model. The action warns when it detects the mismatch.
