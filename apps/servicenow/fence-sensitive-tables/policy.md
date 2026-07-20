---
name: Fence Sensitive ServiceNow Tables
tags:
  - servicenow
  - fence-sensitive-tables
  - pii
  - ingress
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # servicenow / fence-sensitive-tables

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on a sensitive, ungrouped table; allow otherwise
  **Package:** `servicenow.ingress.fence_sensitive_tables`

  ## What it does

  Fences off the most sensitive ServiceNow tables from two routes that reach
  them:

  1. **The generic Table-API tools** from the michaelbuckner server —
     `perform_query`, `search_records`, `get_record`, and
     `natural_language_search`. These take a **table name** argument and reach
     *any* table the underlying credential can read (`sys_user`,
     `sn_hr_core_*`, `cmdb_ci*`, custom PII/payroll tables), not just
     incidents. The policy denies the call when the requested table is on the
     sensitive list **unless** the caller's IdP groups include the table's
     owner group.

  2. **The fixed-vocabulary user-directory reads** from the echelon-ai-labs
     server — `list_users` and `get_user`. These are the named route to the
     same `sys_user` PII (names, emails, phones, manager chains) that a generic
     `perform_query` on `sys_user` would return, so they are gated behind the
     same groups. Closing the generic route while leaving the named route open
     would be a trivial bypass.

  The sensitive-table mapping is:

  | Table (case-insensitive) | Owner group(s) that may read it |
  |---|---|
  | `sys_user` (exact) | `hr` **or** `infosec` |
  | `sn_hr_core_*` (prefix — HRSD case tables: health/leave/comp) | `hr` |
  | `cmdb_ci*` (prefix — CMDB configuration items) | `infosec` |

  A caller in `hr` may read HR case tables and `sys_user`; a caller in
  `infosec` may read CMDB and `sys_user`; neither may read the other's tables.
  `list_users`/`get_user` require `hr` **or** `infosec` (they surface
  `sys_user`).

  The check runs at ingress, before the call reaches the ServiceNow MCP server,
  so a denied read never executes and no sensitive row is returned.

  ## Fail-closed on an uninspectable query

  A generic Table-API call whose `table` argument is **missing or empty** is
  **denied**, not allowed. Without a table name the query cannot be scoped, so
  there is no way to prove it does not touch a sensitive table — the safe
  default is to reject it and ask the caller to name the table explicitly.

  ## Pin the sensitive-table list to YOUR instance at import time

  The shipped `sensitive_table_groups` / `sensitive_prefix_groups` constants
  are a **documented starter set** covering the standard high-risk tables
  (`sys_user`, `sn_hr_core_*`, `cmdb_ci*`). They are not a complete inventory
  of *your* sensitive data. **At import time, extend the constants with the
  custom PII, payroll, and regulated tables your instance holds** (e.g.
  `u_payroll_*`, `u_ssn_vault`, `sn_hr_core_*` siblings, finance tables) and
  map each to the group that owns it.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identifying and protecting confidential
    information by keeping sensitive tables (workforce, CMDB) behind owner
    groups; **P4.1** — supports limiting personal-information use to the
    identified purpose by restricting who may pull `sys_user` PII over the
    agent channel.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary and
    role-based-limit standards by gating HRSD case tables
    (`sn_hr_core_*`, which can hold health/leave data) to the `hr` group;
    **§164.308(a)(4)** — supports information-access management by tying table
    access to IdP group membership; **§164.522(a)** — supports agreed-to
    access restrictions as an enforceable predicate on the MCP path.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to
    stored data by role: the generic Table-API tools are exactly the
    programmatic-query surface, and this policy binds them to owner groups.
  - **GDPR Art. 9** — supports restricting access to special-category data
    (HR/health tables) on the agent channel; **§1798.121 (CPRA)** — supports
    the right to limit use of sensitive personal information by fencing
    `sys_user` and HR tables; **Art. 5(1)(b)** — supports purpose limitation by
    denying broad, unscoped table reads.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `servicenow-mcp-perform_query`), and that prefix is not standardized,
  so the policy matches by **suffix** on `lower(input.resource.name)`:

  - Generic Table-API (any table arg): `*perform_query`, `*search_records`,
    `*get_record`, `*natural_language_search`
  - User directory: `*list_users`, `*get_user`

  Suffix matching covers the two big community servers (echelon-ai-labs and
  michaelbuckner both use `verb_noun` snake_case). If you run a server that uses
  a different convention (e.g. LokiMCPUniverse's `noun_verb`), add its suffixes.
  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  - Generic Table-API tools read the target table from
    `input.payload.args.table` (verified for the michaelbuckner
    `perform_query`/`search_records`/`get_record` README shape). The value is
    lowercased **and whitespace-trimmed** (`trim_space`) before matching, so a
    `"sys_user\n"` / `"sys_user "` variant that ServiceNow might still resolve
    cannot slip past the exact/prefix match. Payload/args are read through
    `object.get` chains, so a call with no `payload` or no `args` at all is
    treated as a missing-table call and fails closed for the generic tools.
  - Caller groups are read from `input.subject.claims.groups` (an array),
    lowercased before comparison.

  ## Examples

  ### Allowed — non-sensitive table

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-perform_query", "type": "tool" },
      "payload": {
        "name": "servicenow-mcp-perform_query",
        "args": { "table": "incident", "query": "active=true" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — sensitive table, caller in owner group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-get_record", "type": "tool" },
      "subject": { "claims": { "groups": ["infosec"] } },
      "payload": {
        "name": "servicenow-mcp-get_record",
        "args": { "table": "cmdb_ci_server", "sys_id": "abc123" }
      }
    }
  }
  ```

  `allow = true` — `infosec` owns CMDB.

  ### Denied — sensitive table, no matching group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-perform_query", "type": "tool" },
      "subject": { "claims": { "groups": ["service-desk"] } },
      "payload": {
        "name": "servicenow-mcp-perform_query",
        "args": { "table": "sys_user", "query": "active=true" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Access to the ServiceNow table 'sys_user' is
  restricted to the hr, infosec group(s). Narrow your query to a non-sensitive
  table, or request membership in one of those groups."`

  ### Denied — user-directory read without a group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-list_users", "type": "tool" },
      "subject": { "claims": { "groups": [] } },
      "payload": { "name": "servicenow-mcp-list_users", "args": { "limit": 50 } }
    }
  }
  ```

  `allow = false` — `list_users` surfaces `sys_user` PII.

  ## Composition

  This policy is single-purpose (scope fencing). Useful companions on the same
  ServiceNow gateway:

  - [`servicenow/default-deny-unknown-tools`](../default-deny-unknown-tools/policy.md)
    — allowlist the audited tool surface so a renamed/new table tool cannot
    slip past this suffix match.
  - An **egress PII-redaction** policy on `list_incidents` / `get_record` /
    `search_records` / `list_users` responses, so any `sys_user`-shaped PII
    that leaks through a permitted-but-broad read is masked for non-HR/security
    callers (defense in depth against this policy's residual bypasses).

  ## Known limitations

  - **`natural_language_search` argument shape is unverified.** The
    michaelbuckner README documents the tool but not its argument keys. This
    policy treats it as a generic Table-API tool that reads a `table` argument;
    **if it does not carry a `table` argument it fails closed (denied)** under
    the missing-table rule, because an NL query whose target table cannot be
    read is uninspectable and cannot be proven safe. Confirm the real argument
    shape with the dump-input technique; if the tool exposes the table under a
    different key (or infers it server-side), update `table_arg` / the
    missing-table handling accordingly. As shipped, `natural_language_search`
    is effectively blocked unless it carries an inspectable `table` argument.
  - **Group names are placeholders — replace `hr` and `infosec` with your
    IdP's group names at import time.** They are read from
    `input.subject.claims.groups`; if your IdP emits groups under a
    different claim (e.g. a namespaced `https://acme.com/groups`) or a
    non-array shape, adjust `caller_groups`. If the gateway has no IdP
    configured, `groups` is absent and every sensitive read fails closed.
  - **Sensitive list is not exhaustive.** Only `sys_user`, `sn_hr_core_*`, and
    `cmdb_ci*` ship by default. Custom PII/payroll tables (`u_*`) are not fenced
    until you add them to the constants — see "Pin the sensitive-table list"
    above.
  - **`sys_user` is matched exactly, so its sibling `sys_user_*` tables are not
    fenced.** The mapping keys `sys_user` as an exact name (not a prefix), which
    is deliberate — the crown-jewel contact PII (names, emails, phones, manager
    chains) lives in `sys_user` itself. But the standard `sys_user_*` family holds
    related workforce identity and access data that some instances treat as
    equally sensitive: `sys_user_group`, `sys_user_grmember` (group membership —
    ACL reconnaissance), `sys_user_role`, `sys_user_has_role`, and
    `sys_user_preference`. These are **not** on the sensitive list, so an
    ungrouped caller can read them through `perform_query`/`get_record`/
    `search_records`. If your instance treats the family as sensitive, add
    `"sys_user"` to `sensitive_prefix_groups` (mapped to `{"hr", "infosec"}`) to
    fence the whole family, or list specific siblings in `sensitive_table_groups`.
    Prefixing `sys_user` will also fence benign lookups some service-desk
    workflows rely on (e.g. reading `sys_user_group` for ticket routing), so
    choose per your instance. (Red-team confirmed: `perform_query` on
    `sys_user_grmember` by an ungrouped caller is allowed as shipped.)
  - **Row-level scoping is coarse.** The policy fences by table name, not by
    row. A caller in `hr` who may read `sys_user` can read *all* of it; use an
    egress redaction policy if you need per-field or per-row limits.
  - **Dot-walk / field-selection exfiltration through a permitted table is not
    caught.** A `perform_query`/`get_record` on an allowed table (e.g.
    `incident`) can pull referenced `sys_user` fields with a dot-walked query or
    field list (`sysparm_fields=caller_id.email,caller_id.phone`,
    `caller_id.user_name=…`). The policy fences on the *target* table name only;
    it cannot see PII columns reached by reference. This is the primary residual
    — pair the egress PII-redaction companion below so any `sys_user`-shaped data
    that comes back through a permitted read is masked for non-HR/security
    callers. (Red-team confirmed: `table:"incident"` with a
    `caller_id.email` field selection is allowed.)
  - **The michaelbuckner server also exposes tables as MCP _resources_
    (`servicenow://tables/{table}`), not just tools.** This policy matches tool
    suffixes on `tool_pre_invoke`; a resource read of
    `servicenow://tables/sys_user` does **not** end with a guarded suffix and
    passes through. If your gateway proxies MCP resource reads through policy,
    add a companion rule that fences resource URIs, or disable the resource
    surface on the server. (Red-team confirmed: a `servicenow://tables/sys_user`
    resource read is allowed by this policy.)
  - **Other reach paths exist.** ServiceNow PII is also reachable through
    incident `description`/`comment` bodies, HRSD Now Assist skills on the
    official server, and Knowledge Graph queries — none of which take a `table`
    argument. This policy only fences the generic Table-API and the named
    user-directory reads; compose the egress redaction companion for the rest.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - servicenow
