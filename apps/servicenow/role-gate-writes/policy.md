---
name: "ServiceNow: Role-Gated Writes (Read-Only Default)"
tags:
  - servicenow
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # servicenow / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — reads pass for everyone, verified writes require the writer group, everything
  else fails closed
  **Package:** `servicenow.ingress.role_gate_writes`

  ## What it does

  Makes ServiceNow read-only by default on the MCP path. Read tools pass for every caller. Every
  verified write-class tool — incident, change, agile, catalog, knowledge, platform-code, and
  changeset mutations — is denied unless the caller's IdP `groups` claim contains the placeholder
  group `servicenow-writers`. Any tool that is neither a recognized read nor a verified write (an
  unknown or renamed upstream tool, or a call with no tool name at all) is **denied by default**, so
  an *unrecognized* write cannot slip through.

  One caveat to that guarantee: reads are recognized by a `list_`/`get_` verb heuristic, not an
  enumerated read allowlist. A write whose tool name is admin-renamed to **start** with a read verb
  (possible on the instance-defined official server — e.g. a subflow named `get_and_close_incident`)
  is classified as a read and allowed. This residual is documented under Known limitations; run the
  companion `default-deny-unknown-tools` (PF-28) policy alongside this one so such drift is caught
  and audited rather than silently allowed.

  Read tools that pass (matched on the echelon-ai-labs / michaelbuckner `verb_noun` vocabulary):

  - any name whose tool segment starts with `list_` (e.g. `list_incidents`, `list_users`,
    `list_change_requests`, `list_articles`, `list_workflows`, `list_changesets`) or `get_`
    (e.g. `get_user`, `get_record`, `get_change_request_details`, `get_workflow`,
    `get_script_include`, `get_article`, `get_catalog_item`)
  - the exact read tools `search_records`, `perform_query`, and `natural_language_search`

  The check runs at ingress, before the call reaches the ServiceNow MCP server, so a denied write
  never executes and has no side effects on the instance.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: ServiceNow records
    (incidents, changes, KB, catalog, platform code) cannot be mutated over the agent channel
    without an explicit role grant. **CC6.3** — supports role-based access, least privilege, and
    separation of duties: write capability is tied to a live IdP group, and removing the group in
    the IdP removes agent write access on the next call.
  - **HIPAA §164.308(a)(4)** — supports information access management for ServiceNow tenants whose
    incident/HRSD/CSM records hold ePHI: write authorization is role-scoped. **§164.312(a)(1)** —
    supports technical access control with per-call identity taken from the caller's JWT.
    **§164.502(b) / §164.514(d)** — supports minimum-necessary and role-based limits by keeping the
    default posture read-only.
  - **PCI DSS 7.2.1 / 7.2.2** — supports a least-privilege access model: agent write access to
    ServiceNow records adjacent to cardholder data is limited to the roles that need it.
    **7.2.5** — supports application/system-account least privilege by narrowing what the agent's
    OAuth grant can actually change.
  - **GDPR Art. 25** — supports data protection by design/default on the agent channel: the default
    posture is read-only. **Art. 29 / Art. 32(4)** — supports processing only on the controller's
    documented instructions: unauthorized principals cannot alter personal data in ServiceNow
    through the agent. **Art. 5(1)(b)** — supports purpose limitation by gating writes to a
    controlled role.
  - **SOX ITGC (access to programs and data)** — supports least-privilege access where ServiceNow
    holds financially relevant records or change tickets: mutations require membership in a
    controlled group. **SoD (COSO Principle 10)** — supports separation of the initiate and approve
    roles by keeping ordinary agent writes behind a role grant (approval-class tools are gated
    separately — see Composition).

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `servicenow-mcp-create_incident`), and the prefix is not standardized — so matching is
  case-insensitive and portable:

  - **Reads** are matched on the `verb_noun` snake_case convention shared by the two big community
    servers (echelon-ai-labs and michaelbuckner). A `list_`/`get_` verb is recognized only at the
    start of the name or immediately after a `-` server-prefix delimiter (the delimiter the gateway
    actually uses, e.g. `servicenow-mcp-list_incidents`), plus the three exact read tools
    `search_records`, `perform_query`, and `natural_language_search` — which are matched at the same
    boundary (the bare name, or right after a `-` delimiter), **not** by a bare suffix. That anchoring
    matters: a bare suffix match would treat any instance-defined tool whose name merely *ends* with
    one of the three (e.g. an admin-named write subflow `incident_close_and_search_records`) as a
    read and allow it for everyone — a red-team finding, now closed. A `_`-delimited match
    (`_get_`/`_list_` *inside* a name) is intentionally **not** treated as a read verb: in the
    verb_noun vocabulary an underscore is part of the tool name, so an underscore-infix match cannot
    be told apart from a write subflow such as `incident_get_and_resolve` — matching those as reads
    let writes slip through (red-team finding, now closed). One consequence, which now holds
    uniformly for both the `list_`/`get_` verbs and the three exact read tools: if your gateway joins
    the server-name prefix with `_` instead of `-`, read tools will not be recognized and will fail
    closed (denied) — configure a `-` prefix, or add the reads explicitly.
  - **Writes** are matched by exact suffix (`endswith`) so any gateway server-name prefix still
    matches. The verified write set is:
    - **Incident / ticket:** `create_incident`, `update_incident`, `add_comment`, `add_work_notes`,
      `resolve_incident`
    - **Change:** `create_change_request`, `update_change_request`, `add_change_task`
    - **Agile:** `create_story`, `update_story`, `create_epic`, `update_epic`, `create_scrum_task`,
      `update_scrum_task`, `create_project`, `update_project`
    - **Catalog:** `create_catalog_category`, `update_catalog_category`, `move_catalog_items`,
      `update_catalog_item`, `create_catalog_item_variable`, `update_catalog_item_variable`,
      `create_category`
    - **Knowledge:** `create_knowledge_base`, `create_article`, `update_article`, `publish_article`
    - **Free-text write / code:** `natural_language_update`, `update_script`
    - **Platform code:** `create_workflow`, `update_workflow`, `delete_workflow`,
      `create_script_include`, `update_script_include`, `delete_script_include`, `create_ui_policy`,
      `create_ui_policy_action`
    - **Changeset / update-set:** `create_changeset`, `update_changeset`, `commit_changeset`,
      `publish_changeset`, `add_file_to_changeset`

  Two entries in the write set deserve a call-out because they perform writes the policy cannot
  inspect field-by-field:

  - **`natural_language_update`** (michaelbuckner server) performs a write from free-text
    instructions with no structured, inspectable field diff — the agent describes a change in
    prose and the server executes it.
  - **`update_script`** edits server-side script that then runs inside the instance.

  Both stay inside the gated write set (a writer may call them). Stricter tenants should remove
  `natural_language_update` and `update_script` from even the writer grant — carve them out into a
  separate, more tightly gated policy, or move them to a human-only deny.

  Verify the exact names your gateway sends with the dump-input debug technique before relying on
  this in production. If your ServiceNow server exposes a write tool whose suffix is not in the list
  above, it will be denied for everyone (fail closed) until you add it — see Known limitations.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`) and the caller's identity
  (`input.subject.claims.groups`). Tool arguments are not inspected, so the policy cannot be
  bypassed by unusual argument keys, nesting, batched payloads, or encodings — and it works
  identically whether or not a tool's argument schema is documented.

  ## Identity

  Group membership is read fail-closed via
  `object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])` with an
  `is_array` guard: a missing subject, missing claims, a missing `groups` claim, or a `groups`
  claim that is not an array all mean "not a writer", and every write is denied. Reads are
  unaffected by identity.

  ## Examples

  ### Allowed — read tool, no identity required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-list_incidents", "type": "tool" },
      "payload": { "name": "servicenow-mcp-list_incidents", "args": { "limit": 20 } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — write tool, caller in the writer group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-create_incident", "type": "tool" },
      "subject": { "sub": "auth0|alice", "claims": { "groups": ["servicenow-writers"] } },
      "payload": {
        "name": "servicenow-mcp-create_incident",
        "args": { "short_description": "Printer down on 3rd floor" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — write tool, caller not in the writer group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-create_incident", "type": "tool" },
      "subject": { "sub": "auth0|bob", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "servicenow-mcp-create_incident",
        "args": { "short_description": "Printer down on 3rd floor" }
      }
    }
  }
  ```

  `allow = false`, `reason = "ServiceNow write tools are restricted to members of the 'servicenow-writers' group ..."`.

  ## Composition

  This policy is the ServiceNow least-privilege baseline; it gates *who* may write, not *what* they
  may write, and does not cover the higher-blast-radius surfaces. Pair it with:

  - **`apps/servicenow/default-deny-unknown-tools`** (PF-28) — because ServiceNow's official server
    publishes instance-defined tool names, run the allowlist/drift policy alongside this one so new
    or renamed upstream tools are caught and audited, not silently denied without an operator seeing
    the drift.
  - **`apps/servicenow/require-human-approval-changes`** (PF-15) — `approve_change`, `reject_change`,
    and `submit_change_for_approval` are deliberately **not** in this policy's write set; they are
    unconditionally human-only and are gated by that companion policy.
  - A **freeze-identity-plane** policy (PF-13) for `create_user`, `update_user`, `create_group`,
    `update_group`, `add_group_members`, `remove_group_members` — ServiceNow group membership drives
    ACLs, so these privilege-escalation primitives are also intentionally out of this policy's write
    set and belong behind a stricter identity-admin gate.
  - An egress PII/PHI redaction policy on `list_incidents` / `get_record` / `search_records` /
    `list_users` responses, since this policy leaves the read path open.

  ## Known limitations

  - **Group names are placeholders** — replace `servicenow-writers` with your IdP's real group name
    at import time. The policy expects `groups` to be an array claim in the caller's JWT; if your
    IdP emits roles under a different or namespaced claim (e.g. `https://acme.com/groups`), update
    `writer_group` and `caller_groups` in `policy.md`.
  - **Fail-closed on unknown tools (by design).** Anything that is not a recognized read or a
    verified-suffix write is denied for everyone, including writers. That is the intended posture —
    it prevents an unclassified write from slipping through — but it also means legitimate write
    tools outside the verified set are blocked until an operator adds them. Known examples not in
    the write set: `create_story_dependency` / `delete_story_dependency` (agile dependency writes),
    and the identity/approval tools covered by the companion policies above. Add any tool your
    tenant legitimately uses to `write_suffixes` (for the writer grant) or the read helpers, and run
    the companion `default-deny-unknown-tools` policy so the drift is surfaced rather than silent.
  - **A write whose name starts with a read verb is allowed (residual).** Reads are recognized by a
    `list_`/`get_` verb heuristic, not an enumerated allowlist, so a tool whose name *starts* with
    `list_`/`get_` (at the start of the name, or right after the `-` server prefix) is treated as a
    read for everyone. On the community servers no write is named this way, but the official server's
    tool names are admin-defined, so a write subflow could be published as `get_and_close_incident`,
    `list_and_purge_records`, etc. and would pass the read path. This cannot be closed from inside a
    single least-privilege policy without a full write vocabulary; the mitigation is the companion
    `default-deny-unknown-tools` (PF-28) policy, which allowlists audited tool names and alerts on
    drift. (Two related but distinct misclassifications are closed: the `_get_`/`_list_` *infix*
    case — e.g. `incident_get_and_resolve` — because underscore-infix matches are not treated as read
    verbs; and the *ends-with-a-read-suffix* case — e.g. `incident_close_and_search_records` — because
    the three exact reads are matched only at the start of the name or after a `-` delimiter, not by a
    bare suffix.)
  - **Official-server tool names are instance-defined.** ServiceNow's native MCP Server derives tool
    names from the skills/subflows/APIs an admin publishes, with no canonical vocabulary; this
    policy's read/write matching is built for the echelon-ai-labs and michaelbuckner `verb_noun`
    community vocabulary. For the official server you must supply a per-tenant tool inventory and map
    each name into the read helpers or `write_suffixes`.
  - **`natural_language_update` and `update_script` are inside the writer grant.** They perform an
    uninspectable free-text write and a server-side code edit respectively; a writer may call them.
    Stricter tenants should remove them from even the writer grant (see Tool name matching).
  - **Reads are open to everyone.** Read tools reach any table the instance credential can read
    (`sys_user`, HRSD case tables, `cmdb_ci`, custom PII tables via `perform_query` /
    `search_records` / `get_record`). This policy does not scope reads by table or redact
    responses — pair it with a read-fence and/or egress redaction if your instance holds regulated
    data.
  - **A server named with a write suffix** (e.g. an MCP server configured so its name ends in
    `...create_incident`) is a pathological case that would make matching over-broad; keep the
    configured server name distinct from the tool suffixes, or verify with the dump-input technique.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on
  > the MCP path only**. No policy or bundle makes an organization compliant with any framework;
  > web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate
  > against your own compliance program before relying on it.
