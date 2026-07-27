---
name: HubSpot Freeze Destructive Ops
tags:
  - hubspot
  - freeze-destructive-ops
  - archive
  - consent
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # hubspot / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.freeze_destructive_ops`

  ## What it does

  Blocks every archive/deletion-class HubSpot tool call, plus the
  consent-destroying contact unsubscribe, before it reaches the MCP server.
  Two classes are denied:

  - **Deletion/archive-class tools** — any tool whose name contains a
    destructive verb token (`archive`, `delete`, `void`, or `purge`) delimited
    by `_` or `-`. On the `@shinzolabs/hubspot-mcp` community server the
    verified destructive surface all uses `archive`: `crm_archive_object`,
    `crm_batch_archive_objects`, `calls_archive`, `emails_archive`,
    `meetings_archive`, `notes_archive`, `tasks_archive`, their
    `*_batch_archive` variants, `crm_archive_association`, and
    `products_archive`. The `delete`/`void`/`purge` verbs are forward-guard
    coverage (family PF-06) for a server swap or an upstream release that names
    deletion differently — no currently verified HubSpot tool uses them.
  - **Consent destruction** — `communications_unsubscribe_contact`, which
    irreversibly flips a contact's subscription/consent state.

  There is **no identity exemption**: records and consent state survive agent
  error or prompt injection regardless of who the caller is. All other tools
  pass through unchanged.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports the integrity of stored records: agent-initiated
    archival of CRM objects, engagements, associations, and products is denied
    on the MCP path, so records survive agent error or injection.
  - **HIPAA §164.312(c)** — supports the integrity (anti-alteration/destruction)
    safeguard where CRM records reference patient contacts; **§164.530(c)** —
    supports privacy safeguards by keeping consent state under human control.
  - **GDPR Art. 5(1)(d)** — supports accuracy by preventing agent
    mass-destruction of records and of subscription/consent state that is hard
    to reconstruct.

  ## Why ingress and not egress

  Archival and unsubscribe are writes with permanent side effects — once the
  call reaches HubSpot the record is gone from active use and the consent flag
  has flipped. Egress can only mask the response, not undo the action. Ingress
  denial is the only placement that actually prevents the destruction.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `hubspot-mcp-crm_archive_object`), and that prefix is not
  standardized, so the policy matches name shapes rather than exact strings:

  - **Destructive-verb token:** regex
    `(?:^|[_-])(?:archive|delete|void|purge)(?:[_-]|$)` on the lowercased tool
    name — a destructive verb bounded by `_`/`-` or the ends of the name. This
    catches suffix forms (`calls_archive`, `tasks_batch_archive`), mid-name
    forms (`crm_archive_object`, `crm_batch_archive_objects`,
    `crm_archive_association`), and kebab-case variants (`products-archive`),
    without matching unrelated words such as `archived` or `deleted`. HubSpot's
    verified destructive tools all use `archive`; the `delete`/`void`/`purge`
    alternatives fire only if a future or swapped server names deletion that
    way.
  - **Unsubscribe suffix:** the lowercased name ends with
    `unsubscribe_contact` or `unsubscribe-contact`. The suffix is long enough
    that `communications_subscribe_contact` (the legitimate opt-in tool) does
    **not** match.

  Verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  None. The decision is made purely on the tool name — arguments are never
  inspected, so the policy fails closed on the name alone even when `args` is
  empty or missing.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-mcp-crm_list_objects", "type": "tool" },
      "payload": {
        "name": "hubspot-mcp-crm_list_objects",
        "args": { "objectType": "contacts", "limit": 10 }
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
      "resource": { "name": "hubspot-mcp-crm_archive_object", "type": "tool" },
      "payload": {
        "name": "hubspot-mcp-crm_archive_object",
        "args": { "objectType": "contacts", "objectId": "12345" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Agent-initiated deletion or archival of HubSpot records is disabled on the MCP path. Delete or archive records in the HubSpot UI, where the action is audited and can be undone. Contact your admin if this blocks a legitimate workflow."`

  ## Composition

  This policy is single-purpose — it freezes destruction. Useful companions
  from the same app directory:

  - `hubspot/read-only` — the stricter posture: allow only read tools.
  - A consent-protection policy gating
    `communications_update_subscription_status` /
    `communications_update_preferences`, which can also change consent state
    but are not outright unsubscribes and are therefore out of scope here.
  - `hubspot/protect-associations`, `hubspot/protect-lifecycle-stage` — guard
    other integrity-critical write paths.

  ## Known limitations

  - **Community-server-specific surface.** Only the `@shinzolabs/hubspot-mcp`
    community server exposes these destructive tools. HubSpot's official
    remote server (`mcp.hubspot.com`) and local beta (`@hubspot/mcp-server`)
    currently ship **no** delete/archive tools, so on those servers this
    policy never fires. Keep it attached anyway — it is a forward guard
    against a server swap or an upstream release that adds destructive tools.
  - **Token match is deliberately broad.** Any tool whose name contains a
    delimited destructive-verb token (`archive`/`delete`/`void`/`purge`) is
    blocked, including hypothetical future read-side tools (e.g. a
    `list-archive-items`). That over-match is the conservative direction for a
    destruction freeze; narrow the regex if it bites in your environment.
  - **Server-prefix over-match (false positive).** Because the gateway prefixes
    tool names with the configured MCP server name and the match is not
    anchored to the tool segment, a server literally named with a leading
    destructive verb — e.g. `archive-mcp` or `delete-svc` — makes the leading
    `archive-`/`delete-` segment match, so *every* benign read on that server
    (e.g. `archive-mcp-crm_list_objects`) is denied. Name the HubSpot server
    something neutral (`hubspot`, `hubspot-mcp`) to avoid this; it does not
    weaken the freeze, it only over-blocks.
  - **Match relies on exact upstream tool names.** Detection is on the tool
    name only, so an obfuscated name — trailing whitespace/newline
    (`...unsubscribe_contact\n`), unicode homoglyphs, or split/renamed tokens —
    does not match and is allowed through. This is not an exploitable bypass:
    the gateway forwards the name verbatim and the upstream MCP server routes a
    call only when the name matches a registered tool exactly, so a mangled
    name cannot invoke the real destructive tool — it simply errors upstream.
    Confirm the exact names your gateway sends (dump-input) before relying on
    the suffix/token shapes.
  - **Consent updates are not fully covered.** shinzo's
    `communications_update_subscription_status` and
    `communications_update_preferences` can effectively unsubscribe a contact
    by setting the status value; this policy blocks only the dedicated
    unsubscribe tool. Pair with a consent-protection policy (see Composition).
  - **No identity-based exemptions — by design.** There is no break-glass
    group; humans perform archival and unsubscribe in the HubSpot UI, where
    audit and undo exist. If you must exempt a group, add an `allow if`
    branch gated on `input.subject.claims`.
  - **MCP path only.** Deletion via the HubSpot web UI or native API is
    outside the gateway's reach.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - hubspot
industries: []
bundles:
  - crm
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package hubspot.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rule below permits a request.
default allow := false

# Lowercased tool name, fetched with object.get so a missing resource/name
# yields "" (and therefore a clean non-match) instead of a silent rule failure.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Deletion/archive-class tools: a destructive verb token (archive | delete |
# void | purge) bounded by `_`/`-` or the ends of the name. On shinzo every
# verified destructive tool uses "archive" — calls_archive / emails_archive /
# meetings_archive / notes_archive / tasks_archive, their *_batch_archive
# variants, crm_archive_object, crm_batch_archive_objects,
# crm_archive_association, products_archive, and kebab-case renderings. The
# other verbs (delete/void/purge) are forward-guard coverage per policy family
# PF-06 for a server swap or upstream release that names deletion differently;
# no currently verified HubSpot tool uses them, so they never fire today. The
# delimiter bounding avoids matching words like "archived" or "deleted".
is_delete_archive_tool if {
    regex.match(`(?:^|[_-])(?:archive|delete|void|purge)(?:[_-]|$)`, tool_name)
}

# Consent destruction: shinzo's communications_unsubscribe_contact. Suffix
# match keeps the policy portable across gateway server-name prefixes; the
# suffix is long enough that communications_subscribe_contact never matches.
is_unsubscribe_tool if {
    endswith(tool_name, "unsubscribe_contact")
}

# Kebab-case portability variant of the same operation.
is_unsubscribe_tool if {
    endswith(tool_name, "unsubscribe-contact")
}

is_destructive_tool if is_delete_archive_tool

is_destructive_tool if is_unsubscribe_tool

# Allow everything that is not a destructive-class tool. No identity
# exemption: records and consent state survive agent error or prompt
# injection regardless of who the caller is.
allow if {
    not is_destructive_tool
}

reasons contains "Agent-initiated deletion or archival of HubSpot records is disabled on the MCP path. Delete or archive records in the HubSpot UI, where the action is audited and can be undone. Contact your admin if this blocks a legitimate workflow." if {
    is_delete_archive_tool
}

reasons contains "Agent-initiated unsubscribes are disabled on the MCP path because they irreversibly destroy a contact's consent state. Manage subscription preferences in the HubSpot UI, where the change is audited. Contact your admin if this blocks a legitimate workflow." if {
    is_unsubscribe_tool
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
