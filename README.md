# ai-review-action

**Aristarque** reviews a pull request in three independent passes, each on the model that suits
it, then merges them into one comment. It looks for what a linter cannot see: repo-specific
conventions, functional regressions, data and access leaks.

**It never fails the job.** A review is an opinion, not a gate. Exhausted quota, provider outage,
missing key: said in a comment when possible, and the job exits 0.

## Quickstart

```bash
gh secret set OLLAMA_API_KEY --repo <owner>/<repo>
```

`.github/workflows/pr-review.yml`:

```yaml
name: AI PR review

on:
  pull_request:
    types: [opened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr: { description: 'PR number', required: true, type: string }

permissions:
  contents: read
  pull-requests: write
  issues: write      # to react 👀 to the triggering comment
  statuses: write    # for the aristarque/review commit status

jobs:
  review:
    if: >-
      github.event_name == 'workflow_dispatch'
      || (github.event_name == 'pull_request' && github.event.pull_request.draft == false)
      || (github.event_name == 'issue_comment'
          && github.event.issue.pull_request
          && github.event.comment.user.login == 'YOUR-LOGIN'
          && contains(github.event.comment.body, '@aristarque review'))
    runs-on: ubuntu-latest
    concurrency:                                   # on the job, not the workflow — see Traps
      group: pr-review-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}
      cancel-in-progress: true
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v7
        with:                                      # the PR head, not the merge commit
          ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', github.event.issue.number || inputs.pr) }}

      - uses: bedrock-ai/ai-review-action/pr-review@v3
        with:
          pr: ${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}
          ollama-api-key: ${{ secrets.OLLAMA_API_KEY }}
          doctrine: |
            .github/copilot-instructions.md
            CLAUDE.md
          status-check: true

      - name: Report an interrupted review          # clears the pending a killed run leaves
        if: always() && (cancelled() || failure())
        continue-on-error: true
        uses: bedrock-ai/ai-review-action/pr-review@v3
        with:
          pr: ${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}
          mode: abort
          status-check: true
```

Nothing to install: the action imports only Node builtins and drives GitHub through the `gh` CLI,
already on the runner. The job stays green even when the branch lockfile is broken, which is
exactly when a review earns its keep.

## The four calls

Three readings run on the same context with one objective each, and a fourth merges them. The
merge call **never receives the code**: its job is to sort, not to review.

| Call | Looks for | Model | `thinking` |
| --- | --- | --- | --- |
| functional regression | caller side, error paths, edge inputs, state and ordering | `glm-5.2:cloud` | `max` |
| repo doctrine | what `CLAUDE.md` and friends say, nothing else | `deepseek-v4-flash:cloud` | `high` |
| data and access | role boundaries, secrets, personal data | `deepseek-v4-flash:cloud` | `high` |
| merge | dedupe, arbitrate severity, write the five sections | `deepseek-v4-flash:cloud` | `low` |

A failing pass does not cancel the others, and the comment footer says which one is missing. See
[providers and the per-pass mix](docs/providers.md).

## Traps

Each one cost a real review before it was written down.

| Trap | What to do |
| --- | --- |
| A PR with conflicts fires **no** `pull_request` event: GitHub cannot compute its merge commit. Copilot uses another mechanism and runs anyway, which makes the asymmetry confusing. | Check `gh pr view <n> --json mergeable` before suspecting the YAML. Rebasing is enough. |
| `synchronize` is not listened to, so pushing fixes replays nothing. | Comment `@aristarque review`. Mentions also override the draft rule. |
| `issue_comment` runs with repo secrets and a write token, on **anyone's** comment. On a public repo without an allowlist, a stranger drains the key in a loop. | Filter on the commenter, as above. `author_association` against `OWNER`/`MEMBER`/`COLLABORATOR` suits a repo with several maintainers. |
| Concurrency at workflow level lets any stranger's comment cancel a running review: a run joins its group before the job `if` is evaluated. | Keep `concurrency` on the job. A rejected job never joins the group. |
| A run killed by `cancel-in-progress` or by `timeout-minutes` leaves its announcement on "review in progress" and its status on `pending`, forever. A required-but-absent status blocks the merge with no recourse. | Keep the `mode: abort` step. |
| GitHub only runs the workflow version on the default branch. | The comment trigger works once merged, never from the PR that introduces it. |

**Only turn on `status-check` where the key is set.** Without a key the action exits before posting
anything, which is the silence promised to fork PRs, so the check stays absent and the merge stays
blocked.

## Common inputs

Only `pr` is required. Full reference: [configuration](docs/configuration.md).

| Input | Default | |
| --- | --- | --- |
| `pr` | *(required)* | PR number to review. |
| `ollama-api-key` | `''` | Ollama Cloud key. Empty: review skipped quietly, job green. |
| `deepseek-api-key` | `''` | Routes the cheap passes through DeepSeek's API, which **adds a prefix cache**. |
| `provider` | `ollama` | `ollama`, `deepseek`, `openai` or `aws`. |
| `aws-region` | `''` | Bedrock region for `provider: aws`, e.g. `eu-north-1`. |
| `doctrine` | 3 paths | Convention files injected into the prompt, one path per line. |
| `skip` | `''` | File patterns not to review, `.gitignore` syntax. **Adds to** the built-in floor. |
| `effort` | `balanced` | How much gets cut from what is sent: `full`, `balanced`, `lean`. |
| `status-check` | `false` | Posts the commit status that makes the review wait. |
| `soft-sections` | `false` | Publish "Suggestions" and "To verify" too. |
| `max-output-tokens` | *(empty)* | Output ceiling per request. Bounds a call that loops in reasoning. |
| `dry-run` | `false` | Review goes to the logs, nothing is posted. |

## Docs

| | |
| --- | --- |
| [Configuration](docs/configuration.md) | Every input, the effort tiers, the commit status, cost preview before running. |
| [Providers](docs/providers.md) | The per-pass mix, prefix cache, AWS Bedrock, call sequencing, local keys. |
| [Rationale](docs/rationale.md) | The measured decisions: why three passes, why not agentic, why temperature is not zero. |
| [Reviewer identity](docs/reviewer-identity.md) | Surfacing Aristarque under "Reviewers" instead of as a plain comment. |
| [Releasing](docs/releasing.md) | Build, tag, and the v1 → v2 → v3 migrations. |

The name comes from Aristarchus of Samothrace, who annotated Homer in the second century BC with
marks of severity: the obelos for a line he held false, the asterisk for a duplicate. That is
already "Blocking", "To fix" and the deduplication the merge pass does here.
