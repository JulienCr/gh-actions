# Surfacing Aristarque under "Reviewers"

Aristarque only comments: absent from the "Reviewers" box, no downstream workflow triggered.

## What Codex does, Copilot doesn't

Checked 28 August 2026 on `openai/codex`: PRs 41207, 41205, 41183 show `reviews:
chatgpt-codex-connector[bot]`, `requested_reviewers: []`, reviewed but never requested.
Copilot's button is GitHub's own wiring: a third party gets `Could not resolve user with login
'yourapp[bot]'` (<https://github.com/orgs/community/discussions/193037>).

## Step 1: post a review, not a comment

`postComment` (`gh.ts`) calls `gh pr comment`; a review needs a different endpoint:

```bash
gh api repos/$repo/pulls/$pr/reviews --input - <<'JSON'
{"commit_id": "<headSha>", "event": "COMMENT", "body": "…summary…",
 "comments": [{"path": "src/x.ts", "line": 42, "side": "RIGHT", "body": "…finding…"}]}
JSON
```

`headSha` (`PrMeta`) marks it "outdated" on branch moves, and it gets a reviewers-box slot plus
`GET /pulls/{n}/comments` returning structured `path`/`line`/`diff_hunk`/`body`.

## Three traps

| Trap | What to do |
| --- | --- |
| A `line` outside the diff returns 422 and fails the **entire** review, not just that bullet. | Fall back to a body-only review rather than lose the report. |
| `event: REQUEST_CHANGES` blocks the merge until dismissed. | Keep `COMMENT`, the gate already exists as the `aristarque/review` status. |
| The announcement and inline comments can't share one call (`PUT /pulls/{n}/reviews/{id}` rewrites only the body). | Leave the "in progress" announcement as an issue comment; post the review at the end. |

## Step 2: a GitHub App, for identity and the event chain

`GITHUB_TOKEN` events trigger no other workflow, so `github.token` won't fire a downstream fix.
Fix: a GitHub App (`pull_requests: write`, `contents: read`, `metadata: read`, `commit statuses:
write`, no server, no webhook) via `actions/create-github-app-token` as `github-token`, signed
`aristarque[bot]`. Cost: an App ID and key in secrets per repo, plus `if: github.actor !=
'aristarque[bot]'` on the fix workflow.

## What's out of reach, and the fallback

Pending state, re-request, `CODEOWNERS`, and required reviewers need an account GitHub resolves
as a user. Fallback: a PAT-backed account, requestable, on a paid org seat.
