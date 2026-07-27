---
name: Human-Only ServiceNow Change Approval
tags:
  - servicenow
  - require-human-approval
  - change-management
  - separation-of-duties
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # servicenow / require-human-approval-changes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny the three change-approval control-gate tools; allow everything else
  **Package:** `servicenow.ingress.require_human_approval_changes`

  ## What it does

  Unconditionally denies the ServiceNow change-management **control-gate** tools —
  the ones whose names end in `approve_change`, `reject_change`, or
  `submit_change_for_approval` (verified echelon-ai-labs names) — on the agent
  path. There is **no identity-group exemption**: change approval is a
  separation-of-duties gate, so the consummating decision must not be
  agent-actuated even for privileged users.

  Every other tool passes through unchanged, so this policy composes cleanly with
  a role-gate-writes policy and the rest of the ServiceNow bundle. In particular,
  agents may still **draft and update** change requests — `create_change_request`,
  `update_change_request`, and `add_change_task` are untouched here (they are
  gated, if at all, by the write policy). This policy removes only the
  *consummation* step: the moment a change is approved, rejected, or submitted for
  approval.

  The deny reason directs the user to open the change request record in the
  ServiceNow UI and approve or reject it there, so the human approver's identity
  is preserved on the change record's audit trail rather than being replaced by
  the agent's service account.

  ## Compliance alignment

  - **SOC 2 CC8.1** — supports change management: the approval step that gates a
    change from proposed to authorized stays a human control on the agent path.
  - **SOC 2 CC6.3** — supports role-based access with separation of duties: the
    actor that drafts a change cannot also be the actor that approves it over MCP.
  - **SOX SoD (COSO Principle 10)** — supports the initiate-vs-approve separation
    for changes to financially relevant systems: an agent may initiate/draft, but
    a human must approve.
  - **SOX 13a-15(f)(2)(ii)** — supports transaction/change authorization by
    keeping the authorization action off the automated actor.
  - **SOX / PCAOB AI human-in-the-loop** — supports a draft-only agent posture for
    change consummation, consistent with human-oversight expectations for AI in
    ITGC change control.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name as
  `<server-name>-<tool-name>` (e.g. `servicenow-mcp-approve_change`), and that
  prefix is not standardized across deployments. The policy therefore matches
  case-insensitively on `lower(input.resource.name)` by **suffix**
  (`endswith`), against three verified echelon-ai-labs names:

  - `*approve_change`
  - `*reject_change`
  - `*submit_change_for_approval`

  Suffix matching is deliberately broad for a control gate: a tool named
  `bulk_approve_change` or `auto_approve_change` is *also* a change-approval
  action and is denied, which is the intended fail-safe direction. Verify the
  exact names your gateway sends with the dump-input debug technique before
  relying on this in production.

  This policy matches the echelon-ai-labs / michaelbuckner `verb_noun`
  vocabulary. Servers that rename these actions (e.g. `noun_verb`
  `change_approve`, or the official MCP Server Console's instance-defined subflow
  names) will not match by suffix — pair this policy with
  `servicenow/default-deny-unknown-tools` so unrecognized approval tools are
  denied by the allowlist instead of slipping past this deny.

  ## Argument shape

  This policy inspects only the tool **name** (`input.resource.name`). It reads no
  arguments, so it is insensitive to argument-shape differences between servers
  and cannot be bypassed by renaming or nesting an argument key. A missing
  `resource` or `resource.name` resolves to `""` via `object.get`; `""` is not one
  of the gated tools, so the call passes through to the other policies in the
  pipeline (this is a targeted deny, not a fail-closed allowlist — see Known
  limitations).

  ## Examples

  ### Allowed — drafting a change request

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-create_change_request", "type": "tool" },
      "payload": {
        "name": "servicenow-mcp-create_change_request",
        "args": { "short_description": "Patch web tier to 1.24.3" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — approving a change

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-approve_change", "type": "tool" },
      "payload": {
        "name": "servicenow-mcp-approve_change",
        "args": { "change_id": "CHG0031337" }
      }
    }
  }
  ```

  `allow = false`, `reason = "ServiceNow change approval is a separation-of-duties control gate ..."`.

  ## Composition

  This policy is single-purpose — it removes only the change-approval
  consummation step. Pair it with:

  - **`servicenow/role-gate-writes`** (PF-12) — the least-privilege baseline that
    decides which callers may draft/update change requests at all. This policy
    sits alongside it and takes precedence for the three approval tools regardless
    of role.
  - **`servicenow/default-deny-unknown-tools`** (PF-28) — the allowlist gate that
    catches renamed or instance-defined approval tools this suffix match cannot
    anticipate (plural/trailing-token variants like `approve_changes`,
    `approve_change_record`, and the official server's subflows).
  - **`servicenow/deny-escape-hatches`** (PF-22) — denies raw-API / generic-query
    and free-text-write tools (michaelbuckner's `perform_query`,
    `natural_language_update`, `get_record`/`search_records` against the approval
    tables). Those tools can consummate an approval by writing to the
    `sysapproval_approver` table *without* invoking a named `*approve_change`
    tool, so this deny cannot see them — PF-22 is what closes that route.
  - A **force-internal-comments transform** on `add_comment`, and an **egress PII
    redaction** policy on list/get responses, for the rest of the ServiceNow
    surface.

  ## Known limitations

  - **Targeted deny, not a fail-closed allowlist.** By design this policy denies
    only the three named control-gate tools and passes everything else — including
    an empty/missing tool name — through to the rest of the pipeline. Failing
    closed on unknown or unaudited tool names is the job of
    `servicenow/default-deny-unknown-tools`; deploy both.
  - **Name-based only; matches the echelon vocabulary.** The policy audits tool
    *names*, not behavior. Servers that use a different naming convention
    (`change_approve`, `noun_verb`) or the official MCP Server Console's
    instance-defined subflow names will not match by suffix. A Flow Designer
    subflow published under an innocuous name that internally approves a change
    would not be caught here — rely on the allowlist policy to gate it.
  - **Suffix breadth (prefix side only).** `endswith` matching also denies any
    tool whose name *ends* with one of the three suffixes (e.g.
    `bulk_approve_change`, `auto_approve_change`). For a separation-of-duties gate
    this over-inclusion is intentional; if a legitimate tool is caught, escalate
    to your gateway admin to pin an exact-name exception.
  - **Trailing-token variants slip past.** The flip side of suffix matching: a
    name with any token *after* the verb — a plural (`approve_changes`), a version
    (`approve_change_v2`), or a noun (`approve_change_record`) — does **not** end
    with the exact suffix and is therefore **allowed**. A leading whitespace/tab/
    newline is normalized away (`trim_space`), but an interior or trailing token is
    not. This is the same residual as any renamed action: rely on
    `servicenow/default-deny-unknown-tools` to fail these closed by allowlist.
  - **Generic-write / escape-hatch tools are invisible here.** This policy fires
    only on the three named approval verbs. It cannot see an approval consummated
    through a raw-query or free-text-write tool — michaelbuckner's `perform_query`
    / `natural_language_update`, a direct write to the `sysapproval_approver`
    table, or a Flow Designer subflow published under an innocuous name on the
    official server. Those pass through as `allow`. Pair with
    `servicenow/deny-escape-hatches` (PF-22) and `default-deny-unknown-tools`
    (PF-28) to close them.
  - **State-field consummation via allowed update tools.** This policy
    *deliberately* passes `create_change_request`, `update_change_request`, and
    `update_incident` through so agents can draft. But echelon's `update_*` tools
    accept a `state` field (and, on some instances, an `approval` field), and in
    ServiceNow the change lifecycle is driven by those fields. A caller can
    therefore advance or record an approval — e.g.
    `update_change_request(change_id, state: "-1"/"scheduled", approval:
    "approved")` — **without invoking any `*approve_change` verb**, so this
    name-only deny never sees it. This is the same residual as the raw-query route
    above, but through a mundane named tool this policy green-lights: do **not**
    read the "agents may still draft and update" note as "state transitions are
    safe." Gate the `state`/`approval` fields on `update_change_request` /
    `update_incident` with `servicenow/role-gate-writes` (PF-12) or a field-level
    ingress transform; this SoD gate covers only the three explicit approval verbs.
  - **`trim_space` normalizes only standard whitespace.** The trailing-whitespace
    fix uses `trim_space`, which strips space/tab/newline/CR and Unicode
    whitespace incl. NBSP (U+00A0) — but **not** zero-width or format characters
    (U+200B zero-width space, U+FEFF BOM, U+2060 word joiner). A tool name ending
    in one of those (`…approve_change​`) does not `endswith` the bare suffix
    and is therefore **allowed**. This is the same renamed-tool residual documented
    above and is intentionally not chased in the Rego (any strip list can itself be
    evaded); `servicenow/default-deny-unknown-tools` (PF-28) is the backstop.
  - **No identity-based exemptions — by design.** There is no break-glass group.
    Change approval over MCP is blocked for everyone, including privileged users;
    approvals happen in the ServiceNow UI where the human approver is recorded.
  - **Identity note.** This policy reads no identity claims, so there are no
    placeholder group names to replace at import time.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - servicenow
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package servicenow.ingress.require_human_approval_changes

# Deny-by-default: the change-management control-gate tools below are never
# allowed on the agent path. Every other tool passes through (allow), so this
# policy composes with role-gate-writes and the rest of the ServiceNow bundle.
default allow := false

# Change-management control-gate tool suffixes (verified echelon-ai-labs names).
# Each consummates an approval decision. Change approval is a separation-of-duties
# gate, so these are denied unconditionally — no identity exemption. Matched
# case-insensitively by suffix for portability across the gateway's
# `<server-name>-<tool-name>` prefixing.
control_gate_suffixes := [
    "approve_change",
    "reject_change",
    "submit_change_for_approval",
]

# Tool name, lowercased and whitespace-trimmed; missing resource/name resolves
# to "" (matches nothing, so a nameless call is not one of the gated tools and
# passes through). trim_space closes a suffix-match evasion: a name carrying a
# trailing space/tab/newline (e.g. "…approve_change\n") would otherwise fail the
# endswith check and be allowed — a fail-open on a control gate.
tool_name := trim_space(lower(object.get(object.get(input, "resource", {}), "name", "")))

# True when the call targets one of the change-approval control-gate tools.
is_control_gate_tool if {
    some suffix in control_gate_suffixes
    endswith(tool_name, suffix)
}

# Allow anything that is not a change-approval control-gate tool. The three
# gated tools have no allow branch and no identity exemption, so they are
# always denied.
allow if {
    not is_control_gate_tool
}

reasons contains "ServiceNow change approval is a separation-of-duties control gate and must not be actuated by an agent. Open the change request record in the ServiceNow UI and approve or reject it there, so the audit trail records a human approver. Agents may still draft and update change requests. If you believe this step should be automated, raise it with your change-management or GRC team instead of routing it through the agent." if {
    is_control_gate_tool
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
