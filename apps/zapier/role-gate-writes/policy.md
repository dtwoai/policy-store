---
name: Role-Gate All Zapier Writes
tags:
  - zapier
  - role-gate-writes
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # zapier / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny writes for non-approved groups, allow reads for everyone
  **Package:** `zapier.ingress.role_gate_writes`

  ## What it does

  Zapier MCP is an aggregator: one connector proxies actions across 9,000+ apps, and every
  create/update/delete/send funnels through a small, predictable naming surface. In agentic
  (dynamic tool discovery) mode, **all writes go through a single meta-tool**,
  `execute_zapier_write_action` — a Gmail delete and a Salesforce record update both arrive as
  the same tool name. In classic (manual configuration) mode, each enabled action is its own
  `<app>_<action>` tool whose name carries a write verb (`send_`, `create_`, `update_`,
  `delete_`, `remove_`) — e.g. `gmail_send_email`, `google_sheets_create_row`.

  This policy denies all of them unless the caller's IdP `groups` claim includes
  `automation-writers`, while reads (`execute_zapier_read_action`, discovery/list meta-tools,
  and classic `find_`/`get_` tools) stay open to everyone. The result is a
  **read-only-by-default posture** for the whole aggregator: one rule fences writes across
  every proxied app.

  Missing identity claims fail closed: a caller with no `groups` claim (or no claims at all)
  is not an approved writer and is denied all writes — reads remain available.

  ## Compliance alignment

  - **SOC 2 CC6.1 / CC6.3** — supports logical access security and role-based least privilege:
    write access to every app behind the Zapier connector is granted only to an authorized IdP
    group, evaluated per call. **CC6.2** — supports credential de-provisioning effect: removal
    from the IdP group revokes write access on the next call, with no per-app work.
  - **PCI DSS 7.2.1 / 7.2.2** — supports a least-privilege access model over the aggregator's
    reach into cardholder-adjacent apps (payment, invoicing, commerce actions all transit the
    same write funnel). **7.2.5** — supports least privilege for the application account: the
    broad per-app OAuth grants held Zapier-side are narrowed to read-only on the MCP path for
    non-writers.
  - **HIPAA §164.308(a)(4)** — supports information access management for connectors that can
    reach PHI-bearing apps; **§164.502(b)/§164.514(d)** — supports minimum-necessary,
    role-based limits (reads only, unless the role warrants writes);
    **§164.312(a)(1)** — supports access control decided on per-call, per-user identity.
    **§164.308(a)(3)** — supports workforce-security termination effect via live IdP claims.
  - **GDPR Art. 25** — supports data protection by default on the agent channel: the
    aggregator's default capability is read-only. **Art. 29 / 32(4)** — supports processing
    only on the controller's instructions: agents acting for unapproved users cannot mutate
    personal data in downstream processors. **CCPA §1798.100(e)** — supports reasonable
    security over consumer data reachable through the connector.
  - **SOX (ITGC — access to programs and data)** — supports least-privilege access to
    financial systems reachable through Zapier (accounting, billing, ERP actions);
    **SoD (COSO P10)** — supports initiate/approve separation by keeping record-mutation
    ability out of unapproved hands.

  ## Tool name matching

  Case-insensitive, on the tool-name suffix (the DTwo gateway prefixes tool names with the
  configured MCP server name, e.g. `zapier-mcp-execute_zapier_write_action`, and that prefix
  is not standardized — suffix matching keeps the policy portable):

  - **Agentic write funnel** — name ends with `execute_zapier_write_action` (exact
    meta-tool name, verified against Zapier's official MCP docs).
  - **Classic writes** — name contains a write-verb substring: `send_`, `create_`, `update_`,
    `delete_`, `remove_`.

  Everything else passes: `execute_zapier_read_action`, `list_enabled_zapier_actions`,
  `discover_zapier_actions`, `list_zapier_skills`, `get_zapier_skill`,
  `get_configuration_url`, and classic `find_`/`get_` tools (e.g.
  `quickbooks_online_find_customer`).

  Note the verb-substring rule also catches the agentic skill meta-tools
  (`create_zapier_skill`, `update_zapier_skill`, `delete_zapier_skill`) and `send_feedback` —
  intentional, since all four are writes (skill changes persist instructions future sessions
  auto-load). See Known limitations for the composition consequence.

  Verify the exact names your gateway sends with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  None. This policy decides purely on the tool name and the caller's identity claims — it
  never inspects `input.payload.args`, so it is immune to argument-shape drift in Zapier's
  tools (including the underdocumented `execute_zapier_*_action` envelope).

  Identity is read via `object.get(input.subject, "claims", {})` and
  `object.get(claims, "groups", [])`; the `groups` claim is expected to be an **array of
  strings** as emitted by the tenant's IdP.

  ## Examples

  ### Allowed — read funnel, any caller (no claims needed)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-execute_zapier_read_action", "type": "tool" },
      "subject": { "sub": "auth0|analyst", "claims": {} },
      "payload": { "name": "zapier-mcp-execute_zapier_read_action", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — non-writer hits the agentic write funnel

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-execute_zapier_write_action", "type": "tool" },
      "subject": { "sub": "auth0|analyst", "claims": { "groups": ["engineering"] } },
      "payload": { "name": "zapier-mcp-execute_zapier_write_action", "args": { "instructions": "email the report to the team" } }
    }
  }
  ```

  `allow = false`, `reason = "Zapier write actions are restricted (...)"`.

  ### Allowed — approved writer sends via a classic-mode tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-gmail_send_email", "type": "tool" },
      "subject": { "sub": "auth0|ops", "claims": { "groups": ["engineering", "automation-writers"] } },
      "payload": { "name": "zapier-mcp-gmail_send_email", "args": { "to": "team@example.com", "subject": "report" } }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  This policy fences *who* may write; it does not constrain *what* a permitted write contains
  or which apps it reaches. Useful companions:

  - [`zapier/freeze-toolset`](../freeze-toolset/policy.md) — stops the agent from widening its
    own toolset (`enable_zapier_action`, `auto_provision_mcp`, `write_code_action`, skill
    persistence); this policy assumes the toolset is what admins configured.
  - [`zapier/guard-external-send`](../guard-external-send/policy.md) — content controls on the
    writes that approved writers do make.
  - [`zapier/default-deny-unknown-tools`](../default-deny-unknown-tools/policy.md) — classic
    mode's tool inventory is per-account; an allowlist catches write actions whose names use a
    verb this policy does not list.
  - [`zapier/mask-pan-egress`](../mask-pan-egress/policy.md) — reads stay open under this
    policy, so pair with egress redaction for what those reads return.

  ## Known limitations

  - **Group name is a placeholder.** Replace `automation-writers` with your IdP's real group
    name at import time, and confirm your IdP actually emits a `groups` claim in the access
    token (many IdPs require explicit configuration to do so). Callers whose tokens carry no
    `groups` claim are denied all writes — including would-be writers.
  - **`groups` must be an array.** If your IdP emits `groups` as a single string or a
    space-delimited string, the membership check never matches and every caller is denied
    writes (fail closed). Adjust `is_approved_writer` if your IdP uses a non-array shape.
  - **The verb list is not exhaustive.** Classic-mode action names are per-account and only a
    handful are verified from public docs; a write action whose name carries a different verb
    (e.g. `add_`, `post_`, `move_`, `archive_`) would pass as a "read". Extend `write_verbs`
    for your inventory, or pair with `default-deny-unknown-tools` so unlisted names are denied
    by default.
  - **Agentic write meta-tools overlap `freeze-toolset`.** `create_/update_/delete_zapier_skill`
    match the verb rule, so when both policies are attached, changing skills requires being in
    *both* the admin and writer groups. The toolset self-modification meta-tools —
    `enable_zapier_action`, `disable_zapier_action`, `auto_provision_mcp`, and
    `write_code_action` — carry no listed verb and are **not** gated here; they are
    writes-of-capability, not writes-of-data, and are out of this policy's scope by design.
    Attach `freeze-toolset` to cover them (note `freeze-toolset`'s own candidate list omits
    `disable_zapier_action`, so confirm it enumerates every self-modification tool your server
    exposes).
  - **Unidentifiable calls fail closed.** A request whose `resource.name` is missing, `null`,
    or an empty string cannot be classified as a read or a write, so it does not match the
    read-open branch and falls through to `default allow := false` (denied). Real gateway
    traffic always carries a tool name; this guard only removes a fail-open corner and never
    blocks a legitimately named read.
  - **Verb matching sees the whole prefixed name.** A gateway server name containing a verb
    substring (e.g. a server named `zapier-send_prod`) would classify every tool on it as a
    write. Name servers without `send_`/`create_`/`update_`/`delete_`/`remove_` substrings.
  - **Reads are open by design.** `execute_zapier_read_action` still proxies reads across
    every enabled app, and Zapier's server-side AI resolves `instructions` after the gateway
    passes the call. This policy is a write fence, not a data-access control — compose with
    egress redaction and app-scoping policies for read-side exposure.
  - **Tool names verified against Zapier's official MCP docs** (docs.zapier.com, mid-2026) for
    the agentic meta-tools; classic-mode examples (`gmail_send_email`,
    `google_sheets_create_row`, `quickbooks_online_find_customer`) come from third-party
    client docs — treat other classic names as unverified until observed on a live server.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - zapier
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zapier.ingress.role_gate_writes

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# IdP group approved to perform Zapier writes. PLACEHOLDER — map to your
# tenant's real IdP group name at import time.
writer_group := "automation-writers"

# Classic-mode write verbs. Zapier classic (manual configuration) tools are
# named `<app>_<action>` (e.g. gmail_send_email, google_sheets_create_row);
# a name carrying one of these substrings is treated as a write. The list is
# intentionally conservative — extend it for per-account action inventories
# that use other verbs (add_, post_, ...), or pair with a
# default-deny-unknown-tools allowlist to catch what this misses.
write_verbs := [
    "send_",    # externally visible sends (email, chat, social posts)
    "create_",  # record/row/page/event creation
    "update_",  # record mutation
    "delete_",  # destructive; Zapier offers no undo
    "remove_",  # destructive; Zapier offers no undo
]

# Agentic mode: every write across 9,000+ proxied apps funnels through this
# single meta-tool. Matched by suffix because the gateway prefixes tool names
# with the configured MCP server name
# (e.g. `zapier-mcp-execute_zapier_write_action`).
is_agentic_write if {
    endswith(lower(input.resource.name), "execute_zapier_write_action")
}

# Classic mode: per-action tools whose name carries a write verb. This also
# intentionally catches the agentic skill meta-tools (create_/update_/
# delete_zapier_skill) and send_feedback — all of them are writes.
is_classic_write if {
    name := lower(input.resource.name)
    some verb in write_verbs
    contains(name, verb)
}

is_write_tool if {
    is_agentic_write
}

is_write_tool if {
    is_classic_write
}

# Caller is an approved writer. Fails closed: if `subject`, `claims`, or
# `groups` is missing (or `groups` is not an array), no membership is found
# and the caller is not approved.
is_approved_writer if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    some group in groups
    group == writer_group
}

# A resolvable, non-empty tool name is required before anything is treated as
# a read. Without this guard a call whose `resource.name` is missing, null, or
# empty would make `is_write_tool` undefined/false and sail through the
# read-open branch below — a fail-open on tool identity. Requiring the name to
# be a non-empty string makes an unidentifiable call fall through to
# `default allow := false` (fail closed).
has_tool_name if {
    is_string(input.resource.name)
    input.resource.name != ""
}

# Reads stay open to everyone: execute_zapier_read_action, discovery/list
# meta-tools, and classic find_/get_ tools carry no write verb.
allow if {
    has_tool_name
    not is_write_tool
}

# Approved writers may write.
allow if {
    is_write_tool
    is_approved_writer
}

reasons contains "Zapier write actions are restricted to members of the automation-writers group; read actions remain available to everyone. Ask your IdP administrator to add you to automation-writers if your role requires write access through this connector. If you believe this is a false positive, contact your InfoSec team." if {
    is_write_tool
    not is_approved_writer
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
