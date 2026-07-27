---
name: Block Secrets in GitHub Commits & PRs
tags:
  - github
  - secrets
  - dlp
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # github / block-secrets-commits

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `github.ingress.block_secrets_commits`

  ## What it does

  Blocks GitHub write tool calls whose payload looks like it carries a live credential into a
  repository, gist, pull request, or comment. It scans the content-bearing arguments of the
  write surfaces that persist agent-authored text into GitHub:

  - **`create_or_update_file`** — the `content` argument (the file body being committed) and the
    commit `message` (which lands in git history and is world-readable on public repos).
  - **`push_files`** — every entry of the `files` array (`files[].content`), so multi-file commits
    are scanned in full, not just the first file, plus the top-level commit `message`.
  - **`create_gist`** / **`update_gist`** — the gist `content` / `description` (and any `files` entries).
  - **`create_pull_request`** / **`update_pull_request`** — the `body` (and `title`); the update arm
    stops an agent from slipping a secret into a PR body *after* a clean create.
  - The PR-review write surfaces **`pull_request_review_write`** (official consolidated),
    **`create_pull_request_review`** (archived), **`add_comment_to_pending_review`**, and
    **`add_reply_to_pull_request_comment`** — the review/comment `body`.
  - The visible-comment surfaces **`issue_write`**, **`add_issue_comment`**, and
    **`discussion_comment_write`** — the `body` (and `title` where present).

  All other tool calls — reads, merges, branch/repo creation, label edits, notifications — pass
  through unchanged. The check runs at ingress, before the call reaches the GitHub MCP server, so a
  blocked commit or comment is never written and never appears in repo history, a PR thread, or a
  public gist.

  ## Compliance alignment

  - **SOC 2 CC6.6** — supports boundary protection against external threats by keeping live
    credentials out of a third-party code host that an attacker (or the public, on public repos)
    could read; **CC6.7** — supports the restriction on transmission/movement of confidential
    information by stopping secrets from moving into GitHub over the agent commit path.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing: authentication secrets that
    could unlock personal data never land in repository history.

  ## Why ingress and not egress

  A commit, gist, PR, or comment is a write with permanent, externally visible side effects — once
  the call reaches GitHub the content exists in history (and, on public repos or public gists, is
  immediately world-readable and indexable). Egress redaction would only mask the response returned
  to the caller, not the object that was written. Ingress denial is the only way to actually prevent
  the leak. A companion egress policy (see Composition) handles secrets already present in repos
  when they are *read back*.

  ## Patterns matched

  The policy reuses the conservative regex set proven in the Slack `block-secrets` model. The list is
  intentionally focused on high-confidence shapes — adding too many patterns dramatically increases
  false positives:

  - Generic `password:`, `token:`, `api_key:`, `client_secret:`, etc. in `key: value` or `key=value`
    form (case-insensitive)
  - AWS access key IDs (`AKIA…`) and likely secret access keys
  - GitHub personal access tokens (`ghp_…`, `github_pat_…`)
  - Slack bot/user/admin tokens (`xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`)
  - Stripe live secret keys (`sk_live_…`)
  - Google API keys (`AIza…`)
  - OpenAI API keys (`sk-…`)
  - PEM private key headers (`-----BEGIN … PRIVATE KEY-----`)

  Tune this list for your environment. If your team uses other providers (Twilio, SendGrid, Datadog,
  etc.), add their token shapes to `secret_patterns` in `policy.md`.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `github-mcp-create_or_update_file`), and that prefix is not standardized. The policy matches on the
  **suffix** to stay portable, which also lets a single rule cover both GitHub server flavours:

  - The **official** `github/github-mcp-server` uses consolidated snake_case names
    (`create_or_update_file`, `push_files`, `create_gist`, `update_gist`, `create_pull_request`,
    `update_pull_request`, `pull_request_review_write`, `add_comment_to_pending_review`,
    `add_reply_to_pull_request_comment`, `issue_write`, `add_issue_comment`,
    `discussion_comment_write`).
  - The **archived** `@modelcontextprotocol/server-github` uses granular names for the same
    operations — the suffix rules add explicit arms for `create_issue`, `update_issue`, and
    `create_pull_request_review`.

  The edit/update surfaces (`update_gist`, `update_pull_request`) and the review-reply surfaces are
  matched in addition to their create counterparts so that a two-step "create clean, then edit the
  secret in" sequence is blocked at the second step. The `update_pull_request` suffix rule does not
  match `update_pull_request_branch` (which carries no body).

  The `issue_write` arm is guarded with `not endswith(name, "sub_issue_write")` so it does not
  accidentally match `sub_issue_write` (which manages sub-issue relationships and carries no body).
  Verify the exact names your gateway sends with the dump-input debug technique before relying on
  this in production.

  ## Argument shape

  Verified from the official server source (`pkg/github/repositories.go` and README):
  `create_or_update_file` takes `content` and `message`; `push_files` takes `files` (array of
  `{path, content}`) and `message`; `create_pull_request` takes `body` (and `title`). The commit
  `message` on the two file-writing surfaces is scanned in addition to the file body, because it is
  persisted to git history just like the content. The comment surfaces take `body`. The
  argument schemas for `issue_write`, `create_gist`, and `discussion_comment_write` were **not
  verified** from source in the landscape pass — the policy scans the common `body` / `content` /
  `description` / `title` keys and iterates a `files` collection for gists, and fails safe (nothing
  to scan → the call passes through). Confirm the live `tools/list` schema before treating gist or
  discussion-comment coverage as exhaustive.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-create_or_update_file", "type": "tool" },
      "payload": {
        "name": "github-mcp-create_or_update_file",
        "args": {
          "owner": "acme", "repo": "app", "path": "README.md", "branch": "main",
          "message": "docs", "content": "# App\n\nRun `pnpm dev` to start."
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-create_or_update_file", "type": "tool" },
      "payload": {
        "name": "github-mcp-create_or_update_file",
        "args": {
          "owner": "acme", "repo": "app", "path": ".env", "branch": "main",
          "message": "config", "content": "AWS_KEY=AKIAIOSFODNN7EXAMPLE"
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "This GitHub write looks like it contains a secret (...)"`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - **Secret hygiene on egress (redact):** an egress policy on `get_file_contents`, `search_code`,
    `get_job_logs`, and `pull_request_read` responses that redacts known credential patterns before
    they enter agent context — catching secrets already committed before this policy was attached.
  - **Org scoping / anti-exfil (ingress deny):** deny `push_files` / `create_or_update_file` whose
    `owner` is outside the company-org allowlist, so the agent's token can't push code to an
    attacker- or personally-owned repo (a leak channel this policy does not address).
  - **No public exposure (ingress):** deny `create_gist` when a public flag is set and force
    `create_repository` to `private: true`.

  ## Known limitations

  - **Regex over plain text.** Secrets concatenated into longer strings may still match; secrets that
    don't fit a known shape (rotating short-lived tokens, custom-format keys) will not. Treat this as
    a high-signal first line of defense, not a complete DLP solution.
  - **Content-field coverage is best-effort where schemas are unverified.** `create_gist` and
    `discussion_comment_write` argument shapes were not verified from source; the policy scans the
    common `content` / `description` / `body` / `title` keys and a `files` collection. If your server
    exposes gist or discussion content under a different key, add it to the `scanned_text` rules.
  - **Binary / encoded content not decoded.** `create_or_update_file` and `push_files` accept
    base64-encoded blobs in some client flows; the policy matches patterns against the argument
    string as sent. A caller that base64-encodes a secret before committing would evade the text
    patterns — pair with the egress redaction companion and, if needed, add a decode step.
  - **Per-field scanning; split secrets survive.** Each content string is matched independently, so
    a secret whose halves are placed in two different `push_files` entries (or split across `body`
    and `title`) will not match. Only top-level `body` / `title` / `content` / `description` and the
    `files[].content` collection are scanned; the `pull_request_review_write` /
    `create_pull_request_review` per-comment `comments` array schema was not verified from source, so
    a secret placed only inside an inline review comment (not the review `body`) may not be caught.
    Confirm the live `tools/list` schema and extend the `scanned_text` rules if your server exposes
    review comments that way.
  - **No identity-based exemptions.** All callers are subject to the same check. If you need an
    InfoSec break-glass user that can commit anything, gate it with `input.subject.claims` as a
    separate `allow if` branch. (Group names in any such branch are placeholders — replace them with
    your IdP's group name at import time.)

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - github
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package github.ingress.block_secrets_commits

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Patterns that look like secrets in plain text. Anchored to common shapes
# (key=value pairs and provider-specific prefixes) to limit false positives.
# Reused verbatim from the Slack block-secrets model.
secret_patterns := [
    # Generic password / token / api_key / secret_key in `key: value` or `key=value` form
    `(?i)(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S+`,
    # AWS access key IDs
    `AKIA[0-9A-Z]{16}`,
    # AWS secret access keys (40-char base64-ish)
    `(?i)aws(.{0,20})?(secret|access)?.{0,20}[\s:=]+[A-Za-z0-9/+=]{40}`,
    # GitHub fine-grained / classic personal access tokens
    `ghp_[A-Za-z0-9]{36}`,
    `github_pat_[A-Za-z0-9_]{82}`,
    # Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-)
    `xox[baprs]-[A-Za-z0-9-]{10,}`,
    # Stripe live secret keys
    `sk_live_[A-Za-z0-9]{24,}`,
    # Google API keys
    `AIza[0-9A-Za-z\-_]{35}`,
    # OpenAI API keys
    `sk-[A-Za-z0-9]{20,}`,
    # Generic private key headers
    `-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`,
]

# --- Tool matching (suffix-based for portability across server names/flavours) ---

# create_or_update_file: single file `content` argument.
is_file_content_tool if {
    endswith(lower(input.resource.name), "create_or_update_file")
}

# push_files: `files` array, each with a `content` field.
is_push_files_tool if {
    endswith(lower(input.resource.name), "push_files")
}

# create_gist / update_gist: gist content/description (unverified schema — scan broadly).
# update_gist is covered too: an agent blocked at create can otherwise edit a
# secret into an existing gist afterward.
is_gist_tool if {
    endswith(lower(input.resource.name), "create_gist")
}

is_gist_tool if {
    endswith(lower(input.resource.name), "update_gist")
}

# Body-bearing write surfaces: PRs, issues, comments, discussions.
# Covers the official consolidated names and the archived granular names.
is_body_write_tool if {
    endswith(lower(input.resource.name), "create_pull_request")
}

# update_pull_request: editing a PR's body/title is a second write path that
# would otherwise let an agent slip a secret in after a clean create.
is_body_write_tool if {
    endswith(lower(input.resource.name), "update_pull_request")
}

is_body_write_tool if {
    endswith(lower(input.resource.name), "create_pull_request_review")
}

# Official consolidated PR-review write surface (method create/submit) — carries
# a review `body`. Distinct from the archived create_pull_request_review name.
is_body_write_tool if {
    endswith(lower(input.resource.name), "pull_request_review_write")
}

# Pending-review comment and PR-comment reply surfaces — both carry a `body`.
is_body_write_tool if {
    endswith(lower(input.resource.name), "add_comment_to_pending_review")
}

is_body_write_tool if {
    endswith(lower(input.resource.name), "add_reply_to_pull_request_comment")
}

is_body_write_tool if {
    endswith(lower(input.resource.name), "add_issue_comment")
}

is_body_write_tool if {
    endswith(lower(input.resource.name), "discussion_comment_write")
}

is_body_write_tool if {
    name := lower(input.resource.name)
    endswith(name, "issue_write")
    # sub_issue_write manages relationships and carries no body — don't match it.
    not endswith(name, "sub_issue_write")
}

is_body_write_tool if {
    endswith(lower(input.resource.name), "create_issue")
}

is_body_write_tool if {
    endswith(lower(input.resource.name), "update_issue")
}

# A tool is "scanned" if it is any of the write surfaces above.
is_scanned_tool if is_file_content_tool
is_scanned_tool if is_push_files_tool
is_scanned_tool if is_gist_tool
is_scanned_tool if is_body_write_tool

# --- Text extraction: gather every content-bearing string for the matched tool ---

# create_or_update_file: content
scanned_text contains t if {
    is_file_content_tool
    t := object.get(input.payload.args, "content", "")
    t != ""
}

# push_files: iterate the files array and pull each entry's content
scanned_text contains t if {
    is_push_files_tool
    files := object.get(input.payload.args, "files", [])
    some f in files
    t := object.get(f, "content", "")
    t != ""
}

# Commit message: create_or_update_file and push_files both persist a `message`
# into git history. The message is world-readable on public repos and survives
# in the log just like file content, so a secret smuggled into the commit
# message is as much a leak as one in the file body. Scan it too.
scanned_text contains t if {
    is_file_content_tool
    t := object.get(input.payload.args, "message", "")
    t != ""
}

scanned_text contains t if {
    is_push_files_tool
    t := object.get(input.payload.args, "message", "")
    t != ""
}

# create_gist: content, description, and any files-collection contents
scanned_text contains t if {
    is_gist_tool
    t := object.get(input.payload.args, "content", "")
    t != ""
}

scanned_text contains t if {
    is_gist_tool
    t := object.get(input.payload.args, "description", "")
    t != ""
}

scanned_text contains t if {
    is_gist_tool
    files := object.get(input.payload.args, "files", [])
    some f in files
    t := object.get(f, "content", "")
    t != ""
}

# Body-write surfaces: scan body and title (title absent on comments → skipped)
scanned_text contains t if {
    is_body_write_tool
    t := object.get(input.payload.args, "body", "")
    t != ""
}

scanned_text contains t if {
    is_body_write_tool
    t := object.get(input.payload.args, "title", "")
    t != ""
}

# --- Secret detection ---

contains_secret if {
    some t in scanned_text
    some pattern in secret_patterns
    regex.match(pattern, t)
}

# --- Allow rules ---

# Allow any tool that isn't one of the scanned write surfaces.
allow if {
    not is_scanned_tool
}

# Allow a scanned write only when none of its content matches a secret pattern.
allow if {
    is_scanned_tool
    not contains_secret
}

# --- Deny reason ---

reasons contains "This GitHub write looks like it contains a secret (API key, password, token, or private key). Route credentials through your secret manager instead of committing them. Contact your InfoSec team if this was a false positive." if {
    is_scanned_tool
    contains_secret
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
