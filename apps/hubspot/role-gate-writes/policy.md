---
name: HubSpot Role-Gate Writes
tags:
  - hubspot
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # hubspot / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.role_gate_writes`

  ## What it does

  Gates every HubSpot write tool behind an IdP group: callers whose JWT
  `groups` claim contains `crm-writers` may create and update CRM records;
  everyone else gets a read-only HubSpot posture through the agent channel.
  All read tools (search, list, get, batch-read) pass for every caller.

  The group check is **fail-closed**: if the caller has no `subject.claims`,
  no `groups` claim, or a `groups` claim that is not a list of strings, write
  tools are denied. A missing claim never grants write access.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.3** — logical access security and role-based least
    privilege: CRM mutations through the agent channel require an explicit
    IdP group membership; the default posture is read-only.
  - **HIPAA §164.308(a)(4); §164.312(a)(1)** — information access management
    and access control on the MCP path, for portals whose contact records
    carry health-related data: writes are authorized per caller identity.
  - **PCI DSS 7.2.1; 7.2.2** — least-privilege access model: agent-channel
    users are assigned the minimum access (read) unless their role requires
    write.
  - **GDPR Art. 25; Art. 29** — data protection by default on the agent
    channel, and processing of personal data only by persons acting under the
    controller's authorization.

  ## Why ingress

  Writes have permanent side effects — a wrong lifecycle-stage or deal-stage
  change can fire HubSpot workflow automation (real emails to customers), and
  HubSpot skips custom validation rules on agent-created records. Denying at
  ingress means an unauthorized write never reaches HubSpot.

  ## Tool name matching

  The policy keys on the **tool name only**, matched case-insensitively by
  suffix against the write vocabulary of all three verified HubSpot MCP name
  families (the DTwo gateway prefixes tool names with the configured server
  name, so suffix matching stays portable):

  - **Remote server / Claude connector** (snake_case): `manage_crm_objects`
    (the single create/update tool for records and activities) and
    `submit_feedback`. Kebab-case variants (`-manage-crm-objects`,
    `-submit-feedback`) are also matched, since earlier deployments observed
    the kebab form.
  - **`@hubspot/mcp-server` local beta** (kebab-case, 7 write tools):
    `hubspot-batch-create-objects`, `hubspot-batch-update-objects`,
    `hubspot-batch-create-associations`, `hubspot-create-engagement`,
    `hubspot-update-engagement`, `hubspot-create-property`,
    `hubspot-update-property`.
  - **shinzo-labs community server** (`{domain}_{operation}`): `crm_create_object`,
    `crm_update_object`, `crm_batch_create_objects`, `crm_batch_update_objects`,
    per-type contact/company/lead create/update/batch variants,
    `crm_create_association`, `calls_/emails_/meetings_/notes_/tasks_`
    create/update/batch writes, `products_create/update/batch_*`,
    `*_create_property` (wildcard suffix), `communications_update_preferences`,
    `communications_update_subscription_status`,
    `communications_subscribe_contact`.

  Anything not on the write list — including every read tool of all four
  known server families — is allowed for all callers. Verify the exact tool
  names your gateway sends with the dump-input debug technique before
  relying on this in production, and extend `write_suffixes` if your server
  exposes additional mutating tools.

  ## Argument shape

  None assumed. The remote server's `manage_crm_objects` argument shape is
  only partially published by HubSpot, so this policy deliberately decides on
  the tool name alone and never inspects `input.payload.args`.

  The identity check reads `input.subject.claims.groups` via `object.get`
  chains and expects an array of strings (the common IdP shape for a groups
  claim). Group comparison is exact (case-sensitive).

  ## Examples

  ### Allowed (read tool, any caller)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-remote-search_crm_objects", "type": "tool" },
      "subject": { "sub": "auth0|reader", "claims": { "groups": ["support"] } },
      "payload": { "name": "hubspot-remote-search_crm_objects", "args": { "objectType": "contacts" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed (write tool, group member)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-remote-manage_crm_objects", "type": "tool" },
      "subject": { "sub": "auth0|writer", "claims": { "groups": ["crm-writers"] } },
      "payload": { "name": "hubspot-remote-manage_crm_objects", "args": { "objectType": "contacts" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (write tool, non-member)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-remote-manage_crm_objects", "type": "tool" },
      "subject": { "sub": "auth0|reader", "claims": { "groups": ["support"] } },
      "payload": { "name": "hubspot-remote-manage_crm_objects", "args": { "objectType": "contacts" } }
    }
  }
  ```

  `allow = false`, `reason = "HubSpot write tools are limited to members of the 'crm-writers' group — your HubSpot access through the agent channel is read-only. If you believe this is a false positive, ask your administrator to add you to the writers group."`.

  ## Composition

  This policy is the group-conditional successor to the all-or-nothing
  [`hubspot/read-only`](../read-only/policy.md) policy: attach **one or the
  other**, not both (read-only would deny writes even for `crm-writers`
  members). It also widens tool coverage beyond read-only's single
  `-manage-crm-objects` match to all three verified name families.

  Useful companions:

  - [`hubspot/redact-pii`](../redact-pii/policy.md) — egress masking of
    contact PII on search/read responses.
  - A destructive-suffix deny (`*_archive`, `unsubscribe_contact`) for the
    shinzo community server, whose archive tools this policy does not treat
    as gated writes — they should be blocked outright, not group-gated.
  - [`hubspot/protect-lifecycle-stage`](../protect-lifecycle-stage/policy.md)
    and [`hubspot/block-deal-closure`](../block-deal-closure/policy.md) to
    constrain *what* the writers group can change.

  See the [`bundles/crm`](../../../bundles/crm/README.md) bundle for the
  curated set.

  ## Known limitations

  - **Group name is a placeholder.** Replace `crm-writers` (the
    `writers_group` constant in the Rego) with your IdP's real group name at
    import time. Group comparison is exact and case-sensitive.
  - **Groups claim must be an array of strings.** If your IdP emits `groups`
    as a single string or a namespaced custom claim (e.g.
    `https://acme.com/groups`), adjust `caller_groups` — until then, all
    writes are denied for every caller (fail-closed).
  - **Name-only decision.** `manage_crm_objects` handles both creates and
    updates across every object type; because its detailed argument shape is
    only partially verified, this policy cannot distinguish create vs update
    or gate specific object types. Compose with argument-level policies for
    finer control.
  - **Suffix over-match.** Generic suffixes like `notes_create` or
    `tasks_update` could match a non-HubSpot tool with the same ending on a
    shared pipeline. Scope the pipeline to the HubSpot server, or narrow the
    suffixes, if that is a concern.
  - **Write list is a blocklist.** New mutating tools added by a server
    upgrade are allowed until added to `write_suffixes`. The shinzo
    destructive tools (`*_archive`, `communications_unsubscribe_contact`)
    are intentionally not listed — block them with a dedicated deny policy.
  - **baryhuang community server not covered.** Its `hubspot_create_contact`
    / `hubspot_create_company` writes are not in the verified suffix list;
    add them if you run that server.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - hubspot
industries: []
bundles:
  - crm
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package hubspot.ingress.role_gate_writes

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group allowed to call HubSpot write tools.
# Replace with your IdP's real group name at import time.
writers_group := "crm-writers"

# Write-tool suffixes across the three verified HubSpot MCP name families.
# The gateway prefixes tool names with the configured server name, so we
# match case-insensitively by suffix to stay portable. Verify exact names
# with the dump-input debug technique before deploying.
write_suffixes := [
    # --- Remote server / Claude connector (snake_case; kebab variants kept
    #     for deployments that observed kebab-case naming) ---
    "manage_crm_objects",
    "manage-crm-objects",
    "submit_feedback",
    "submit-feedback",

    # --- @hubspot/mcp-server local beta (kebab-case, 7 write tools) ---
    "hubspot-batch-create-objects",
    "hubspot-batch-update-objects",
    "hubspot-batch-create-associations",
    "hubspot-create-engagement",
    "hubspot-update-engagement",
    "hubspot-create-property",
    "hubspot-update-property",

    # --- shinzo-labs community server ({domain}_{operation}) ---
    "crm_create_object",
    "crm_update_object",
    "crm_batch_create_objects",
    "crm_batch_update_objects",
    "crm_create_contact",
    "crm_update_contact",
    "crm_batch_create_contacts",
    "crm_batch_update_contacts",
    "crm_create_company",
    "crm_update_company",
    "crm_batch_create_companies",
    "crm_batch_update_companies",
    "crm_create_lead",
    "crm_update_lead",
    "crm_batch_create_leads",
    "crm_batch_update_leads",
    "crm_create_association",
    "calls_create",
    "calls_update",
    "calls_batch_create",
    "calls_batch_update",
    "emails_create",
    "emails_update",
    "emails_batch_create",
    "emails_batch_update",
    "meetings_create",
    "meetings_update",
    "meetings_batch_create",
    "meetings_batch_update",
    "notes_create",
    "notes_update",
    "notes_batch_create",
    "notes_batch_update",
    "tasks_create",
    "tasks_update",
    "tasks_batch_create",
    "tasks_batch_update",
    "products_create",
    "products_update",
    "products_batch_create",
    "products_batch_update",
    # shinzo per-domain property creation (*_create_property wildcard)
    "_create_property",
    # consent-state mutations (GDPR/CAN-SPAM relevant)
    "communications_update_preferences",
    "communications_update_subscription_status",
    "communications_subscribe_contact",
]

is_hubspot_write_tool if {
    name := lower(input.resource.name)
    some suffix in write_suffixes
    endswith(name, suffix)
}

# Fail-closed groups lookup: missing subject, missing claims, or a missing
# groups claim all resolve to [] and grant nothing.
caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

# Exact, case-sensitive group match. If caller_groups is not iterable
# (e.g. the IdP emitted a string), this rule never fires — fail closed.
caller_is_writer if {
    some group in caller_groups
    group == writers_group
}

# Read tools (anything not on the write list) pass for every caller.
allow if {
    not is_hubspot_write_tool
}

# Write tools pass only for members of the writers group.
allow if {
    is_hubspot_write_tool
    caller_is_writer
}

reason := "HubSpot write tools are limited to members of the 'crm-writers' group — your HubSpot access through the agent channel is read-only. If you believe this is a false positive, ask your administrator to add you to the writers group." if not allow
```
