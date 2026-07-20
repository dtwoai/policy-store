---
name: "Read-Only GitHub for Non-Engineers"
tags:
  - github
  - role-gate-writes
  - ingress
  - soc2
  - sox
publishedAt: 2026-07-12
description: |
  # github / role-gate-writes-engineering

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny gated writes, allow otherwise
  **Package:** `github.ingress.role_gate_writes_engineering`

  ## What it does

  Establishes the least-privilege baseline for the GitHub MCP connector on the
  agent channel. It denies the enumerated write and destructive GitHub tools
  (the suffix list below) **unless the caller's IdP groups include
  `engineering`**, while leaving all read tools
  (`get_*`, `list_*`, `search_*`, and the consolidated `*_read` tools) available
  to everyone.

  At ingress — before the call reaches the GitHub MCP server, so a blocked write
  never executes and produces no side effect — the policy:

  - **Allows any tool for callers in the `engineering` group.** Membership is
    read from the IdP-issued JWT via `object.get(input.subject, "claims", {})`
    then `groups`. Group matching is case-insensitive (`Engineering` ==
    `engineering`).
  - **Allows any non-gated tool for everyone.** Read tools are never gated, so
    every caller keeps read access to code, issues, pull requests, and search.
  - **Denies the enumerated write/destructive tools for everyone else.** The
    default-deny takes effect when the caller is not in `engineering` and the
    tool matches a gated write suffix.

  Group membership **fails closed**: a caller with no `subject`, no `claims`, or
  no `groups` claim resolves to an empty group set and is therefore treated as
  read-only.

  ## Compliance alignment

  - **SOC 2 CC6.1** — logical access security over protected assets: restricts
    who can mutate source code and change tooling on the agent channel (family
    PF-12, Enforceable).
  - **SOC 2 CC6.3** — role-based access, least privilege, and separation of
    duties: write capability is bound to the `engineering` IdP group; everyone
    else is read-only (PF-12, Enforceable).
  - **SOC 2 CC6.2** — authorize/de-provision credentials: gating on live IdP
    group claims means a de-provisioned or reassigned user loses write access as
    soon as their token stops asserting `engineering` (PF-12, Partial).
  - **SOC 2 PI1.2** — inputs complete, accurate, and authorized: only authorized
    (engineering) principals may create or update repository content (PF-12,
    Partial).
  - **SOX ITGC — access to programs and data** — least-privilege access to the
    systems that hold financial-application source code and CI change tooling
    (PF-12, Enforceable).
  - **SOX SoD (COSO Principle 10)** — supports separation of initiate-vs-approve:
    the read-only default keeps non-engineers out of the change path (PF-12,
    Partial; pair with the merge/approval policy for the approval half).

  ## Why ingress and not egress

  Writes have permanent, externally visible side effects — a pushed file, a
  created branch, a triggered CI run, a filed issue visible to every repo
  watcher. Egress can only mask the response after the mutation already happened.
  Denying at ingress is the only way to actually prevent the unauthorized write.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `github-mcp-create_or_update_file`), and that prefix is not standardized, so
  the policy matches on the **suffix** of the lower-cased `input.resource.name`
  for portability. Verify the exact names your gateway sends with the dump-input
  debug technique before relying on this in production.

  **Gated write/destructive suffixes (official `github/github-mcp-server`):**
  `create_or_update_file`, `push_files`, `delete_file`, `create_branch`,
  `create_repository`, `fork_repository`, `issue_write`, `sub_issue_write`,
  `add_issue_comment`, `create_pull_request`, `update_pull_request`,
  `update_pull_request_branch`, `pull_request_review_write`,
  `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`,
  `discussion_comment_write`,
  `label_write`, `projects_write`, `create_gist`,
  `update_gist`, `actions_run_trigger`, `assign_copilot_to_issue`,
  `create_pull_request_with_copilot`.

  **Also gated (archived community `@modelcontextprotocol/server-github`):**
  `create_issue`, `update_issue`, `create_pull_request_review` — the archived
  server uses granular one-tool-per-operation names instead of the consolidated
  `*_write` tools, so these are included to keep the baseline holding on
  brownfield installs.

  Read tools are identified only by exclusion: anything **not** matching a gated
  suffix is allowed for everyone. Because matching is by suffix, a single rule on
  `issue_write` also covers `sub_issue_write`; both are listed explicitly for
  documentation.

  ## Argument shape

  This policy inspects **only the principal (IdP groups) and the tool name** — it
  reads no tool arguments. That makes it robust against argument-key tricks:
  there is no `owner`/`repo`/`method`/`content` field to spoof, and method-
  multiplexed tools (`issue_write`, `pull_request_review_write`, `label_write`,
  `projects_write`, `sub_issue_write`) are gated at the tool level, so **every**
  method they multiplex is denied for non-engineers regardless of the `method`
  argument.

  ## Examples

  ### Allowed — read tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-get_file_contents", "type": "tool" },
      "payload": {
        "name": "github-mcp-get_file_contents",
        "args": { "owner": "acme", "repo": "web", "path": "README.md" }
      }
    }
  }
  ```

  `allow = true`, no reason. (No `subject`/`groups` required for reads.)

  ### Allowed — write tool, engineering caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-push_files", "type": "tool" },
      "subject": { "sub": "google-apps|dev@acme.ai", "claims": { "groups": ["engineering"] } },
      "payload": { "name": "github-mcp-push_files", "args": { "owner": "acme", "repo": "web" } }
    }
  }
  ```

  `allow = true`.

  ### Denied — write tool, non-engineering (or unauthenticated) caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-create_or_update_file", "type": "tool" },
      "subject": { "sub": "google-apps|sales@acme.ai", "claims": { "groups": ["sales"] } },
      "payload": { "name": "github-mcp-create_or_update_file", "args": { "owner": "acme", "repo": "web" } }
    }
  }
  ```

  `allow = false`, `reason = "Access denied: \`github-mcp-create_or_update_file\` is a write or destructive GitHub tool restricted to the \`engineering\` IdP group. …"`.

  ## Composition

  This is the connector's baseline posture. Layer these companions on top — the
  gateway ANDs all attached ingress policies, so each narrows further:

  - **`require-human-approval-merge` (PF-15):** denies `merge_pull_request` and
    approving `pull_request_review_write` submissions even for engineers. This
    baseline deliberately does **not** gate `merge_pull_request` — the merge
    policy owns that concern.
  - **`fence-scopes-org-allowlist` (PF-23 / anti-exfil):** confines `owner`/`repo`
    to the company org so an engineer cannot push to a personal or third-party
    repo with their token.
  - **`redact-secrets-egress` (PF-02):** redacts credentials from file-content and
    search responses on the read path that this policy leaves open — including the
    sensitive secret-scanning reads.
  - A public-exposure policy (PF-27) forcing `private:true` on
    `create_repository` and denying public `create_gist`/personal-namespace
    `fork_repository`.

  ## Known limitations

  - **`engineering` is a placeholder.** Replace it with your own IdP's group name
    at import time — group names are placeholders, not shipped defaults.
  - **`groups` claim must be an array of strings.** The policy iterates
    `input.subject.claims.groups` as an array (the common Auth0/Okta/Entra shape).
    An IdP that encodes groups as a single space- or comma-delimited string, or
    under a namespaced claim (e.g. `https://acme.com/groups`), will not match —
    the caller would be treated as read-only. Adapt `is_engineering` to your
    claim shape; confirm the actual shape with the dump-input technique or
    `dtwo-list-claims`.
  - **Only enumerated write suffixes are gated.** Other mutating tools not in the
    list — `merge_pull_request` (owned by the merge policy), notification writes
    (`dismiss_notification`, `mark_all_notifications_read`,
    `manage_notification_subscription`,
    `manage_repository_notification_subscription`),
    `star_repository`/`unstar_repository`,
    `request_copilot_review` — are **not** gated by
    this policy and pass through for non-engineers. (The notification-subscription
    and star tools are deliberately treated as low-risk and left ungated;
    `request_copilot_review` only requests a Copilot review and does not hand a
    code-writing task to an autonomous agent the way the gated
    `assign_copilot_to_issue` / `create_pull_request_with_copilot` do. The
    red-team pass added the PR-content/PR-review writes
    `update_pull_request_branch`, `add_comment_to_pending_review`, and
    `add_reply_to_pull_request_comment`, and the public/watcher-visible
    `discussion_comment_write`, to the gated set above after finding they
    slipped through.) Add their suffixes to
    `gated_write_suffixes` if your posture requires it, or rely on the sibling
    policies that own them. `mark_all_notifications_read` ends in `_read` but is a
    write; it is intentionally left ungated here (it is not in the enumerated
    set).
  - **Tool inventory drifts.** GitHub adds toolset tools over time; a newly
    introduced write tool with a suffix not on the list would be allowed for
    everyone until added. This is the blocklist trade-off; pair with a
    `default-deny-unknown-tools` (PF-28) allowlist policy if you need
    drift-proof coverage.
  - **Placeholder-claim trust boundary.** Group membership is only as trustworthy
    as the IdP that issued the JWT and the gateway's `jwt_audience` validation.
    `is_admin`, `teams`, and the internal `user` claim are stripped by the gateway
    and are deliberately **not** used here.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - github