industries: []
bundles:
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package servicenow.ingress.fence_sensitive_tables

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Tool surfaces we guard (matched by suffix for gateway-prefix portability) ---

# Generic Table-API tools (michaelbuckner). Each takes a `table` argument and
# can reach ANY table the credential can read.
generic_table_tool_suffixes := {
    "perform_query",
    "search_records",
    "get_record",
    "natural_language_search",
}

# Fixed-vocabulary user-directory reads (echelon-ai-labs). These surface the
# same sys_user PII, so they are gated behind the same groups as sys_user.
user_directory_tool_suffixes := {
    "list_users",
    "get_user",
}

# --- Sensitive-table mapping (documented starter set; tenants EXTEND these) ---

# Exact sensitive table names -> the set of groups permitted to read them.
sensitive_table_groups := {
    "sys_user": {"hr", "infosec"},
}

# Sensitive table-name PREFIXES -> the set of groups permitted to read them.
# `sn_hr_core_` = HRSD case tables (health/leave/comp); `cmdb_ci` = CMDB items.
sensitive_prefix_groups := {
    "sn_hr_core_": {"hr"},
    "cmdb_ci": {"infosec"},
}

# Groups permitted to use the named user-directory reads (they surface sys_user).
user_directory_groups := {"hr", "infosec"}

