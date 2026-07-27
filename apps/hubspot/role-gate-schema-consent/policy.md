---
name: HubSpot Role-Gate Schema and Consent
tags:
  - hubspot
  - role-gate-schema-consent
  - access-control
  - least-privilege
  - segregation-of-duties
  - consent
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # hubspot / role-gate-schema-consent

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `hubspot.ingress.role_gate_schema_consent`

  ## What it does

  Sits one privilege tier above [`hubspot/role-gate-writes`](../role-gate-writes/policy.md):
  ordinary `crm-writers` can create and edit CRM records, but two higher-blast-radius
  write classes are reserved for a dedicated admin group. Callers whose JWT `groups`
  claim contains `hubspot-admins` may invoke them; everyone else — including
  `crm-writers` — is denied. This preserves segregation of duties inside the write
  path. All other tools (reads and ordinary record writes) pass through untouched.

  The two gated classes are:

  - **Portal-schema mutations** — property-definition tools that alter the portal for
    *every* user: the `@hubspot/mcp-server` local beta's `hubspot-create-property`
    and `hubspot-update-property`, plus shinzo's per-domain `*_create_property`
    and `*_update_property` stems (`crm_create_property`, `crm_update_property`,
    `contacts_create_property`, …).
  - **Marketing-consent mutations** — the shinzo consent-state tools
    `communications_update_subscription_status`, `communications_update_preferences`,
    and `communications_subscribe_contact`, whose arguments carry a contact email/id
    plus a subscription id and directly mutate GDPR/CAN-SPAM consent records.

  The group check is **fail-closed** via `object.get` chains: if the caller has no
  `subject`, no `claims`, no `groups` claim, or a `groups` claim that is not a list of
  strings, the gated tools are denied. A missing claim never grants access.

  The irreversible unsubscribe (`communications_unsubscribe_contact`) is a **hard
  deny** handled by [`hubspot/freeze-destructive-ops`](../freeze-destructive-ops/policy.md),
  not here — this policy gates the remaining *reversible* consent mutations.

  ## Compliance alignment

  - **SOC 2 CC6.3** — role-based access, least privilege, and segregation of duties:
    schema and consent changes require an explicit `hubspot-admins` membership that
    sits above the ordinary `crm-writers` write role, so the caller who edits records
    is not the same role that can redefine the schema or flip consent.
  - **GDPR Art. 5(1)(b)** — purpose limitation: subscription/preference changes are
    consent-affecting processing, kept under an admin role rather than available to
    any agent write path.
  - **GDPR Art. 25; Art. 29** — data protection by default and processing only on the
    controller's authorization: consent-affecting and portal-schema mutations default
    to deny on the agent channel and are permitted only for an explicitly authorized
    group.

  ## Why ingress

  Property-definition and consent changes are writes with portal-wide, hard-to-reverse
  side effects — a new/edited property definition changes the schema for every HubSpot
  user, and a subscription-status or preference change mutates a compliance-relevant
  consent record. Denying at ingress means an unauthorized mutation never reaches
  HubSpot.

  ## Tool name matching

  The policy keys on the **tool name only**, matched case-insensitively by suffix
  against the lowercased `input.resource.name`. The DTwo gateway prefixes tool names
  with the configured server name (e.g. `hubspot-mcp-crm_create_property`), so suffix
  matching stays portable:

  - **Schema suffixes:** `hubspot-create-property`, `hubspot-update-property` (local
    beta), and `_create_property` / `_update_property` (the shinzo
    `*_create_property` / `*_update_property` wildcards). The `_update_property`
    suffix is a defensive addition — the landscape note verifies only
    `*_create_property` for shinzo (see Known limitations).
  - **Consent suffixes:** `communications_update_subscription_status`,
    `communications_update_preferences`, `communications_subscribe_contact`
    (the verified shinzo underscore forms), plus their kebab-case renderings for
    portability. The suffixes are specific enough that shinzo's read tool
    `communications_get_subscription_status` and the unsubscribe tool
    `communications_unsubscribe_contact` do **not** match.

  Verify the exact names your gateway sends with the dump-input debug technique before
  relying on this in production, and extend `schema_suffixes` / `consent_suffixes` if
  your server exposes additional schema or consent tools.

  ## Argument shape

  None assumed. The decision is made purely on the tool name; `input.payload.args` is
  never inspected, so the policy fails closed on the name alone even when `args` is
  empty or missing. The consent-tool argument shapes (contact email/id + subscription
  id) come from a community server and are **not** verified against a live `tools/list`
  — see Known limitations.

  The identity check reads `input.subject.claims.groups` via `object.get` chains and
  expects an array of strings (the common IdP shape). Group comparison is exact and
  case-sensitive.

  ## Examples

  ### Allowed (ordinary record write by a crm-writer — SoD preserved)

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

  `allow = true`, no reason. Record writes are gated by `role-gate-writes`, not here.

  ### Allowed (schema mutation by an admin)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-create-property", "type": "tool" },
      "subject": { "sub": "auth0|admin", "claims": { "groups": ["hubspot-admins"] } },
      "payload": { "name": "hubspot-create-property", "args": { "name": "custom_field" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (consent mutation by a crm-writer, not an admin)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "hubspot-shinzo-communications_update_subscription_status", "type": "tool" },
      "subject": { "sub": "auth0|writer", "claims": { "groups": ["crm-writers"] } },
      "payload": { "name": "hubspot-shinzo-communications_update_subscription_status", "args": { "contactEmail": "jane@example.com", "subscriptionId": "77" } }
    }
  }
  ```

  `allow = false`, `reason = "HubSpot marketing subscription and consent preferences are admin-owned because they carry GDPR/CAN-SPAM obligations. …"`.

  ## Composition

  Layer this on top of the CRM write path:

  - [`hubspot/role-gate-writes`](../role-gate-writes/policy.md) — the tier below:
    gates ordinary record creates/updates for `crm-writers`. This policy adds the
    schema/consent tier for `hubspot-admins` on top; attach both.
  - [`hubspot/freeze-destructive-ops`](../freeze-destructive-ops/policy.md) — hard-denies
    archive-class tools and the irreversible `communications_unsubscribe_contact`. That
    policy owns the unsubscribe; this one owns the reversible consent mutations.
  - [`hubspot/redact-pii`](../redact-pii/policy.md) — egress masking of contact PII.

  See the [`bundles/crm`](../../../bundles/crm/README.md) bundle for the curated set.

  ## Known limitations

  - **Group name is a placeholder.** Replace `hubspot-admins` (the `admin_group`
    constant in the Rego) with your IdP's real group name at import time. Group
    comparison is exact and case-sensitive.
  - **Groups claim must be an array of strings.** If your IdP emits `groups` as a
    single string or a namespaced custom claim (e.g. `https://acme.com/groups`),
    adjust `caller_groups` — until then, the gated tools are denied for every caller
    (fail-closed).
  - **Consent-tool argument shapes are unverified.** The consent tools come from the
    `@shinzolabs/hubspot-mcp` community server; their argument shapes (contact
    email/id + subscription id) are documented in the landscape note but **not**
    verified against a live `tools/list`. This policy does not depend on them — it
    decides on the tool name alone — but confirm the names with the dump-input
    technique before deploying.
  - **`_update_property` is unverified for shinzo.** The landscape note lists only
    `*_create_property` in the shinzo write inventory; a `crm_update_property` /
    `contacts_update_property` tool is not confirmed to exist there. The
    `_update_property` suffix is included defensively (the local beta proves
    property *update* is a real schema-mutation class, and shinzo's naming
    convention makes `*_update_property` the natural rendering). If your shinzo
    build never exposes such a tool the suffix is simply inert; confirm names with
    the dump-input technique before relying on it.
  - **Gated list is a blocklist.** New schema or consent tools added by a server
    upgrade are allowed (subject only to `role-gate-writes`) until added to
    `schema_suffixes` / `consent_suffixes`.
  - **Suffix over-match.** A generic ending like `_create_property` could match a
    non-HubSpot tool with the same suffix on a shared pipeline. Scope the pipeline to
    the HubSpot server, or narrow the suffixes, if that is a concern.

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
package hubspot.ingress.role_gate_schema_consent

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group allowed to change portal schema and consent state.
# This sits one tier above the crm-writers write role. Replace with your
# IdP's real group name at import time.
admin_group := "hubspot-admins"

