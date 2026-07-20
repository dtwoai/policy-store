---
name: Freeze the Zapier Toolset (No Self-Expansion)
tags:
  - zapier
  - constrain-aggregator
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # zapier / freeze-toolset

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny self-modifying meta-tools for non-admins, allow otherwise
  **Package:** `zapier.ingress.freeze_toolset`

  ## What it does

  In its default agentic mode, Zapier MCP exposes meta-tools that let the agent **widen its own
  blast radius mid-session**: `enable_zapier_action` and `auto_provision_mcp` add new actions to
  the toolset, `write_code_action` creates an arbitrary code-execution action, and
  `create_zapier_skill` / `update_zapier_skill` / `delete_zapier_skill` persist Markdown
  instructions that future sessions auto-load — a prompt-injection persistence vector that
  outlives the conversation.

  This policy denies those six self-modifying meta-tools unless the caller's IdP `groups` claim
  includes `automation-admins`, converting the self-expanding aggregator into a
  **fixed-capability connector**. `disable_zapier_action` and every read/execute meta-tool
  (`execute_zapier_read_action`, `execute_zapier_write_action`, `list_enabled_zapier_actions`,
  `discover_zapier_actions`, `list_zapier_skills`, `get_zapier_skill`, `get_configuration_url`,
  `send_feedback`) pass through, so the agent can still exercise — and narrow — its existing
  toolset, it just cannot grow it.

  Missing identity claims fail closed: a caller with no `groups` claim (or no claims at all) is
  not exempt and is denied.

  ## Compliance alignment

  - **SOC 2 CC6.6** — supports boundary protection against external threats: the gateway's
    security boundary around the Zapier connector stays fixed instead of being re-drawable by the
    agent (or by injected instructions) mid-session.
  - **SOC 2 CC6.8** — supports the prevention of unauthorized software: `write_code_action`
    creates arbitrary code-execution actions and `enable_zapier_action` / `auto_provision_mcp`
    install new capabilities into the agent's toolset; this policy restricts all three to an
    authorized admin group.
  - **SOC 2 CC9.2** — supports vendor/business-partner risk management: Zapier is a single
    vendor surface that can reach 9,000+ downstream apps, and this policy pins what that surface
    is allowed to become to an admin-controlled configuration.

  ## Tool name matching

  The policy matches the six frozen meta-tools by suffix:

  - `*enable_zapier_action`
  - `*auto_provision_mcp`
  - `*write_code_action`
  - `*create_zapier_skill`
  - `*update_zapier_skill`
  - `*delete_zapier_skill`

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `zapier-mcp-enable_zapier_action`), and that prefix is not standardized — matching on the
  suffix keeps the policy portable. Verify the exact names your gateway sends with the
  dump-input debug technique before relying on this in production.

  `disable_zapier_action` does **not** match the `enable_zapier_action` suffix (the preceding
  character differs), so narrowing the toolset stays available to everyone by design.

  ## Argument shape

  None. This policy decides purely on the tool name and the caller's identity claims — it never
  inspects `input.payload.args`, so it is immune to argument-shape drift in Zapier's meta-tools.

  Identity is read via `object.get(input.subject, "claims", {})` and
  `object.get(claims, "groups", [])`; the `groups` claim is expected to be an **array of
  strings** as emitted by the tenant's IdP.

  ## Examples

  ### Allowed — read/execute meta-tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-execute_zapier_read_action", "type": "tool" },
      "subject": { "sub": "auth0|dev", "claims": { "groups": ["engineering"] } },
      "payload": { "name": "zapier-mcp-execute_zapier_read_action", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — non-admin tries to enable a new action

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-enable_zapier_action", "type": "tool" },
      "subject": { "sub": "auth0|dev", "claims": { "groups": ["engineering"] } },
      "payload": { "name": "zapier-mcp-enable_zapier_action", "args": { "action": "gmail_send_email" } }
    }
  }
  ```

  `allow = false`, `reason = "This Zapier connector's toolset is frozen (...)"`.

  ### Allowed — automation admin enables a new action

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zapier-mcp-enable_zapier_action", "type": "tool" },
      "subject": { "sub": "auth0|admin", "claims": { "groups": ["engineering", "automation-admins"] } },
      "payload": { "name": "zapier-mcp-enable_zapier_action", "args": { "action": "gmail_send_email" } }
    }
  }
  ```

  `allow = true`, no reason.

  ## Composition

  This policy freezes the toolset's *shape*; it does not constrain what the already-enabled
  toolset can *do*. Useful companions:

  - A read-only-posture ingress policy denying `execute_zapier_write_action` for non-approved
    groups — one rule fences every write across 9,000 apps.
  - An app-blocklist policy that inspects the action identifier inside
    `execute_zapier_read_action` / `execute_zapier_write_action` arguments (e.g. deny finance
    apps outside a finance group).
  - A content policy that treats the `instructions` argument as content and scans it for
    non-corporate recipients or PII patterns — Zapier's server-side AI fills unspecified fields
    from `instructions` after the gateway has already passed the call.
  - For Zapier's classic (manual configuration) mode, a default-deny-unknown-tools allowlist
    policy pinned to the per-account tool inventory.

  ## Known limitations

  - **Agentic mode only.** The six frozen meta-tools exist only in Zapier MCP's dynamic
    tool-discovery (agentic) mode. In classic manual-configuration mode the policy is inert but
    harmless — classic tool names are `<app>_<action>` shapes that do not end in these suffixes.
  - **Group name is a placeholder.** Replace `automation-admins` with your IdP's real group name
    at import time, and confirm your IdP actually emits a `groups` claim in the access token
    (many IdPs require explicit configuration to do so). Callers whose tokens carry no `groups`
    claim are denied — including would-be admins.
  - **Group comparison is exact and case-sensitive.** Membership is a whole-string `==` on each
    `groups` element: `Automation-Admins`, `automation-admins-plus`, or the admin name emitted
    under a different claim (e.g. `roles`) never match — those callers are denied (fail closed).
    Match the placeholder to your IdP's group string exactly, including case.
  - **`groups` must be an array.** If your IdP emits `groups` as a single string or a
    space-delimited string, the membership check never matches and all callers are denied the
    frozen tools (fail closed). Adjust the `is_automation_admin` rule if your IdP uses a
    non-array shape.
  - **Skill reads still pass.** `list_zapier_skills` / `get_zapier_skill` are allowed, so a
    previously poisoned skill written before this policy was attached can still be *loaded*.
    Audit existing skills once when attaching this policy; the freeze prevents new persistence,
    not the reading of old state.
  - **Tool names verified against Zapier's official MCP docs** (docs.zapier.com, mid-2026). If
    Zapier renames or adds self-modifying meta-tools, extend `frozen_suffixes` accordingly — a
    default-deny-unknown-tools companion policy catches such drift automatically.
  - **Name drift is the residual bypass.** Suffix matching (`endswith`) is exact on the trailing
    bytes of `input.resource.name`, so any *extended* variant of a frozen name does **not** match
    and is allowed — a hypothetical `enable_zapier_action_v2`, but equally a name carrying a
    trailing space or newline (`enable_zapier_action\n`). Tool names are set by the upstream MCP
    server, not by the caller, so this is not a caller-controlled bypass on Zapier's hosted
    server; but this policy cannot anticipate names that do not exist yet. Pair it with the
    default-deny-unknown-tools allowlist companion if you need drift to fail closed.
  - **Matching keys on `input.resource.name`.** This is the canonical PARC tool-name field,
    reliably populated on every `tool_pre_invoke` hook and carrying the same value as the legacy
    `payload.name` alias. The policy never reads `payload.name`, so it does not depend on the
    deprecated alias.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - zapier
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zapier.ingress.freeze_toolset

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# IdP group exempted from the freeze. PLACEHOLDER — map to your tenant's real
# IdP group name at import time.
admin_group := "automation-admins"