direction: ingress
apps:
  - servicenow
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package servicenow.ingress.role_gate_writes

# Deny-by-default: reads are explicitly allowed below, verified writes require
# the writer group, and anything unrecognized (unknown/renamed tool, missing
# name) fails closed so a write can never slip through unclassified.
default allow := false

# Placeholder IdP group permitted to perform ServiceNow writes.
# Replace "servicenow-writers" with your IdP's group name at import time.
writer_group := "servicenow-writers"

# Lowercased tool name. The gateway prefixes tool names with the configured
# MCP server name (e.g. `servicenow-mcp-create_incident`), so all matching
# below is case-insensitive and suffix/segment based to stay portable.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim
# that is not an array all yield "not a writer" — writes then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

caller_is_writer if {
    is_array(caller_groups)
    some group in caller_groups
    group == writer_group
}

# --- Read-tool detection (echelon-ai-labs / michaelbuckner verb_noun vocab) ---

# `list_` / `get_` recognized as a read verb: at the start of the name
# (unprefixed) or right after the gateway's `-` server-name prefix delimiter
# (e.g. `servicenow-mcp-list_incidents`).
#
# We deliberately do NOT treat a `_`-delimited match (`_get_` / `_list_`) as a
# read verb. In the verb_noun snake_case vocabulary an underscore is *within* a
# tool name, so an underscore-infix match cannot be distinguished from a genuine
# read verb — e.g. an instance-defined write subflow named
# `incident_get_and_resolve` or `case_list_and_close` embeds `_get_`/`_list_`
# yet is a write. Matching those as reads let writes slip through unclassified
# (red-team finding). Only the hyphen boundary — the real prefix delimiter the
# gateway uses — and the start of the name are trusted. See Known limitations
# for the residual (a write whose name *starts* with a read verb) and the
# `_`-delimited-prefix caveat.
read_prefixes := ["list_", "get_"]

