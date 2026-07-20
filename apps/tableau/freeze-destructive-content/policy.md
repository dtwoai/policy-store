---
name: Freeze Destructive Tableau Content Ops
tags:
  - tableau
  - freeze-destructive-ops
  - record-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # tableau / freeze-destructive-content

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `tableau.ingress.freeze_destructive_content`

  ## What it does

  Denies the irreversible content-mutation tools on the official `tableau/tableau-mcp`
  web server unless the caller's IdP token carries the placeholder group
  `tableau-admins`. All other tool calls (reads, queries, catalog/metadata, Pulse, view
  renders) pass through unchanged.

  The frozen surface is the server's destructive/mutation set: deleting a published
  data source or workbook, deleting an extract-refresh task, and rewriting a cloud
  extract-refresh schedule. Deleted workbooks and data sources go to the Tableau recycle
  bin and are recoverable for **only a limited window** before they are permanently gone;
  a silently stopped or rescheduled extract refresh is a data-integrity incident, not
  just an ops one — dashboards go stale while still looking live. An agent acting on a
  hallucinated instruction or an injected prompt must not be able to destroy content or
  quietly break a refresh, so this family is admin-gated for everyone else. The check runs
  at ingress, before the call reaches the MCP server, so a blocked delete never executes.

  This IdP-claim gate sits **on top of** the server's own mutation guard
  (`src/tools/web/_lib/mutationGuard.ts`): the server already enforces a site-admin gate,
  a preview→confirm protocol, and a per-mutation audit record — but that guard is keyed on
  *Tableau* roles and is the server's policy, not yours. The DTwo policy on IdP claims is
  the only org-controlled gate, and it composes with (does not replace) the server guard.

  ## Compliance alignment

  - **SOC 2 PI1.5** (Integrity of stored records — PF-06) — supports integrity of stored records by removing the agent's unilateral ability to delete BI content or silently break the extract refreshes that keep it accurate.
  - **GDPR Art. 5(1)(d)** (Accuracy — anti-mass-corruption — PF-06) — supports accuracy by preventing mass-deletion of personal-data content and by blocking silent extract-refresh reschedules that would leave personal-data dashboards stale and inaccurate.

  ## Tool name matching

  The official server names tools **kebab-case with no vendor prefix**
  (`delete-workbook`, `confirm-delete-workbook`), and the DTwo gateway prepends the
  configured MCP server name (e.g. `tableau-delete-workbook`). Because the prefix is
  deployment-specific, the policy matches on the **distinctive suffix**, case-insensitively,
  for both the base tool and its separately-registered `confirm-` twin:

  - `-delete-datasource` / `-confirm-delete-datasource`
  - `-delete-workbook` / `-confirm-delete-workbook`
  - `-delete-extract-refresh-task` / `-confirm-delete-extract-refresh-task`
  - `-update-cloud-extract-refresh-task` / `-confirm-update-cloud-extract-refresh-task`

  Every destructive tool on this server has a `confirm-` twin registered as a **separate
  tool** — a gate on `delete-workbook` that misses `confirm-delete-workbook` (or vice
  versa) leaves the other half open, so both are enumerated explicitly. The suffixes are
  distinctive enough not to collide with the read surface: `list-extract-refresh-tasks`
  (plural) is not matched, and no read/catalog tool ends in one of these suffixes.

  Underscores in the tool name are normalized to hyphens before matching, so a
  snake_case-named community variant (`delete_workbook`) is gated too — over-matching is
  the safe direction for a record-integrity freeze. The name is read from **both** the PARC
  field (`input.resource.name`) and the legacy alias (`input.payload.name`) via `object.get`
  chains, matched **independently**: a request missing the `resource` block, or one carrying
  a malformed (non-string) value in either field, still cannot skip the match. Each field is
  coerced to a lowercased, whitespace-trimmed string (a number, null, array, or object resolves
  to the empty string), so a non-string value in one field can never suppress a genuine
  destructive verb in the other, and leading/trailing whitespace or a trailing newline cannot
  push a real destructive suffix out of reach of the `endswith` match.

  Verify the exact names your gateway sends with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  None. The decision uses only the tool name (`input.resource.name`, with the legacy
  `input.payload.name` as fallback) and the caller's identity
  (`input.subject.claims.groups`); arguments are not inspected. In particular, this policy
  ignores the server's `confirm` boolean — it freezes the whole destructive family for
  non-admins rather than only the `confirm: true` execution call. (If you instead want
  agents to be able to *stage* a deletion for a human to confirm in the Tableau UI, use the
  companion preview-only policy that keys on `arguments.confirm`; see Composition.)

  Group membership is read via `object.get`-chained access to `input.subject.claims.groups`
  and fails closed: a missing subject, missing claims, missing `groups`, or a non-array
  `groups` value all mean "not admin", so the destructive call is denied.

  ## Examples

  ### Allowed — read tool, any caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-list-workbooks", "type": "tool" },
      "payload": { "name": "tableau-list-workbooks", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — delete by an admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-delete-workbook", "type": "tool" },
      "subject": { "sub": "admin@example.com", "claims": { "groups": ["tableau-admins"] } },
      "payload": { "name": "tableau-delete-workbook", "args": { "workbookId": "wb-luid" } }
    }
  }
  ```

  `allow = true`.

  ### Denied — delete by a non-admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-confirm-delete-datasource", "type": "tool" },
      "subject": { "sub": "analyst@example.com", "claims": { "groups": ["data-analysts"] } },
      "payload": { "name": "tableau-confirm-delete-datasource", "args": { "datasourceId": "ds-luid", "confirm": true } }
    }
  }
  ```

  `allow = false`, `reason = "This Tableau content operation is blocked because it is hard to reverse (...)"`.

  ## Composition

  This policy is single-purpose: it freezes the destructive content family and nothing
  else. Useful companions from the Tableau candidate set:

  - **Preview-only deletes** — allow the delete tools when `arguments.confirm` is absent or
    false and deny only when `confirm == true`, so an agent can stage/report a deletion for
    a human to execute. Use this *instead of* this policy where a hard admin freeze is too
    disruptive; use it *alongside* to also gate the preview step behind a group.
  - **Deny token management** — deny `get-embed-token`, `revoke-access-token`,
    `reset-consent` for everyone; those mint/break credentials and are out of scope here.
  - **Admin-insights lockdown** — gate `query-admin-insights-ts-events`,
    `query-admin-insights-site-content`, `query-admin-insights-job-performance`,
    `get-stale-content-report`, and `list-users` behind `tableau-admins` (employee-monitoring data).
  - **Egress PII redaction + image deny** on `query-datasource` / `get-view-data` /
    `get-view-image` — content-level controls this ingress freeze does not touch.

  ## Known limitations

  - **Group names are placeholders — replace `tableau-admins` with your IdP's group name at
    import time.** The gate reads `input.subject.claims.groups`; confirm your IdP actually
    emits a `groups` claim (Auth0 and Entra ID both require explicit configuration) before
    relying on the admin exemption. With no `groups` claim, the policy still fails closed:
    destructive calls are denied for everyone.
  - **Tableau Next is a different product.** The Salesforce-hosted Tableau Next server
    (`analytics/tableau-next`) uses disjoint snake_case tool names and is read-only as of
    GA (no delete/write tools), so this policy neither covers nor needs to cover it. A
    customer could run both products behind the gateway.
  - **Community servers use unverified names.** The community Python servers
    (LokiMCPUniverse, hetpatel-11) advertise REST-backed write tools whose names are
    unverified in the landscape note. The underscore-normalizing suffix match catches
    `delete_*`-shaped variants, but verify with dump-input if you deploy one.
  - **Name-mutation evasion is bounded by exact-name routing, not by this policy.**
    The match normalizes case, underscores→hyphens, and strips leading/trailing *whitespace*
    and newlines, but it does **not** catch a name whose *word separators* or *characters*
    differ from the registered tool — e.g. camelCase (`deleteWorkbook`), a Unicode look-alike
    hyphen (U+2010), an extra internal separator (`delete-data-source`), or a trailing
    **zero-width / non-whitespace invisible character** (e.g. U+200B zero-width space, which
    `trim_space` does **not** strip because it is a format character, not whitespace — so
    `-delete-workbook​` is invisible on screen yet slips past the `endswith` suffix
    match). The "trailing whitespace/newline cannot push a suffix out of reach" guarantee in
    **Tool name matching** above is precise: it holds for whitespace only, not for zero-width
    format characters. Any such string is only a bypass if the MCP server would route it to
    the real destructive tool, and the official and known community servers match tool names
    **exactly**: a mutated string names no routable tool and cannot execute a delete.
    Re-verify tool names with dump-input before trusting this for a server whose name-matching
    you have not confirmed.
  - **Destruction-by-overwrite and passthrough are out of scope.** `update-cloud-extract-refresh-task`
    is included because a silent reschedule is a data-integrity event, but the desktop
    toolset's `apply-workbook` (writes workbook XML) runs local to Tableau Desktop and does
    not traverse the gateway. Content overwrite via re-publish is not modeled here.
  - **The server's own mutation guard is separate.** Its site-admin gate and preview→confirm
    protocol are keyed on Tableau roles, not IdP claims, and remain in force independently;
    this policy is the org-controlled layer on top, not a replacement.
  - **`update-cloud-extract-refresh-task` argument shape is unverified** in the landscape
    note. This policy does not inspect arguments, so that does not affect enforcement — but
    a companion `confirm`-argument policy would depend on the exact shape.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - tableau
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package tableau.ingress.freeze_destructive_content

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group allowed to run destructive Tableau content operations.
# Replace "tableau-admins" with your IdP's group name at import time.
admin_group := "tableau-admins"