# The six self-modifying Zapier meta-tools (agentic mode). Each one lets the
# agent change its own capability set:
#   enable_zapier_action / auto_provision_mcp — add new actions to the toolset
#   write_code_action                         — create an arbitrary code-execution action
#   create/update/delete_zapier_skill         — persist instructions future sessions auto-load
# Matched by suffix because the gateway prefixes tool names with the configured
# MCP server name (e.g. `zapier-mcp-enable_zapier_action`).
frozen_suffixes := [
    "enable_zapier_action",
    "auto_provision_mcp",
    "write_code_action",
    "create_zapier_skill",
    "update_zapier_skill",
    "delete_zapier_skill",
]

# The tool being called is one of the frozen self-modifying meta-tools.
# Note: `disable_zapier_action` does NOT end with `enable_zapier_action`
# (preceding character differs), so narrowing the toolset always passes.
is_frozen_tool if {
    name := lower(input.resource.name)
    some suffix in frozen_suffixes
    endswith(name, suffix)
}

# Caller is an automation admin. Fails closed: if `subject`, `claims`, or
# `groups` is missing (or `groups` is not an array), no membership is found
# and the caller is not exempt.
is_automation_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    some group in groups
    group == admin_group
}

# Pass through every tool that does not modify the toolset — including
# disable_zapier_action and all read/execute meta-tools.
allow if {
    not is_frozen_tool
}

# Automation admins may modify the toolset.
allow if {
    is_frozen_tool
    is_automation_admin
}

reasons contains "This Zapier connector's toolset is frozen: enabling actions, provisioning tools, code actions, and Zapier skill changes are restricted to automation admins. Ask an automation admin to provision the action out-of-band, then retry with your existing toolset. If you believe this is a false positive, contact your InfoSec team." if {
    is_frozen_tool
    not is_automation_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