has_read_prefix if {
    some prefix in read_prefixes
    startswith(tool_name, prefix)
}

has_read_prefix if {
    some prefix in read_prefixes
    contains(tool_name, concat("", ["-", prefix]))
}

# Exact read tools that carry no list_/get_ prefix.
read_suffixes := ["search_records", "perform_query", "natural_language_search"]

# Recognized at a name boundary only — the bare name (unprefixed) or right after
# the gateway's `-` server-name prefix delimiter — mirroring has_read_prefix. We
# deliberately do NOT use a bare `endswith` here: an unanchored `endswith` would
# treat any instance-defined tool whose name merely *ends* with one of these
# (e.g. a write subflow `incident_close_and_search_records`, or `search_records`
# reached under a `_`-joined server prefix) as a read and allow it for everyone
# (red-team finding, now closed). Anchoring to the start or the `-` boundary
# keeps the three reads recognized under the real `-` prefix while failing such
# underscore-infix look-alikes closed — consistent with the `_`-prefix caveat
# documented for the list_/get_ verbs.
has_read_suffix if {
    some suffix in read_suffixes
    tool_name == suffix
}

has_read_suffix if {
    some suffix in read_suffixes
    endswith(tool_name, concat("", ["-", suffix]))
}

is_read_tool if has_read_prefix
is_read_tool if has_read_suffix