industries: []
bundles:
  - soc2
  - sox
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package github.ingress.role_gate_writes_engineering

# Least-privilege baseline for the GitHub MCP connector.
# Deny-by-default: a request is permitted only by an explicit allow rule below.
default allow := false

# --- Gated write / destructive tool suffixes (official github/github-mcp-server) ---
# The gateway prefixes tool names with the configured MCP server name
# (e.g. `github-mcp-create_or_update_file`), so we match by suffix for
# portability across server naming conventions.
gated_write_suffixes := {
	"create_or_update_file",
	"push_files",
	"delete_file",
	"create_branch",
	"create_repository",
	"fork_repository",
	"issue_write", # a suffix match on this also covers `sub_issue_write`
	"sub_issue_write",
	"add_issue_comment",
	"create_pull_request",
	"update_pull_request",
	"update_pull_request_branch", # sibling of update_pull_request; distinct suffix, must be listed separately
	"pull_request_review_write",
	"add_comment_to_pending_review", # PR-review write not covered by any other suffix
	"add_reply_to_pull_request_comment", # PR review-comment write; `add_issue_comment` suffix does not cover it
	"discussion_comment_write", # public/watcher-visible content write; parity with add_issue_comment (red-team addition)
	"label_write",
	"projects_write",
	"create_gist",
	"update_gist",
	"actions_run_trigger",
	"assign_copilot_to_issue",
	"create_pull_request_with_copilot",
}

