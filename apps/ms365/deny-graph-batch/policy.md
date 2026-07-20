---
name: Deny Graph API Batch Escape Hatch
tags:
  - ms365
  - deny-escape-hatches
  - ingress
  - iso27001-nist
  - soc2
publishedAt: 2026-07-12
description: |
  # ms365 / deny-graph-batch

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny the raw Graph batch tool, allow everything else
  **Package:** `ms365.ingress.deny_graph_batch`

  ## What it does

  Blocks the Microsoft 365 MCP server's raw-Graph passthrough tool (`graph-batch`,
  observed live as `ms365-graph-batch`). The tool accepts an arbitrary array of
  `{method, url, body}` requests in the Microsoft Graph `$batch` shape, so a single
  call can reach **any** Graph endpoint the token allows — deleting groups, creating
  mail rules, sending mail, changing permissions — bypassing every per-tool policy
  in this catalog. No argument inspection is attempted: this is a blanket deny with
  `default allow := false`.

  Callers whose IdP-asserted `groups` claim contains the placeholder group
  `m365-admin` are exempt and may use the tool. Missing or empty claims mean no
  exemption — the grant fails closed.

  This is the **bypass-closer** for the Microsoft 365 policy set: without it,
  every other ms365 policy (external-send guards, share-link guards, destructive-op
  freezes, …) can be trivially side-stepped through one batch call. Attach it first.

  ## Compliance alignment

  - **ISO 27001 A.8.2 / NIST 800-53 AC-6(9), AC-6(10)** — supports privileged
    access restriction on the MCP path: the one tool that carries full-tenant Graph
    reach is withheld from everyone except an explicitly named admin group, and
    attempted use by non-privileged callers is denied (and auditable via the
    gateway's decision logs).
  - **SOC 2 CC6.1 / CC6.6** — supports logical access security and boundary
    protection against external threats: the raw-Graph passthrough is the single
    tool that bypasses every per-tool boundary in this catalog, and it is closed to
    all non-admin callers on the agent channel.
  - **HIPAA §164.312(a)(1) / §164.308(a)(4)** — supports access control and
    information access management on a PHI-capable suite: `graph-batch` can reach any
    mailbox, drive, or SharePoint item the token allows, so denying it prevents the
    agent from side-stepping the minimum-necessary and access-control policies that
    protect ePHI.
  - **GDPR Art. 32 / Art. 25** — supports security of processing and data protection
    by default: the escape hatch can move personal data arbitrarily (sendMail, bulk
    export, permission changes), and a default-deny on it keeps agent access to
    personal data confined to the audited per-tool surfaces.

  ## Tool name matching

  The policy matches on `lower(input.resource.name)`:

  - `*-graph-batch` (suffix — any gateway server-name prefix)
  - `graph-batch` (exact — the server's own un-prefixed tool name)

  The DTwo gateway prefixes tool names with the configured MCP server name (the
  live deployment of `softeria/ms-365-mcp-server` exposes this tool as
  `ms365-graph-batch`), and that prefix is not standardized — matching on the
  suffix keeps the policy portable across server names. The bare `graph-batch`
  form is matched exactly as well, so a deployment that fronts the server with an
  empty or absent prefix (where the tool arrives as `graph-batch`, which does not
  end with a leading-hyphen `-graph-batch`) still fails closed rather than open.
  Verify the exact name your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  None inspected. `graph-batch` takes a `requests` array of `{method, url, body}`
  objects (Graph `$batch` shape); this policy deliberately does **not** try to
  classify individual sub-requests as safe or unsafe — URL-parsing allowlists over
  a passthrough surface are fragile (casing, encoding, `$batch`-relative URLs) and
  a single missed write defeats the entire catalog. Denying the tool outright is
  the only robust posture; admins who genuinely need it are exempted by group.

  ## Examples

  ### Allowed — any other ms365 tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-send-mail", "type": "tool" },
      "payload": { "name": "ms365-send-mail", "args": { /* ... */ } }
    }
  }
  ```

  `allow = true`, no reason. (Companion policies may still apply.)

  ### Denied — non-admin calls the batch tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-graph-batch", "type": "tool" },
      "subject": { "sub": "user@example.com", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "ms365-graph-batch",
        "args": { "requests": [{ "method": "DELETE", "url": "/groups/abc", "body": {} }] }
      }
    }
  }
  ```

  `allow = false`, `reason = "The raw Graph batch tool is disabled (...)"`.

  ### Allowed — caller in the admin group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-graph-batch", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["m365-admin"] } },
      "payload": { "name": "ms365-graph-batch", "args": { "requests": [] } }
    }
  }
  ```

  `allow = true`.

  ## Composition

  This policy is single-purpose and is a **prerequisite** for the rest of the
  Microsoft 365 set: per-tool policies on `send-mail`, `create-drive-item-share-link`,
  `delete-*`, `create-mail-rule`, etc. are only meaningful when the batch escape
  hatch is closed. Attach it to every pipeline that fronts a Graph-backed M365
  MCP server, alongside whichever per-tool ms365 policies your posture requires.

  ## Known limitations

  - **Lokka-style deployments are out of scope.** `merill/lokka` exposes a
    different single-tool passthrough (`Lokka-Microsoft`, args `apiType`/`path`/
    `method`/`body`) that does not end with `-graph-batch` and therefore does not
    match this policy. If your gateway fronts a Lokka server, you need a separate
    policy that inspects Lokka's `method`/`path` arguments — name-based deny alone
    cannot distinguish its reads from writes.
  - **Group names are placeholders** — replace `m365-admin` with your IdP's group
    name at import time. The comparison is exact (case-sensitive), and the `groups`
    claim must be an array of strings; a missing, empty, or differently-shaped
    claim yields no exemption (fail closed).
  - **All-or-nothing.** Because no argument inspection is attempted, read-only
    batches (e.g., a batch of GETs) are denied for non-admins too. That is
    intentional: the specific `list-*`/`get-*` tools cover those needs.
  - **This policy must be attached for the rest of the ms365 catalog to hold.**
    A pipeline carrying only the per-tool ms365 policies but not this one leaves
    the batch bypass open.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - ms365
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package ms365.ingress.deny_graph_batch

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# The raw-Graph passthrough tool. The gateway prefixes tool names with the
# configured MCP server name (observed live as `ms365-graph-batch`), so we
# match on the suffix to stay portable across naming conventions. Verify the
# exact tool name on your gateway with the dump-input debug technique before
# relying on this in production.
is_graph_batch_tool if {
	endswith(lower(input.resource.name), "-graph-batch")
}

# Also match the server's own un-prefixed tool name. The softeria server names
# this tool `graph-batch`; the `ms365-`/`contoso-` prefix is added by the
# gateway and is "not standardized" — a deployment that fronts the server with
# an empty/absent server-name prefix would send the bare `graph-batch`, which
# does NOT end with a leading-hyphen "-graph-batch" and would otherwise fail
# open. Match it exactly so the blanket deny holds regardless of prefixing.
is_graph_batch_tool if {
	lower(input.resource.name) == "graph-batch"
}

# Groups asserted by the caller's IdP-issued JWT. A missing subject, missing
# claims, or missing groups claim resolves to [] (or leaves the exemption rule
# undefined) — either way the caller is not exempt: the grant fails closed.
caller_groups := object.get(object.get(input.subject, "claims", {}), "groups", [])

# Placeholder admin group — replace "m365-admin" with your IdP's group name
# at import time. Exact match; the groups claim must be an array of strings.
is_exempt_admin if {
	some group in caller_groups
	group == "m365-admin"
}

# Allow every tool that isn't the raw Graph batch passthrough.
allow if {
	not is_graph_batch_tool
}

# Allow the batch tool only for callers in the admin group.
allow if {
	is_graph_batch_tool
	is_exempt_admin
}

reasons contains "The raw Graph batch tool is disabled: one batch call can reach any Microsoft Graph endpoint and bypass per-tool policies. Use the specific Microsoft 365 tool for your task instead (for example send-mail, get-drive-item, or list-mail-messages). If you have a legitimate batch workflow, contact your administrator to request access." if {
	is_graph_batch_tool
	not is_exempt_admin
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
