#!/usr/bin/env bash
# Install one of this repo's actions into another GitHub repo, through the API only.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
KNOWN_ACTIONS="pr-review (alias: aristarque)"
BRANCH="ci/aristarque-pr-review"
DEFAULT_WORKFLOW_PATH=".github/workflows/pr-review.yml"
ACTION_REF="JulienCr/gh-actions/pr-review"
GATE_CONTEXT="aristarque/review"
OP_REF='op://Personal/Ollama/add more/api_key'
DEFAULT_DOCTRINE=(.github/copilot-instructions.md CLAUDE.md AGENTS.md)
EXTRA_DOCTRINE=(.github/copilot-code-review-instructions.md)

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

SKIPS=() DOCTRINES=()
GATE=0 FORCE=0 DRY=0 RC=0
PR_URL="" SECRET_STATUS="not checked" GATE_STATUS="not requested"

usage() {
  cat <<USAGE
Usage: scripts/deploy.sh <action> <owner/repo> [options]

Actions: $KNOWN_ACTIONS

Options:
  --skip <glob>       file pattern to skip (repeatable)
  --doctrine <path>   convention file (repeatable, overrides detection)
  --gate              make "$GATE_CONTEXT" a required status check
  --force             update an existing install instead of stopping
  --dry-run           do every read, print what would be written, write nothing
  -h, --help          this help
USAGE
}

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

# Prints the file content on stdout; returns 1 when the path does not exist.
api_file() { # repo path ref
  local out
  if out=$(gh api "repos/$1/contents/$2?ref=$3" --jq .content 2>"$TMP/err"); then
    printf '%s' "$out" | base64 -d
  elif grep -q "404" "$TMP/err"; then
    return 1
  else
    cat "$TMP/err" >&2
    die "cannot read $2 on $1"
  fi
}

# Blob sha of a path, empty when absent.
api_sha() { # repo path ref
  gh api "repos/$1/contents/$2?ref=$3" --jq .sha 2>/dev/null || true
}

yaml_block() { # key items... -> a "key: |" block for the workflow
  local key=$1
  shift
  printf '          %s: |\n' "$key"
  printf '            %s\n' "$@"
}

# A placeholder missing from the template fails the run instead of passing silently.
render_template() { # author doctrine_file skip_file
  local author=$1 doctrine_file=$2 skip_file=$3
  local tpl="$ROOT/pr-review/templates/pr-review.yml" line
  local seen_author=0 seen_doctrine=0 seen_skip=0
  [[ -f $tpl ]] || die "template not found: $tpl"
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      *"__DOCTRINE__"*) seen_doctrine=1; cat "$doctrine_file" ;;
      *"__SKIP__"*) seen_skip=1; cat "$skip_file" ;;
      *"__AUTHOR_LOGIN__"*) seen_author=1; printf '%s\n' "${line//__AUTHOR_LOGIN__/$author}" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$tpl"
  ((seen_author && seen_doctrine && seen_skip)) \
    || die "template placeholder missing (author=$seen_author doctrine=$seen_doctrine skip=$seen_skip)"
}