# Lowercased tool name, fetched with object.get so a missing resource/name
# yields "" (a clean non-match) instead of a silent rule failure.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# --- Portal-schema tools ---
# Property definitions alter the portal schema for every user. Covers the
# @hubspot/mcp-server local beta (hubspot-create-property / -update-property)
# and shinzo's per-domain *_create_property stems (crm_create_property,
# contacts_create_property, ...). Suffix match stays portable across the
# gateway's configured server-name prefix.
schema_suffixes := [
    "hubspot-create-property",
    "hubspot-update-property",
    "_create_property",
    # Editing an existing property definition is a portal-schema mutation too
    # (arguably higher-impact than creating one). The local beta exposes both
    # create and update; shinzo's {domain}_{operation}_{resource} convention
    # renders the update form as *_update_property. The landscape note verifies
    # only *_create_property for shinzo, so this suffix is a defensive/portable
    # addition — see Known limitations.
    "_update_property",
]

is_schema_tool if {
    some suffix in schema_suffixes
    endswith(tool_name, suffix)
}

# --- Marketing-consent tools ---
# shinzo communications_* tools that mutate subscription/consent records
# (GDPR/CAN-SPAM). The irreversible unsubscribe is a hard deny owned by
# freeze-destructive-ops; this policy gates the remaining reversible consent
# mutations. Underscore forms are the verified shinzo naming; kebab variants
# are included for portability. The suffixes are specific enough that the read
# tool communications_get_subscription_status and communications_unsubscribe_contact
# do not match.
consent_suffixes := [
    "communications_update_subscription_status",
    "communications_update_preferences",
    "communications_subscribe_contact",
    "communications-update-subscription-status",
    "communications-update-preferences",
    "communications-subscribe-contact",
]

