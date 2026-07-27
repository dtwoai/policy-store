---
name: Freeze ServiceNow Identity Plane
tags:
  - servicenow
  - freeze-identity-plane
  - ingress
  - identity
  - groups
  - soc2
  - iso27001-nist
publishedAt: 2026-07-12
description: |
  # servicenow / freeze-identity-plane

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny identity-and-access mutations, allow everything else
  **Package:** `servicenow.ingress.freeze_identity_plane`

  ## What it does

  Freezes the identity-and-access mutation surface of the ServiceNow MCP server.
  The policy denies, by tool-name suffix:

  - `*create_user` / `*update_user` — user record creation and property changes
  - `*create_group` / `*update_group` — group creation and property changes
  - `*add_group_members` / `*remove_group_members` — group membership changes

  All other tools pass through unchanged. The denied tools are exempt **only** for
  callers whose IdP `groups` claim contains the placeholder group `identity-admins`,
  read fail-closed from `input.subject.claims.groups` — a missing subject, missing
  claims, or a missing/empty/non-array `groups` claim means no exemption and the
  mutation is denied.

  The escalation risk is concrete in ServiceNow. Group membership drives ACL
  evaluation across the entire platform: a role granted to a group flows to every
  member, so `add_group_members` is a privilege-escalation primitive — a
  prompt-injected agent that can call it can grant itself (or its caller)
  admin-equivalent reach without touching a single role record. `create_user` /
  `update_user` can mint or re-home an account; `create_group` / `update_group`
  can stand up or repurpose an access-bearing group. Freezing these at ingress
  means the mutation never reaches the instance.

  Read-side identity tools stay open by design — `get_user`, `list_users`,
  `list_groups` are **not** matched here. Recon is unaffected so agents operate
  without spurious denials; PII exposure on those read paths is the job of the
  companion `fence-sensitive-tables` / PII-redaction policies, not this one.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected information
    assets: the identity- and group-mutation tools are identity-gated at the MCP
    boundary, so a non-privileged caller (or an injected agent acting as one)
    cannot provision users or change group membership on the agent channel.
    **SOC 2 CC6.3** — supports role-based access and least privilege: the ability
    to mutate the ServiceNow identity plane is tied to membership in the
    placeholder `identity-admins` IdP group, and removing that group in the IdP
    removes agent access on the next call.
  - **ISO 27001 A.8.2 / NIST 800-53 AC-6(9), AC-6(10)** — supports privileged
    access restriction: user provisioning and group-membership changes are
    privileged access-management operations, and this policy prevents
    non-privileged callers (and injected agents acting as them) from executing
    those privileged functions on the agent channel. This is the ServiceNow
    instance of policy family PF-13; the coverage matrix maps A.8.2 / AC-6(9)(10)
    to PF-13 as an enforceable control on the MCP path, and lists AC-6 → PF-13
    again under the public-sector (FedRAMP/CJIS) baseline.

  No HIPAA / PCI DSS / GDPR-CCPA / SOX bundle tag is claimed: the coverage matrix
  cites PF-13 under the SOC 2 CC6.x logical-access criteria and the ISO 27001 /
  NIST rows (and the public-sector baseline), so this policy supports alignment
  with those controls and does not assert coverage under the other frameworks.

  ## Tool name matching

  The policy matches by suffix on the lowercased, whitespace-trimmed
  `input.resource.name`:

  `create_user`, `update_user`, `create_group`, `update_group`,
  `add_group_members`, `remove_group_members`

  These are the `verb_noun` snake_case tool names from the
  `echelon-ai-labs/servicenow-mcp` server — the de facto community vocabulary that
  most wrappers copy (michaelbuckner uses the same `create_*`/`update_*` shapes).
  The DTwo gateway prefixes tool names with the configured MCP server name, and
  that prefix is not standardized. Because each suffix is the trailing tool token
  itself (no leading separator), `endswith` matches whether the gateway joins the
  prefix with a hyphen (`servicenow-create_user`), an underscore, a dot, or forwards
  the bare name (`create_user`) — the suffix sits at the end of the string in every
  case. Matching is case-insensitive. Verify the exact names your gateway sends
  with the dump-input debug technique before relying on this in production.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`) and the caller's
  identity (`input.subject.claims.groups`). Tool arguments are **not** inspected,
  so no argument-shape drift can bypass the deny. Identity is read with
  `object.get` chains: a missing `subject`, missing `claims`, or missing `groups`
  claim yields an empty group list, which fails closed — the caller is not exempt
  and the mutation is denied. The `groups` claim must be a JSON array of strings; a
  non-array shape (string, object, number) fails closed.

  ## Examples

  ### Allowed — read tool, no identity required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-list_users", "type": "tool" },
      "payload": { "name": "servicenow-list_users", "args": { "limit": 20 } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — membership mutation by a non-admin caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-add_group_members", "type": "tool" },
      "subject": { "sub": "auth0|agent-user", "claims": { "groups": ["service_desk"] } },
      "payload": {
        "name": "servicenow-add_group_members",
        "args": { "group": "admins", "members": ["agent-user"] }
      }
    }
  }
  ```

  `allow = false`, `reason = "ServiceNow identity and group changes are frozen on the agent path (...)"`.

  ### Allowed — same mutation by an `identity-admins` member

  The same call with `"groups": ["identity-admins"]` in `input.subject.claims`
  returns `allow = true`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - **`default-deny-unknown-tools`** (PF-28, already in this app dir) — mandatory
    for ServiceNow because the official MCP Server Console publishes
    instance-defined tool names (Subflows/Actions/Scripted REST APIs) that could
    perform identity mutations under names this suffix list cannot anticipate. The
    allowlist catches drift; this policy freezes the known community tools.
  - **A PF-22 escape-hatch deny** — michaelbuckner's `perform_query` /
    `natural_language_update` and any generic Table-API tool can write `sys_user` /
    `sys_user_grmember` directly, bypassing every per-tool rule here. Without it,
    this policy's guarantee holds only for the named tools.
  - **`role-gate-writes`** (PF-12) — the baseline write gate for everything else on
    the ServiceNow surface.
  - **`fence-sensitive-tables` / PII-redaction egress** — owns read-side identity
    exposure (`get_user`, `list_users`), which this policy deliberately leaves open.

  ## Known limitations

  - **Generic-query and NL-write tools bypass this policy.** michaelbuckner's
    `perform_query`, `get_record`, `search_records`, and especially
    `natural_language_update` take a table name (or free text) and reach `sys_user`
    / `sys_user_group` / `sys_user_grmember` without matching any suffix here.
    Deploy a PF-22 escape-hatch deny and the PF-28 allowlist alongside this one.
  - **Official-server tool names are instance-defined.** The ServiceNow MCP Server
    Console derives tool names from the admin-published skill/subflow/API name, so
    an identity-mutating Subflow could carry any name. Suffix matching cannot cover
    that surface — rely on PF-28 default-deny-unknown-tools for the official server
    and add exact matches per tenant once the published tool list is known.
  - **Group names are placeholders** — replace `identity-admins` with your IdP's
    group name at import time. The match is an exact, case-sensitive string
    comparison against entries of the `groups` claim; `Identity-Admins` does not
    match `identity-admins`, and a lookalike like `identity-admins-viewers` does not
    match either (the comparison is `==`, not substring/prefix).
  - **The `groups` claim must be an array of strings.** If your IdP emits a single
    string or a namespaced custom claim (e.g. `https://acme.com/groups`), adjust
    `caller_groups` in the Rego. The exemption is guarded by `is_array`, so every
    non-array shape fails closed (deny) — including an object-shaped claim such as
    `{"role": "identity-admins"}`, whose *values* would otherwise have been iterated
    by `some group in caller_groups` and spoofed the admin exemption.
  - **Tool-name normalization.** The suffixes are the server's `verb_noun`
    snake_case tokens, so any gateway or SDK that rewrites the separator defeats the
    `endswith` match. Two distinct rewrites both slip through: **separator
    replacement** — kebab-case (`create-user` instead of `create_user`) — and
    **separator collapse** — camelCase (`createUser`, `addGroupMembers`), where the
    `_` disappears entirely so `lower("...createUser")` = `...createuser` ends with
    none of the snake_case suffixes. DTwo's gateway forwards the upstream tool name
    verbatim (snake_case), so this does not arise on the DTwo path, but some MCP
    SDKs auto-camelCase tool names. Verify with the dump-input debug technique; if
    your gateway rewrites separators, add the rewritten forms (`create-user`,
    `createuser`, …) to `identity_mutation_suffixes`.
  - **Reordered / non-`verb_noun` tool vocabularies bypass the suffix list.**
    The suffixes assume the echelon/michaelbuckner `verb_noun` convention
    (`create_user`). Servers that invert the token order — LokiMCPUniverse ships a
    `noun_verb` ServiceNow server (`incident_create`), so its identity tools would
    be `user_create`, `user_update`, `group_create`, `group_update`, and a
    membership tool such as `group_member_add` — end with **none** of these
    suffixes, so `servicenow-user_create` passes through and the mutation reaches
    the instance. This is not a gateway rewrite (DTwo forwards the upstream name
    verbatim); it is a genuinely different upstream tool vocabulary. Verify your
    server's actual names with the dump-input debug technique, and for a
    noun_verb server add the reordered forms (`user_create`, `user_update`,
    `group_create`, `group_update`, `group_member_add`, `group_member_remove`, …)
    to `identity_mutation_suffixes`, or rely on the PF-28 default-deny-unknown-tools
    allowlist to catch the un-anticipated names.
  - **Reads stay open by design.** `get_user`, `list_users`, and `list_groups` are
    not gated here — recon and read-side PII belong to the fence/redaction
    companions. If directory recon itself is a concern, add a separate read-gating
    policy rather than widening this one.
  - **A request with no resolvable tool name passes through.** This is a blocklist
    keyed on `input.resource.name`: a missing or empty name matches no suffix and is
    allowed. The gateway reliably populates `resource.name` on `tool_pre_invoke`, so
    this is inherent blocklist semantics; if you need fail-closed-on-unknown, deploy
    a PF-28 default-deny allowlist policy instead of (or alongside) this one.

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
package servicenow.ingress.freeze_identity_plane

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group permitted to perform identity-plane mutations.
# Replace "identity-admins" with your IdP's group name at import time.
identity_admin_group := "identity-admins"