pr_body() { # path doctrine_note skip_note author
  cat <<BODY
Ajoute \`$1\` : la review IA des PR (Aristarque), via \`$ACTION_REF@main\`.

- Déclencheurs : PR ouverte ou prête à relire, mention \`@aristarque review\`, lancement manuel.
- La mention \`@aristarque review\` ne fonctionne qu'une fois ce workflow mergé sur la branche par défaut.
- Seul \`$4\` peut déclencher une review par mention.
- Doctrine : $2.
- Fichiers ignorés en plus du socle : $3.
- Le secret \`OLLAMA_API_KEY\` doit exister sur le dépôt.
BODY
}

secret_step() { # repo
  local repo=$1 value
  local manual="op read '$OP_REF' | gh secret set OLLAMA_API_KEY --repo $repo"
  if gh secret list --repo "$repo" --json name --jq '.[].name' 2>/dev/null | grep -qx OLLAMA_API_KEY; then
    SECRET_STATUS="already set"
    info "secret OLLAMA_API_KEY already set"
    return 0
  fi
  if ((DRY)); then
    SECRET_STATUS="would be set from 1Password"
    return 0
  fi
  if ! command -v op >/dev/null 2>&1; then
    SECRET_STATUS="NOT SET (op missing)"
    RC=1
    echo "warning: op not found; set the secret by hand:  $manual" >&2
    return 0
  fi
  if value=$(op read "$OP_REF" 2>/dev/null) && [[ -n $value ]]; then
    if printf '%s' "$value" | gh secret set OLLAMA_API_KEY --repo "$repo" >/dev/null; then
      SECRET_STATUS="set from 1Password"
      info "secret OLLAMA_API_KEY set"
    else
      SECRET_STATUS="NOT SET (gh secret set failed)"
      RC=1
    fi
  else
    SECRET_STATUS="NOT SET (op read failed or empty)"
    RC=1
    echo "warning: could not read the key from 1Password; set it by hand:  $manual" >&2
  fi
  value=""
}

gate_step() { # repo branch
  local repo=$1 branch=$2 cmd
  # POST .../contexts appends to the list; PATCH on required_status_checks would replace it.
  cmd="echo '[\"$GATE_CONTEXT\"]' | gh api -X POST repos/$repo/branches/$branch/protection/required_status_checks/contexts --input -"
  if ((!GATE)); then
    echo "hint: to make the review block merges, run:  $cmd"
    return 0
  fi
  if printf '["%s"]' "$GATE_CONTEXT" \
    | gh api -X POST "repos/$repo/branches/$branch/protection/required_status_checks/contexts" --input - >/dev/null 2>"$TMP/err"; then
    GATE_STATUS="$GATE_CONTEXT required on $branch"
  else
    GATE_STATUS="NOT applied"
    echo "warning: gate not applied ($(head -c 200 "$TMP/err" | tr '\n' ' '))" >&2
    echo "         needs branch protection with required checks (403/404: none, or private repo on a free plan). Command:  $cmd" >&2
  fi
}

summary() { # repo
  echo
  info "summary for $1"
  echo "  PR:     ${PR_URL:-none}"
  echo "  secret: $SECRET_STATUS"
  echo "  gate:   $GATE_STATUS"
}

deploy_pr_review() { # repo
  local repo=$1 default_branch author path existing_file="" f names p
  local doctrine_paths=() doctrine_note
  gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name >"$TMP/branch" 2>"$TMP/err" \
    || { cat "$TMP/err" >&2; die "repository $repo is not accessible"; }
  default_branch=$(<"$TMP/branch")
  [[ -n $default_branch ]] || die "$repo has no default branch (empty repository?)"
  info "$repo: default branch is $default_branch"

  author=$(gh api user -q .login) || die "cannot read the gh user login"

  # The action's "doctrine" input REPLACES its default list, so a non-default file
  # must be emitted together with the defaults.
  if ((${#DOCTRINES[@]})); then
    doctrine_paths=("${DOCTRINES[@]}")
    doctrine_note="fournie : ${DOCTRINES[*]}"
  else
    local found_default=() found_extra=()
    for p in "${DEFAULT_DOCTRINE[@]}"; do
      if api_file "$repo" "$p" "$default_branch" >/dev/null; then found_default+=("$p"); fi
    done
    for p in "${EXTRA_DOCTRINE[@]}"; do
      if api_file "$repo" "$p" "$default_branch" >/dev/null; then found_extra+=("$p"); fi
    done
    if ((${#found_extra[@]})); then
      doctrine_paths=("${DEFAULT_DOCTRINE[@]}" "${found_extra[@]}")
      doctrine_note="détectée, liste explicite : ${doctrine_paths[*]}"
    elif ((${#found_default[@]})); then
      doctrine_note="détectée par défaut (${found_default[*]}), aucun réglage nécessaire"
    else
      doctrine_note="aucune trouvée, la review jugera sur des critères génériques"
      echo "warning: no doctrine file in $repo; the review will use generic criteria" >&2
    fi
  fi
  info "doctrine: $doctrine_note"

  : >"$TMP/doctrine"
  : >"$TMP/skip"
  if ((${#doctrine_paths[@]})); then yaml_block doctrine "${doctrine_paths[@]}" >"$TMP/doctrine"; fi
  if ((${#SKIPS[@]})); then yaml_block skip "${SKIPS[@]}" >"$TMP/skip"; fi
  render_template "$author" "$TMP/doctrine" "$TMP/skip" >"$TMP/rendered.yml"
  if grep -nE '__[A-Z_]+__' "$TMP/rendered.yml"; then
    die "unresolved placeholder in rendered workflow"
  fi

  # An existing install is any workflow file that references the action.
  names=$(gh api "repos/$repo/contents/.github/workflows?ref=$default_branch" \
    --jq '.[] | select(.type=="file") | .path' 2>/dev/null || true)
  while IFS= read -r f; do
    [[ $f == *.yml || $f == *.yaml ]] || continue
    if api_file "$repo" "$f" "$default_branch" >"$TMP/current.yml" && grep -q "$ACTION_REF" "$TMP/current.yml"; then
      existing_file=$f
      break
    fi
  done <<<"$names"

  if [[ -n $existing_file && $FORCE -eq 0 ]]; then
    info "$repo already uses the action in $existing_file; nothing written (use --force to update)"
    diff -u --label "$existing_file (deployed)" --label "rendered template" \
      "$TMP/current.yml" "$TMP/rendered.yml" || true
    return 0
  fi
  path=${existing_file:-$DEFAULT_WORKFLOW_PATH}
  local verb=add
  if [[ -n $existing_file ]]; then verb=update; fi
  local message="ci: $verb Aristarque PR review"

  if ((DRY)); then
    info "dry run: rendered $path"
    cat "$TMP/rendered.yml"
    info "dry run: would perform"
    echo "  - create branch $BRANCH from $default_branch (reuse if present)"
    echo "  - PUT $path (\"$message\")"
    echo "  - open a PR $BRANCH -> $default_branch (or print the existing one)"
    echo "  - set secret OLLAMA_API_KEY from 1Password (unless already set)"
    if ((GATE)); then echo "  - require status check $GATE_CONTEXT on $default_branch"; fi
    secret_step "$repo"
    summary "$repo"
    return 0
  fi

  if gh api "repos/$repo/git/ref/heads/$BRANCH" >/dev/null 2>&1; then
    info "branch $BRANCH already exists, reusing it"
  else
    local head_sha
    head_sha=$(gh api "repos/$repo/git/ref/heads/$default_branch" --jq .object.sha)
    gh api -X POST "repos/$repo/git/refs" -f "ref=refs/heads/$BRANCH" -f "sha=$head_sha" >/dev/null
    info "branch $BRANCH created at ${head_sha:0:7}"
  fi

  # The sha must come from the branch being written to, which may already hold the file.
  local branch_sha put_args
  branch_sha=$(api_sha "$repo" "$path" "$BRANCH")
  put_args=(-f "message=$message" -f "branch=$BRANCH" -f "content=$(base64 -w0 "$TMP/rendered.yml")")
  if [[ -n $branch_sha ]]; then put_args+=(-f "sha=$branch_sha"); fi
  gh api -X PUT "repos/$repo/contents/$path" "${put_args[@]}" >/dev/null
  info "wrote $path on $BRANCH"

  PR_URL=$(gh pr list --repo "$repo" --head "$BRANCH" --state open --json url --jq '.[0].url // empty')
  if [[ -n $PR_URL ]]; then
    info "a PR already exists: $PR_URL"
  else
    local skip_note="aucun ajout"
    if ((${#SKIPS[@]})); then skip_note="${SKIPS[*]}"; fi
    PR_URL=$(gh pr create --repo "$repo" --base "$default_branch" --head "$BRANCH" \
      --title "$message" --body "$(pr_body "$path" "$doctrine_note" "$skip_note" "$author")")
    info "PR opened: $PR_URL"
  fi

  secret_step "$repo"
  gate_step "$repo" "$default_branch"
  summary "$repo"
}

main() {
  local action="" repo=""
  while (($#)); do
    case $1 in
      -h | --help) usage; exit 0 ;;
      --skip) (($# >= 2)) || die "--skip needs a value"; SKIPS+=("$2"); shift ;;
      --doctrine) (($# >= 2)) || die "--doctrine needs a value"; DOCTRINES+=("$2"); shift ;;
      --gate) GATE=1 ;;
      --force) FORCE=1 ;;
      --dry-run) DRY=1 ;;
      -*) die "unknown option: $1" ;;
      *)
        if [[ -z $action ]]; then action=$1
        elif [[ -z $repo ]]; then repo=$1
        else die "unexpected argument: $1"; fi
        ;;
    esac
    shift
  done
  [[ -n $action && -n $repo ]] || { usage >&2; exit 2; }
  case $action in
    pr-review | aristarque) ;;
    *) die "unknown action '$action'. Known actions: $KNOWN_ACTIONS" ;;
  esac
  [[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "repository must be owner/repo, got '$repo'"
  command -v gh >/dev/null || die "gh CLI not found"

  case $action in
    pr-review | aristarque) deploy_pr_review "$repo" ;;
  esac
  exit "$RC"
}

main "$@"