# --- Destructive tool matching ---
# The official tableau/tableau-mcp web server names tools kebab-case with no
# vendor prefix (delete-workbook, confirm-delete-workbook) and the gateway
# prepends the configured MCP server name (e.g. tableau-delete-workbook), so
# the distinctive verb+noun appears as a suffix. Each destructive tool has a
# separately-registered `confirm-` twin; both the base and the twin are listed
# explicitly so gating one can never leave the other open.
# Verify the exact names on your gateway with the dump-input debug technique.
destructive_suffixes := [
    "delete-datasource",
    "confirm-delete-datasource",
    "delete-workbook",
    "confirm-delete-workbook",
    "delete-extract-refresh-task",
    "confirm-delete-extract-refresh-task",
    "update-cloud-extract-refresh-task",
    "confirm-update-cloud-extract-refresh-task",
]

# Tool name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), so a
# request that somehow omits the resource block still cannot skip matching
# (red-team hardening: missing resource must not fail open).
# name_of coerces to a lowercased, whitespace-trimmed string. A missing OR
# non-string value (number, null, array, object) resolves to "" rather than
# leaving the rule undefined — an undefined name would make the suffix match
# undefined and skip matching entirely (fail-open). Leading/trailing whitespace
# and newlines are stripped with trim_space so a name padded with a trailing
# space or "\n" cannot slip past the endswith() suffix match (red-team
# hardening: whitespace must not evade the freeze).
name_of(key) := lower(trim_space(v)) if {
    v := object.get(object.get(input, key, {}), "name", "")
    is_string(v)
}