# Lowercased, whitespace-trimmed tool name. The gateway prefixes tool names
# with the configured MCP server name, so matching is case-insensitive and
# suffix-based to stay portable across server names. trim_space so a trailing
# space/newline in the tool name cannot defeat the endswith suffix match.
tool_name := trim_space(lower(object.get(object.get(input, "resource", {}), "name", "")))

# Identity-and-access mutation tools on the echelon-ai-labs/servicenow-mcp
# server (verb_noun snake_case, the de facto community vocabulary). Each suffix
# is the trailing tool token itself (no leading separator), so endswith matches
# a bare name (`create_user`) and any prefix/separator the gateway prepends
# (`servicenow-create_user`, `servicenow.create_user`, `servicenowcreate_user`).
# Read-side identity tools (get_user, list_users, list_groups) are deliberately
# absent — read exposure belongs to the fence/redaction companions.
identity_mutation_suffixes := [
    "create_user",
    "update_user",
    "create_group",
    "update_group",
    "add_group_members",
    "remove_group_members",
]

is_identity_mutation if {
    some suffix in identity_mutation_suffixes
    endswith(tool_name, suffix)
}

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim
# that is not an array all yield "not an identity admin" — mutations then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# Guard on is_array. Without it, `some group in caller_groups` iterates the
# *values* of an object-shaped groups claim, so a claim like
# {"role": "identity-admins"} would spoof the exemption and fail OPEN. Requiring
# an array makes every non-array shape (string, object, number) fail closed —
# matching the documented "must be an array of strings" contract.
caller_is_identity_admin if {
    is_array(caller_groups)
    some group in caller_groups
    group == identity_admin_group
}

# Allow any tool that is not an identity-plane mutation (reads such as
# list_users, get_user, list_groups stay open for recon-free operation).
allow if {
    not is_identity_mutation
}

# Allow identity-plane mutations only for members of the identity-admin group.
allow if {
    is_identity_mutation
    caller_is_identity_admin
}

reasons contains msg if {
    is_identity_mutation
    not caller_is_identity_admin
    msg := sprintf("ServiceNow identity and group changes are frozen on the agent path — group membership drives ServiceNow ACLs, so user and group mutations are privilege-escalation primitives. Make these changes in the ServiceNow UI, or ask your identity admin to add you to the '%s' IdP group if your role requires making them through the gateway. Contact your InfoSec team if this looks like a false positive.", [identity_admin_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