is_consent_tool if {
    some suffix in consent_suffixes
    endswith(tool_name, suffix)
}

is_gated_tool if is_schema_tool

is_gated_tool if is_consent_tool

# Fail-closed groups lookup: missing subject, missing claims, or a missing
# groups claim all resolve to [] and grant nothing.
caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

# Exact, case-sensitive group match. If caller_groups is not iterable
# (e.g. the IdP emitted a string), this rule never fires — fail closed.
caller_is_admin if {
    some group in caller_groups
    group == admin_group
}

# Everything that is not a gated schema/consent tool passes for every caller —
# ordinary crm-writers keep their record-editing access (role-gate-writes).
allow if {
    not is_gated_tool
}

# Gated tools pass only for members of the admin group.
allow if {
    is_gated_tool
    caller_is_admin
}

reasons contains "HubSpot property definitions are admin-owned: creating or editing them changes the portal schema for every user. Editing property definitions through the agent channel is limited to members of the 'hubspot-admins' group. Manage properties in HubSpot Settings > Properties, or ask an administrator to add you to that group if you believe this is a false positive." if {
    is_schema_tool
    not caller_is_admin
}

reasons contains "HubSpot marketing subscription and consent preferences are admin-owned because they carry GDPR/CAN-SPAM obligations. Changing them through the agent channel is limited to members of the 'hubspot-admins' group. Manage subscription types in HubSpot Settings > Marketing > Email > Subscription Types, or ask an administrator to add you to that group if you believe this is a false positive." if {
    is_consent_tool
    not caller_is_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