# --- Write-tool detection (verified suffixes) ---
# Matched by suffix so any gateway server-name prefix still matches. Grouped by
# ServiceNow surface; see the description for the per-suffix rationale.
write_suffixes := [
    # Incident / ticket
    "create_incident",
    "update_incident",
    "add_comment",
    "add_work_notes",
    "resolve_incident",
    # Change
    "create_change_request",
    "update_change_request",
    "add_change_task",
    # Agile
    "create_story",
    "update_story",
    "create_epic",
    "update_epic",
    "create_scrum_task",
    "update_scrum_task",
    "create_project",
    "update_project",
    # Catalog
    "create_catalog_category",
    "update_catalog_category",
    "move_catalog_items",
    "update_catalog_item",
    "create_catalog_item_variable",
    "update_catalog_item_variable",
    "create_category",
    # Knowledge
    "create_knowledge_base",
    "create_article",
    "update_article",
    "publish_article",
    # Free-text write / server-side code
    "natural_language_update",
    "update_script",
    # Platform code
    "create_workflow",
    "update_workflow",
    "delete_workflow",
    "create_script_include",
    "update_script_include",
    "delete_script_include",
    "create_ui_policy",
    "create_ui_policy_action",
    # Changeset / update-set
    "create_changeset",
    "update_changeset",
    "commit_changeset",
    "publish_changeset",
    "add_file_to_changeset",
]

is_write_tool if {
    some suffix in write_suffixes
    endswith(tool_name, suffix)
}

# --- Decision ---

# Reads pass for everyone. The `not is_write_tool` guard keeps the stricter
# class winning if a name were ever both (none in the current sets).
allow if {
    is_read_tool
    not is_write_tool
}

# Verified writes pass only for members of the writer group.
allow if {
    is_write_tool
    caller_is_writer
}

# Denied write by a non-writer: name the required group and point to the gateway
# admin who maps IdP groups.
reasons contains msg if {
    is_write_tool
    not caller_is_writer
    msg := sprintf("ServiceNow write tools are restricted to members of the '%s' group — this account has read-only ServiceNow access through the gateway. Ask your gateway admin to map your IdP group to '%s', or hand this write to a teammate with ServiceNow write access. If this tool is actually read-only, contact your gateway admin to update the policy.", [writer_group, writer_group])
}

# Fail-closed deny: the tool is neither a recognized read nor a verified write
# (unknown/renamed upstream tool, or a call with no tool name). Denied for
# everyone, including writers, until an operator classifies it.
reasons contains msg if {
    not is_read_tool
    not is_write_tool
    msg := sprintf("This ServiceNow tool (%q) is not on the gateway's read allowlist or verified write list, so it is denied by default (fail closed). ServiceNow tool names can be instance-defined; ask your gateway admin to classify this tool — add it to the read set, or to the gated write set for the 'servicenow-writers' group — in the policy.", [tool_name])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
