---
name: Fence GitHub Access to the Company Org Allowlist
tags:
  - github
  - fence-sensitive-scopes
  - org-allowlist
  - anti-exfil
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # github / fence-scopes-org-allowlist

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny when `owner` is present and off-list; allow otherwise
  **Package:** `github.ingress.fence_scopes_org_allowlist`

  ## What it does

  Denies any GitHub tool call whose `arguments.owner` (read from
  `input.payload.args.owner`) is not one of the logins in a tenant-configured
  **company-org allowlist**. The allowlist is a Rego array constant
  (`company_orgs`) that each tenant pins to its own org login(s) at import
  time.

  Because nearly every GitHub tool carries an `owner` + `repo` pair, this one
  predicate closes two exfiltration paths at once — but only for tools where the
  `owner` argument names the repository actually being read from or written to:

  - **Read exfiltration** — pulling a third-party or personal private repository
    into agent context via owner-bearing reads such as `get_file_contents`,
    `get_repository_tree`, and `pull_request_read` (`method: get_diff` /
    `get_files`). It does **not** cover `search_code`, which takes only a `q`
    query string and no `owner`: a `repo:owner/name`-scoped query reaches a
    third-party repo unfenced (see Known limitations).
  - **Write exfiltration** — pushing the user's token-authorized content into an
    attacker- or personally-owned repository via `push_files` and
    `create_or_update_file`, whose `owner` is the write destination. It does
    **not** cover `fork_repository`: there the `owner` argument is the fork
    *source*, so forking a sanctioned company repo into a personal namespace
    (the actual IP-exfil direction) is allowed by this policy — see the
    public-exposure companion and Known limitations.

  Calls with **no resolvable `owner` argument** (e.g. `get_me`, or `search_code`
  invoked with only a `q` string) are allowed, because those are already scoped
  by the OAuth grant — there is no owner to fence against. Any call where
  `owner` **is** present and off-list is denied. Beware that "ownerless" also
  covers a few *writes* — `create_gist`/`update_gist` and `create_repository`
  (destination keyed on `organization`, not `owner`) — which therefore pass this
  fence; the public-exposure companion is what covers them (see Known
  limitations). The deny reason names the
  offending owner and points the agent back to a sanctioned company org.

  The check runs at ingress, before the call reaches the GitHub MCP server, so a
  blocked read never enters agent context and a blocked write never executes.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports the requirement to identify and protect
    confidential information by keeping source-code IP inside the sanctioned org
    boundary on the agent channel. **P4.1** — supports limiting use of
    information to identified, sanctioned purposes (the company org).
  - **GDPR Art. 5(1)(b)** — supports purpose limitation: repository content the
    agent can reach is confined to the org the processing is authorized for.
  - **CCPA/CPRA §1798.121** — supports the right to limit sensitive information
    by preventing the agent channel from reading or writing outside the
    company's own namespace.

  This is a **PF-23 (fence-sensitive-scopes)** ingress policy: a per-tenant
  allowlist keyed to the org boundary rather than to IdP groups.

  ## Tool name matching

  This policy is **not** matched by tool name. The fence key is the presence and
  value of the `owner` argument, which almost every GitHub tool carries
  (`get_file_contents`, `push_files`, `fork_repository`, `create_pull_request`,
  `merge_pull_request`, `pull_request_read`, and so on — see the GitHub landscape
  note). Matching on `owner` rather than enumerating tool names keeps the policy
  robust as new tools are added and portable across the official
  (`github/github-mcp-server`) and archived community servers, which share the
  `owner` argument name even where tool names diverge.

  The consequence: **attach this policy to a GitHub-only pipeline.** If it is
  attached to a gateway fronting other MCP servers, a non-GitHub tool that
  happens to expose an `owner` argument would also be fenced. See Known
  limitations.

  ## Argument shape

  - `input.payload.args.owner` — the repository owner login. GitHub logins are
    case-insensitive, so the policy lower-cases and trims the value before
    comparing it to `company_orgs` (whose entries must be lowercase). A
    present-but-non-string `owner` (an unusual, malformed shape) is treated as
    off-list and denied — the policy fails closed rather than open.
  - Absent or empty-string `owner` → treated as an ownerless call and allowed.

  The GitHub MCP tool argument is `arguments.owner` at the MCP layer; the DTwo
  gateway surfaces it to the policy as `input.payload.args.owner`.

  ## Examples

  ### Allowed — owner is a sanctioned company org

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-get_file_contents", "type": "tool" },
      "payload": {
        "name": "github-mcp-get_file_contents",
        "args": { "owner": "acme-inc", "repo": "billing", "path": "README.md" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — ownerless call (already OAuth-scoped)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-search_code", "type": "tool" },
      "payload": {
        "name": "github-mcp-search_code",
        "args": { "q": "org:acme-inc AKIA" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — write into an off-list (personal/attacker) owner

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-push_files", "type": "tool" },
      "payload": {
        "name": "github-mcp-push_files",
        "args": { "owner": "evil-corp", "repo": "loot", "branch": "main", "files": [] }
      }
    }
  }
  ```

  `allow = false`, reason names `evil-corp` and points back to a sanctioned org.

  ## Composition

  This policy is single-purpose. Recommended companions (see the GitHub
  landscape note's candidate list):

  - The **role-gate** policy (read-only GitHub for non-engineers) — closes the
    ownerless read surface this policy cannot reach.
  - The **public-exposure** policy — forces `create_repository` private, denies
    public `create_gist`, and denies personal-namespace `fork_repository`.
  - An egress **secret-hygiene / IP-redaction** policy on `get_file_contents`,
    `search_code`, and `pull_request_read` responses.

  ## Known limitations

  - **Ownerless read/list tools still read across the OAuth grant.** Tools that
    take no `owner` — `search_code` with only a `q` string, `search_repositories`,
    `list_notifications`, `get_me` — remain readable across every repo the OAuth
    grant reaches, including the user's personal namespace. This policy cannot
    fence them. **Pair it with the role-gate and public-exposure policies** to
    cover that surface.
  - **Ownerless *writes* also escape the fence — including exfiltration paths.**
    "Ownerless" is not a synonym for "read-only." Some write tools carry no
    `owner` argument and so are allowed here even though they move content
    outward: `create_gist` / `update_gist` (content can land in a **public** gist,
    a direct exfil channel) and `create_repository` (the destination is the
    `organization` argument, not `owner`, so a new repo can be created in an
    off-list namespace). The gist argument schema is **unverified** in the
    landscape note (gists are owned by the authenticated user and expose no
    `owner`), so treat that as an assumption to confirm against your live
    `tools/list`. This fence does **not** stop these; the **public-exposure
    companion** (forces `create_repository` private, denies public `create_gist`)
    is what covers them. Note that a follow-up `push_files` into an off-list repo
    *is* caught here, because `push_files` carries `owner` — so the residual is
    the ownerless write tools themselves, not token-powered pushes.
  - **Attach to a GitHub-only pipeline.** The fence keys on the `owner` argument,
    not on the tool name. On a mixed gateway, any other server's tool that
    exposes an `owner` argument would also be fenced. If you must share the
    pipeline, add a tool-name guard.
  - **`q`-embedded owners are not parsed.** A `search_code` query like
    `q: "repo:torvalds/linux ..."` reaches a third-party repo through the query
    string, not the `owner` argument, so this policy does not catch it. Fence
    query strings with a separate rule if that path matters in your environment.
  - **`fork_repository` fences the source, not the destination.** Its `owner`
    argument is the repo being forked *from*. Forking a sanctioned company repo
    into a personal namespace (`organization` unset or set to a personal login)
    is the real IP-exfil direction and is **allowed** by this policy, because the
    source owner is on-list. Close that path with the public-exposure companion,
    which denies personal-namespace forks; do not rely on this fence for it.
  - **Allowlist is pinned per tenant.** `company_orgs` ships with placeholder
    logins (`acme-inc`, `acme-labs`). Replace them with your real org login(s)
    at import time; a stale or empty allowlist denies every owner-bearing call.
  - **Argument casing is version-dependent for other fields** (e.g. the PR-number
    parameter), but `owner` is stable across the official and archived servers
    per the landscape note. Verify against your live `tools/list` before relying
    on any other argument.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - github
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package github.ingress.fence_scopes_org_allowlist

# Deny-by-default: a call is permitted only by an explicit allow rule below.
default allow := false

# --- Per-tenant configuration ------------------------------------------------
# Company GitHub org logins the agent channel is permitted to touch. Pin this
# to YOUR org login(s) at import time. GitHub logins are case-insensitive, so
# keep every entry lowercase — the policy lower-cases the incoming `owner`
# before comparing. A stale or empty allowlist denies every owner-bearing call.
company_orgs := {
    "acme-inc",
    "acme-labs",
}

# --- Owner resolution --------------------------------------------------------
# Raw owner argument; "" when the argument is absent.
owner_arg := object.get(input.payload.args, "owner", "")

# The call carries an owner when the argument is present and non-empty.
# (A non-string owner, e.g. a number or object, is still "present" here and is
# handled as off-list below — the policy fails closed on malformed shapes.)
has_owner if {
    owner_arg != ""
}

# Canonical owner login for allowlist comparison: trimmed + lower-cased.
# Only defined when `owner` is a string; a present-but-non-string owner leaves
# this undefined, so it never matches the allowlist and is denied.
canonical_owner := lower(trim_space(owner_arg)) if {
    is_string(owner_arg)
}

# True only when the resolved owner is a sanctioned company org.
owner_on_allowlist if {
    company_orgs[canonical_owner]
}

# --- Allow rules -------------------------------------------------------------
# Ownerless calls are already scoped by the OAuth grant (e.g. get_me, or
# search_code with only a `q` string) — nothing to fence.
allow if {
    not has_owner
}

# Owner is present and resolves to a sanctioned company org.
allow if {
    has_owner
    owner_on_allowlist
}

# --- Deny reason -------------------------------------------------------------
# Names the offending owner and points the agent back to the sanctioned org.
reasons contains msg if {
    has_owner
    not owner_on_allowlist
    msg := sprintf("GitHub access is fenced to your company org allowlist. Owner '%v' is not a sanctioned org, so this call is blocked to keep source code inside the company boundary. Re-target the call at a repository your company org owns, or ask your InfoSec team to add '%v' to the allowlist if it is legitimately in scope.", [owner_arg, owner_arg])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