# --- Archived community server (@modelcontextprotocol/server-github) write names ---
# That server uses granular one-tool-per-operation names instead of the
# consolidated `*_write` tools; gated here so the baseline holds on brownfield
# installs.
archived_write_suffixes := {
	"create_issue",
	"update_issue",
	"create_pull_request_review",
}

# A tool is gated if its lower-cased name ends with any gated suffix.
is_gated_write_tool if {
	some suffix in gated_write_suffixes
	endswith(lower(input.resource.name), suffix)
}

is_gated_write_tool if {
	some suffix in archived_write_suffixes
	endswith(lower(input.resource.name), suffix)
}

# --- Identity: engineering group membership ---
# Group membership is read from the IdP-issued JWT claims. Fails closed: a
# missing `subject`, missing `claims`, or missing `groups` yields no match, so a
# caller with no groups claim is treated as read-only. Matching is
# case-insensitive. NOTE: `engineering` is a placeholder — replace it with your
# IdP's group name at import time.
is_engineering if {
	claims := object.get(input.subject, "claims", {})
	some group in object.get(claims, "groups", [])
	lower(group) == "engineering"
}

# --- Allow rules ---
# Engineering group members may call any GitHub tool.
allow if is_engineering

# Everyone may call any tool that is not a gated write/destructive tool. This
# leaves all read tools (get_*, list_*, search_*, *_read) available to all
# callers.
allow if not is_gated_write_tool

# --- Deny reason ---
# The only deny condition is a gated write by a non-engineering caller, so a
# single inline reason suffices.
reason := sprintf("Access denied: `%s` is a write or destructive GitHub tool restricted to the `engineering` IdP group. Read tools (get_*, list_*, search_*, *_read) remain available to everyone. Ask an admin to add you to the `engineering` group, or contact your platform team if this is a false positive.", [input.resource.name]) if not allow
```