name_of(key) := "" if {
    v := object.get(object.get(input, key, {}), "name", "")
    not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

# Both names are checked independently. Reading the two fields into a set and
# iterating would re-couple them; keeping separate branches means a malformed
# (non-string) value in one field cannot suppress a real destructive suffix in
# the other. Underscores are normalized to hyphens so a snake_case-named variant
# (delete_workbook) is still gated — over-matching is the safe direction for a
# record-integrity freeze.
is_destructive_tool if {
    some suffix in destructive_suffixes
    endswith(replace(resource_name, "_", "-"), suffix)
}

is_destructive_tool if {
    some suffix in destructive_suffixes
    endswith(replace(payload_name, "_", "-"), suffix)
}

# --- Admin gate ---
# Reads the groups claim through object.get chains so a missing subject,
# missing claims, missing groups, or non-array groups value fails closed:
# the caller is simply not an admin and the destructive call is denied.
caller_is_admin if {
    claims := object.get(input.subject, "claims", {})
    groups := object.get(claims, "groups", [])
    # groups must be an array. Without this guard, `some group in groups`
    # would iterate the VALUES of an object-typed groups claim
    # (e.g. {"0": "tableau-admins"}) and grant the admin exemption — a
    # fail-OPEN path that contradicts the documented "non-array groups fails
    # closed" behavior. is_array makes a string, object, number, or null
    # groups value all resolve to "not admin" (red-team hardening).
    is_array(groups)
    some group in groups
    group == admin_group
}

# Allow any tool outside the destructive content family.
allow if {
    not is_destructive_tool
}

# Allow destructive tools only for members of the admin group.
allow if {
    is_destructive_tool
    caller_is_admin
}

reasons contains "This Tableau content operation is blocked because it is hard to reverse: deleted workbooks and data sources sit in the recycle bin for only a limited window before they are gone for good, and a silently stopped or rescheduled extract refresh leaves dashboards stale while they still look live. Ask a member of your Tableau admin group (placeholder: tableau-admins) to run it, or ask your InfoSec team to add you to that group if you believe you should have access." if {
    is_destructive_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
