---
name: "Require Human Approval: GitHub Merges & Approvals"
tags:
  - github
  - require-human-approval
  - ingress
  - soc2
  - sox
publishedAt: 2026-07-12
description: |
  # github / require-human-approval-merge

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `github.ingress.require_human_approval_merge`

  ## What it does

  Keeps a human in the loop on the two GitHub actions that consummate a code
  change: **merging a pull request** and **approving one**. An agent governed by
  this policy can still do the drafting work — open and update pull requests,
  create draft reviews, and leave review comments — but it can never approve a
  pull request or land its own code.

  Concretely, at ingress (before the call reaches the GitHub MCP server) it:

  - **Denies `merge_pull_request` outright.** A merge is effectively irreversible
    on a shared branch, so it always requires a human.
  - **Denies `pull_request_review_write` when the call would submit an approval.**
    The official server multiplexes review operations behind a single tool with a
    `method` discriminator (`create` / `submit` / `delete` / `resolve_thread` /
    `unresolve_thread`). The policy inspects `arguments.method`: `submit` is
    permitted only when the review event is a non-approving `COMMENT` or
    `REQUEST_CHANGES`; a `submit` that approves — or whose event cannot be
    confirmed as non-approving — is denied. `create`, `delete`, `resolve_thread`,
    and `unresolve_thread` pass through so the agent can draft reviews and manage
    comment threads.
  - **Denies the archived server's `create_pull_request_review` when its `event`
    is an approval.** That legacy tool has no `method`; it carries the review
    decision in an `event` field, so the policy inspects `arguments.event` for
    `APPROVE`/`approve` on this shape too.

  Read paths — `pull_request_read` and every other read/list tool — pass through
  untouched. This is a separation-of-duties / change-management control on the
  code-integration path: the initiator (the agent) cannot also be the approver.

  ## Compliance alignment

  - **SOC 2 CC6.3** — supports role-based access and **separation of duties** by
    ensuring the actor that authors a change is not the actor that approves or
    merges it. **CC8.1** — supports change management by keeping the merge/approve
    gate on the code-integration path under human control.
  - **SOX SoD (COSO Principle 10)** — supports the initiate-vs-approve separation
    on program changes. **Rule 13a-15(f)(2)(ii)** — supports transaction
    (change) authorization by requiring a human to authorize the landing of code.
    **ITGC program changes** — supports change-ticket-gated / human-approved code
    changes. **PCAOB AI human-in-the-loop** — supports a draft-only posture for
    the automated actor.

  ## Why ingress and not egress

  Merging and approving are writes with permanent, externally visible side
  effects — once the call reaches GitHub the merge has happened and the approval
  is recorded. Egress redaction could only mask the response returned to the
  agent, not undo the action. Ingress denial is the only way to actually prevent
  the merge/approval from occurring.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `github-mcp-merge_pull_request`), and that prefix is not standardized. The
  policy therefore matches on the **suffix**, case-insensitively:

  - `*merge_pull_request` — same name on both the official
    (`github/github-mcp-server`) and archived
    (`@modelcontextprotocol/server-github`) servers, so one suffix covers both.
  - `*pull_request_review_write` — official server's consolidated review tool.
  - `*create_pull_request_review` — archived server's review-creation tool.

  Verify the exact name your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  Read from `input.payload.args`:

  - `method` (official `pull_request_review_write`) — one of `create`, `submit`,
    `delete`, `resolve_thread`, `unresolve_thread`. Compared case-insensitively.
  - `event` (review decision) — `APPROVE` / `REQUEST_CHANGES` / `COMMENT`.
    Compared case-insensitively; an approval is `event == "approve"`.

  Both are read with `object.get(..., "")` defaults **and an `is_string` guard**, so
  a missing `args` object, a missing field, or a **non-string** value (a number,
  array, or object — e.g. `event: ["APPROVE"]`) never errors and is coerced to `""`,
  falling through to the fail-closed branches rather than slipping past them.

  The `args` container itself is also read defensively: `payload` is fetched with
  `object.get(input, "payload", {})` (so an absent payload does not go undefined), and
  an `args` value that is present but **not an object** (a string, array, number, or
  JSON `null` — e.g. `args: "submit"`) is coerced to `{}` via an `is_object` guard. This
  matters because `object.get` on a non-object raises a runtime type error that would
  otherwise leave `official_review_blocked` undefined and let the `allow` rule fire on
  `not undefined`, a fail-open bypass. Coercing to `{}` routes the malformed call into the
  unrecognized-method deny branch.

  ## Fail-closed behavior

  - A `pull_request_review_write` call whose `method` is **missing or malformed**
    (not one of the five recognized methods) is treated as a potential approval
    and **denied**.
  - A `pull_request_review_write` `submit` whose `event` is **not** a confirmed
    non-approving `COMMENT`/`REQUEST_CHANGES` (i.e. `approve`, missing, or
    malformed) is **denied**.
  - As a defensive backstop, an `event` of `approve` on the official tool is
    denied regardless of `method`.

  ## Examples

  ### Allowed — draft a pull request

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-create_pull_request", "type": "tool" },
      "payload": {
        "name": "github-mcp-create_pull_request",
        "args": { "owner": "acme", "repo": "app", "title": "Fix", "head": "f", "base": "main" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — submit a non-approving review

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-pull_request_review_write", "type": "tool" },
      "payload": {
        "name": "github-mcp-pull_request_review_write",
        "args": { "owner": "acme", "repo": "app", "method": "submit", "event": "COMMENT" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — merge

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-merge_pull_request", "type": "tool" },
      "payload": {
        "name": "github-mcp-merge_pull_request",
        "args": { "owner": "acme", "repo": "app", "pullNumber": 42 }
      }
    }
  }
  ```

  `allow = false`, reason asks the agent to have a human merge.

  ### Denied — submit an approval

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "github-mcp-pull_request_review_write", "type": "tool" },
      "payload": {
        "name": "github-mcp-pull_request_review_write",
        "args": { "owner": "acme", "repo": "app", "method": "submit", "event": "APPROVE" }
      }
    }
  }
  ```

  `allow = false`, reason asks the agent to have a human submit the approval.

  ## Composition

  This policy is single-purpose. Useful companions:

  - **`role-gate-writes`** (PF-12) — restrict all write tools to an
    `engineering` IdP group so non-engineers get read-only GitHub.
  - **`deny-public-exposure`** (PF-27) — force `private:true` on repos and block
    public gists/forks.
  - **`block-secrets-ingress`** (PF-16) — block credential-laden file writes and
    comments.

  See the [`bundles/soc2`](../../../bundles/soc2/README.md) and
  [`bundles/sox`](../../../bundles/sox/README.md) bundles for the curated sets.

  ## Known limitations

  - **Archived tool, missing event.** On the archived `create_pull_request_review`
    (no `method`), a call with a missing `event` creates a *pending* review, which
    is not an approval, so it passes. Only an explicit `event == "approve"` is
    denied on that shape. The official `pull_request_review_write` `submit` path is
    stricter (fail-closed on ambiguous event).
  - **Tool-name portability.** Matching is by suffix; a heavily renamed or aliased
    upstream tool would not match. Pair with `default-deny-unknown-tools` (PF-28)
    if you need drift protection against renamed tools.
  - **Untyped tool identity fails open.** Matching depends on `input.resource.name`.
    A `tool_pre_invoke` with **no** `resource.name` (or a null one) matches none of the
    target suffixes, so it passes through. The gateway always populates `resource.name`
    for tool hooks (it is constructed from the server + tool name, not caller-supplied),
    so this is not an attacker-controllable surface; it is documented as a residual and
    covered by a regression test. If you want to hard-fail unnamed calls, front this
    policy with `default-deny-unknown-tools` (PF-28).
  - **Argument-schema drift.** The `method`/`event` argument names for
    `pull_request_review_write` were inferred from the landscape note's
    consolidation pattern and the archived server's `event` field; the official
    server's exact per-method argument schema was **not verified from source** in
    the landscape pass. Confirm with the live `tools/list` before pinning field
    names in production, and extend `review_method`/`review_event` if your gateway
    exposes the discriminator under a different key.
  - **Merge-adjacent surfaces not covered.** `update_pull_request_branch`,
    `push_files`, and `create_or_update_file` can move code without a formal
    merge; this policy does not address them. Gate them with PF-12/PF-27 as
    needed.
  - **Autonomous-agent delegation is an escape hatch for the human-in-the-loop
    guarantee.** This policy blocks the *governed* agent from merging or approving,
    but the official server's `create_pull_request_with_copilot`,
    `assign_copilot_to_issue`, and `request_copilot_review` hand work to a **second
    autonomous Copilot agent that operates outside DTwo's view** — that agent can
    itself review, approve, or land code with no human in the loop, defeating the
    control's intent. Likewise `actions_run_trigger` can start a CI workflow that
    merges. These are deliberately out of scope for this single-purpose policy;
    gate them with the CI-trigger / role-gate companions (matrix candidate #6 and
    PF-12) if you need to close the delegation path.
  - **No identity-based exemption.** Every caller is subject to the gate. If you
    need a break-glass human-operator identity, add an `allow if` branch keyed on
    `input.subject.claims` (see the org-scoped example in the Rego skill).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - github
industries: []
bundles:
  - soc2
  - sox
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package github.ingress.require_human_approval_merge

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Tool matching (suffix, case-insensitive, portable across server prefixes) ---

# merge_pull_request has the same name on both the official and the archived
# community GitHub MCP servers, so a single suffix covers both implementations.
is_merge_tool if {
    endswith(lower(input.resource.name), "merge_pull_request")
}

# Official server: consolidated review tool with a `method` discriminator
# (create / submit / delete / resolve_thread / unresolve_thread).
is_official_review_write if {
    endswith(lower(input.resource.name), "pull_request_review_write")
}

# Archived community server: one tool per operation. Review creation carries an
# `event` field (APPROVE / REQUEST_CHANGES / COMMENT) instead of a `method`.
is_archived_review_create if {
    endswith(lower(input.resource.name), "create_pull_request_review")
}

is_target_tool if is_merge_tool

is_target_tool if is_official_review_write

is_target_tool if is_archived_review_create

# --- Argument extraction (fail-safe: default to "" when absent) ---

# Complete rules — always defined and always a string, so a missing args object,
# a missing field, OR a non-string value (number, array, object) never errors and
# never leaves the rule undefined; it just falls into the fail-closed branches.
# NOTE: guarding with is_string is load-bearing. `lower(123)` / `lower([...])`
# raises a built-in type error that leaves the rule *undefined*, and an undefined
# review_event makes `not non_approval_events[review_event]` evaluate to undefined
# (not true) — so a `submit` with a non-string `event` would slip through the
# approval gate. Coercing non-strings to "" forces the malformed value into the
# deny branch, matching the documented fail-closed contract.
# Read payload/args defensively. `object.get(input, "payload", {})` tolerates a
# missing payload; the is_object guard below fails closed when `args` is present
# but is NOT an object (a string, array, number, or JSON null). Without the guard,
# `object.get(_review_args, ...)` on a non-object raises a runtime type error and
# `object.get(input.payload, ...)` on an absent payload goes undefined — either way
# review_method/review_event become undefined, official_review_blocked becomes
# undefined, and `allow if { is_official_review_write; not official_review_blocked }`
# fires on `not undefined` == true. That is a fail-OPEN bypass: a review-write call
# with `args:"submit"`, `args:["APPROVE"]`, `args:null`, or no payload at all would
# slip past the approval gate. Coercing to {} routes it into the deny branch instead.
_payload := object.get(input, "payload", {})

_raw_args := object.get(_payload, "args", {})

_review_args := _raw_args if is_object(_raw_args)

_review_args := {} if not is_object(_raw_args)

_raw_method := object.get(_review_args, "method", "")

review_method := lower(_raw_method) if is_string(_raw_method)

review_method := "" if not is_string(_raw_method)

_raw_event := object.get(_review_args, "event", "")

review_event := lower(_raw_event) if is_string(_raw_event)

review_event := "" if not is_string(_raw_event)

# Recognized methods on the official review-write tool. Anything else (including
# a missing method) is treated as malformed and denied — fail closed.
recognized_methods := {"create", "submit", "delete", "resolve_thread", "unresolve_thread"}

# The only review events that are provably NOT an approval. `submit` is permitted
# only for these; approve / missing / malformed events are denied.
non_approval_events := {"comment", "request_changes"}

# --- Block conditions ---

# Missing / malformed method on the official review-write tool -> fail closed.
official_review_blocked if {
    not recognized_methods[review_method]
}

# submit with an event that is not a confirmed non-approval -> fail closed
# (covers approve, missing, and malformed events).
official_review_blocked if {
    review_method == "submit"
    not non_approval_events[review_event]
}

# Defensive backstop: an approval event on any method is blocked.
official_review_blocked if {
    review_event == "approve"
}

# Archived review-create is blocked only when the review event is an approval.
archived_review_blocked if {
    review_event == "approve"
}

# --- Allow rules ---

# Anything that is not a merge or review-write tool passes through untouched.
# This includes pull_request_read and every other read/list path.
allow if {
    not is_target_tool
}

allow if {
    is_official_review_write
    not official_review_blocked
}

allow if {
    is_archived_review_create
    not archived_review_blocked
}

# merge tools have no allow rule, so they are always denied by the default.

# --- Deny reasons ---

reasons contains "Merging a pull request requires a human. This agent can open and update pull requests, but it cannot merge them. Ask a human maintainer to review and merge this pull request. Contact your InfoSec or engineering-lead team if this control is blocking a legitimate automated workflow." if {
    is_merge_tool
}

reasons contains "Submitting a pull-request approval requires a human. This agent can create draft reviews and leave review comments (COMMENT or REQUEST_CHANGES), but it cannot approve a pull request. Ask a human reviewer to submit the approval and perform the merge. Contact your InfoSec or engineering-lead team if this control is blocking a legitimate automated workflow." if {
    is_official_review_write
    official_review_blocked
}

reasons contains "Submitting a pull-request approval requires a human. This agent can create draft reviews and leave review comments (COMMENT or REQUEST_CHANGES), but it cannot approve a pull request. Ask a human reviewer to submit the approval and perform the merge. Contact your InfoSec or engineering-lead team if this control is blocking a legitimate automated workflow." if {
    is_archived_review_create
    archived_review_blocked
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