# --- Tool classification ---

is_generic_table_tool if {
    some suffix in generic_table_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

is_user_directory_tool if {
    some suffix in user_directory_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

# --- Identity: caller's IdP groups, lowercased. Missing claims -> empty set. ---

claims := object.get(object.get(input, "subject", {}), "claims", {})

caller_groups := {lower(g) | some g in object.get(claims, "groups", [])}

# --- Requested table (case-insensitive, whitespace-trimmed) ---

# Safe args access: missing payload/args -> {} (no direct index of input.payload.args).
args := object.get(object.get(input, "payload", {}), "args", {})

# trim_space closes a whitespace-evasion bypass: "sys_user\n" / "sys_user "
# would otherwise miss the exact/prefix match yet may still resolve server-side.
table_arg := trim_space(lower(object.get(args, "table", "")))

table_arg_present if {
    table_arg != ""
}

# The union of every owner-group set that matches the requested table
# (exact match on sys_user, or prefix match on sn_hr_core_/cmdb_ci).
table_required_groups := union(matched_group_sets)

matched_group_sets := {groups |
    some name, groups in sensitive_table_groups
    name == table_arg
} | {groups |
    some prefix, groups in sensitive_prefix_groups
    startswith(table_arg, prefix)
}

table_is_sensitive if {
    count(table_required_groups) > 0
}

caller_authorized_for_table if {
    some g in table_required_groups
    caller_groups[g]
}

caller_authorized_for_directory if {
    some g in user_directory_groups
    caller_groups[g]
}

# --- Allow rules ---

# Any tool we don't guard passes through untouched.
allow if {
    not is_generic_table_tool
    not is_user_directory_tool
}

# Generic Table-API call on a non-sensitive table (with a table named).
allow if {
    is_generic_table_tool
    table_arg_present
    not table_is_sensitive
}

# Generic Table-API call on a sensitive table by an owner-group member.
allow if {
    is_generic_table_tool
    table_arg_present
    table_is_sensitive
    caller_authorized_for_table
}

# Named user-directory read by an hr/infosec member.
allow if {
    is_user_directory_tool
    caller_authorized_for_directory
}

# --- Deny reasons ---

# Fail closed: generic tool with no table argument cannot be scoped.
reasons contains sprintf("The ServiceNow tool '%s' was called without a 'table' argument, so the query cannot be scoped to a non-sensitive table. Name the specific table you are authorized to read.", [lower(input.resource.name)]) if {
    is_generic_table_tool
    not table_arg_present
}

# Sensitive table, caller lacks the owner group.
reasons contains sprintf("Access to the ServiceNow table '%s' is restricted to the %s group(s). Narrow your query to a non-sensitive table, or request membership in one of those groups.", [table_arg, concat(", ", sort([g | some g in table_required_groups]))]) if {
    is_generic_table_tool
    table_arg_present
    table_is_sensitive
    not caller_authorized_for_table
}

# Named user-directory read, caller lacks hr/infosec.
reasons contains "Access to the ServiceNow user directory (the sys_user table: names, emails, phones, manager chains) is restricted to the hr or infosec group. Narrow your query to a non-sensitive lookup, or request membership in one of those groups." if {
    is_user_directory_tool
    not caller_authorized_for_directory
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
