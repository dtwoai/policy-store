---
name: Default-Deny Unknown Power BI Modeling Tools
tags:
  - power-bi
  - default-deny-unknown-tools
  - allowlist
  - modeling
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # power-bi / default-deny-unknown-modeling-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only allowlisted Power BI tool-name suffixes pass
  **Package:** `power_bi.ingress.default_deny_unknown_modeling_ops`

  ## What it does

  Pins a per-tenant allowlist of audited Power BI tool-name suffixes and denies
  any call whose tool name does not end with an allowlisted entry. Everything the
  tenant has not explicitly reviewed is blocked before it reaches the Power BI
  MCP server, and the deny surfaces as a gateway event — the drift signal that
  flags a new, renamed, or newly enabled tool the moment it first appears.

  The local **Power BI Modeling MCP server** (`microsoft/powerbi-modeling-mcp`)
  is explicitly **public preview**: its README warns tools "may significantly
  change" before GA. It exposes ~21 coarse `<object>_operations` multiplexer
  tools, each fronting many sub-operations (list/create/update/delete-style),
  so new or renamed tools can appear between upgrades without review. This
  default-deny gate is the outer boundary for the app: a tool that stops matching
  an allowlisted suffix — or a freshly introduced one — is denied until it is
  re-audited.

  This is also the only enforcement point that **cannot be bypassed** with the
  modeling server's `--skipconfirmation` flag or with clients that do not
  implement MCP elicitation. The server's own confirmation prompts are
  client-side and optional; the gateway allowlist is not.

  A missing, empty, non-string, or non-ASCII tool name matches nothing and is
  denied (fail closed).

  ## Pin the allowlist to YOUR tenant at import time

  The shipped `allowed_tool_suffixes` array is a **starter set** of the tool
  names verified from Microsoft's own sources — the modeling server's README
  (the 21 `*_operations` names) and the remote server's wire-level names
  (`skills-for-fabric`). It is not, and cannot be, the list of tools *your*
  deployment has reviewed.

  The allowlist is a **per-tenant pin**: after each Power BI MCP upgrade, re-run
  the gateway dump-input technique to capture the exact tool names the server now
  advertises, audit any new or renamed names, and add only the audited ones. Every
  unlisted tool is denied until you do. **Do not guess** — the string the gateway
  sends is deployment-specific (it prepends the configured server name), so verify
  before pinning.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: the
    agent channel can only reach Power BI modeling/query capabilities that were
    explicitly reviewed and enumerated.
  - **SOC 2 CC6.6** — supports boundary protection: preview-server tools added or
    renamed in an upgrade do not become reachable through the gateway boundary
    without an explicit allowlist change.
  - **SOC 2 CC6.8** — supports prevention of unauthorized software: any modeling
    or query tool the tenant has not audited is unauthorized-by-default on the
    agent path, including tools that would otherwise run past the server's
    `--skipconfirmation` bypass.
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default state of any new Power BI tool is "inaccessible
    until audited," and semantic models routinely front regulated data
    (finance, HR, customer PII) imported or DirectQueried from the warehouse.

  ## Tool name matching

  Power BI's tool names follow three incompatible conventions (see the landscape
  note): the modeling server uses snake_case `<object>_operations` multiplexers
  (`model_operations`); the remote hosted server uses PascalCase verbs
  (`ExecuteQuery`); the community server uses prefixed snake_case (`desktop_…`,
  `cloud_…`). Behind the DTwo gateway each is prefixed with the configured MCP
  server name (e.g. `powerbi-modeling-mcp-model_operations`), and that prefix is
  not standardized.

  To stay portable, the policy matches case-insensitively on
  `lower(input.resource.name)` with **`endswith`** against the bare suffix:

  - `model_operations` (bare) — matches,
  - `powerbi-modeling-mcp-model_operations` (gateway-prefixed) — ends with
    `model_operations`, matches,
  - `ExecuteQuery` / `powerbi-mcp-ExecuteQuery` — lowercased, ends with
    `executequery`, matches.

  Before matching, the **raw** (pre-lowercase) name must consist only of the
  ASCII set real tool names and gateway prefixes use — `[A-Za-z0-9._-]`. This is
  checked before `lower()` runs, which closes a Unicode case-folding evasion:
  `lower()` folds a handful of non-ASCII code points onto ASCII letters (e.g. the
  Kelvin sign `U+212A` → `k`), so an allowlisted suffix could otherwise be spoofed
  with a folded character. A name containing any character outside that ASCII set
  is denied.

  The starter allowlist covers the verified modeling multiplexers plus the
  verified remote **read** tools:

  - **Modeling multiplexers (21):** `connection_operations`,
    `database_operations`, `transaction_operations`, `trace_operations`,
    `model_operations`, `table_operations`, `column_operations`,
    `measure_operations`, `relationship_operations`, `partition_operations`,
    `user_hierarchy_operations`, `calculation_group_operations`,
    `perspective_operations`, `named_expression_operations`,
    `function_operations`, `culture_operations`, `object_translation_operations`,
    `calendar_operations`, `query_group_operations`, `security_role_operations`,
    `dax_query_operations`.
  - **Remote read tools (4):** `ExecuteQuery`, `ValueSearch`,
    `GetSemanticModelSchema`, `GetReportMetadata`.

  Deliberately **excluded** (denied until audited): the remote Copilot generator
  `GenerateQuery` (consumes Copilot capacity), the unverified discovery helpers
  `DiscoverArtifacts` / `ResolveReportIdFromUrl` (landscape-noted as unverified on
  `/mcp/powerbi`), every community-server tool, and any Fabric-server tool
  (OneLake file delete, item CRUD).

  ## Argument shape

  This policy inspects only the tool **name** (`input.resource.name`); it reads no
  arguments, so it is insensitive to argument-shape differences between the three
  servers. A missing `resource` or `resource.name` resolves to `""` via
  `object.get` and matches nothing (deny). A **non-string** name (null, number,
  object, array — a malformed or hostile request) is coerced to `""` rather than
  passed to `lower()`; without that guard `lower()` would raise a built-in type
  error that leaves `allow` and `reason` undefined — a deny with no surfaced
  reason. With the guard it is a clean, reasoned deny.

  ## Examples

  ### Allowed — audited modeling multiplexer

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-modeling-mcp-model_operations", "type": "tool" },
      "payload": {
        "name": "powerbi-modeling-mcp-model_operations",
        "args": { "operation": "list" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — audited remote read tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-mcp-ExecuteQuery", "type": "tool" },
      "payload": {
        "name": "powerbi-mcp-ExecuteQuery",
        "args": { "query": "EVALUATE TOPN(10, 'Sales')" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — unaudited tool (drift)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "powerbi-modeling-mcp-dataflow_operations", "type": "tool" },
      "payload": {
        "name": "powerbi-modeling-mcp-dataflow_operations",
        "args": {}
      }
    }
  }
  ```

  `allow = false`, `reason = "This Power BI tool is not on the audited allowlist (...)"`.

  ## Composition

  This policy is the outer gate — it decides *which* Power BI tools exist for
  agents. It gates only tool **names**; the per-call operation enum inside each
  `*_operations` multiplexer is undocumented and unverified, so an allowlisted
  multiplexer may still perform a write or a delete. Pair it with the policies
  that constrain *what* a permitted tool may actually do:

  - **`apps/power-bi/block-rls-bypass-service-principal`** — denies the RLS-
    sensitive read/query tools under service-principal identity.
  - **`freeze-rls-role-edits`** (RLS-tampering guard on `security_role_operations`)
    — stops row-security filter *definitions* from being rewritten.
  - **`guard-warehouse-sql-dax`** — inspects the DAX text on the query tools
    (`ExecuteQuery`, `dax_query_operations`) for whole-table dumps.
  - An **egress PII redaction policy** on query/`ValueSearch`/`GetReportMetadata`
    responses so returned model data is masked before it reaches the model.

  ## Known limitations

  - **The starter allowlist is not your tool list.** Pinning it to the suffixes
    your tenant has actually reviewed — and re-running dump-input after every
    Power BI MCP upgrade, since the server is preview and may rename tools — is a
    required deployment step, not a tuning step.
  - **Name-based trust only; the operation enum is not gated.** The `*_operations`
    tools multiplex reads and writes (list/create/update/delete) selected by an
    operation argument whose enum is **undocumented and unverified**. Allowlisting
    `measure_operations` or `security_role_operations` by name permits *every*
    sub-operation it fronts. This policy gates names, not actions — it must be
    paired with the RLS-tampering, service-principal, and DAX-guard companions
    above to constrain behavior.
  - **M / Power Query injection via allowlisted multiplexers has no listed
    companion.** `partition_operations` and `named_expression_operations` are
    verified modeling tools and are therefore allowlisted by name, but they edit
    Power Query (M) expressions, and M can call `Web.Contents(...)`. A rewritten
    partition source is both a data-poisoning and an exfiltration channel that
    fires **later, at refresh time, outside the gateway's view** — the deny-event
    the gateway would otherwise surface never appears because the malicious fetch
    happens off the MCP path. None of the four companions listed under
    **Composition** constrains this (the DAX guard inspects DAX on the query
    tools, not M on the partition/expression tools). If agents do not need to edit
    partitions or named expressions, drop `partition_operations` and
    `named_expression_operations` from your pinned allowlist, or add a dedicated
    M-injection guard that inspects the operation and the M source string.
  - **`endswith` matching trusts the suffix, not a separator.** To cover the bare
    name and any gateway server-name prefix with one entry, matching does not
    require a separator before the suffix. A tool literally named
    `<anything>model_operations` (any string glued directly to an allowlisted
    suffix) would also match. This applies to the remote **read** verbs too, not
    only the `*_operations` multiplexers: an unaudited tool named
    `BatchExecuteQuery` or `ExportExecuteQuery` ends with `executequery` and would
    be auto-allowed, as would anything ending in `valuesearch` /
    `getsemanticmodelschema` / `getreportmetadata`. No tool in the current Power BI
    inventory collides this way, but the short verb suffixes are the likelier
    future collision; if your deployment needs stricter matching, replace the
    suffix entries with the exact full gateway tool names.
  - **Generic object suffixes weaken drift detection for future renames.** Because
    matching is by suffix, a **future or renamed** preview-server tool whose name
    ends in an allowlisted object token — e.g. a hypothetical
    `snapshot_table_operations` ending in `table_operations`, or
    `advanced_model_operations` ending in `model_operations` — would be
    auto-allowed rather than surfaced as drift. The drift-detection guarantee
    holds for tools that *stop* matching a suffix and for brand-new object types
    (`dataflow_operations` does **not** end with any allowlisted suffix and is
    denied), not for a new tool that *starts* ending in an existing object token.
    If that matters to you, pin the exact full gateway tool names instead of the
    bare `*_operations` suffixes.
  - **Community and Fabric servers are not covered by the starter list.** The
    community server's `execute_dax` / `cloud_list_*` / `pbip_*` names and the
    Fabric server's OneLake/item-CRUD tools are intentionally excluded — they are
    denied until audited and added. If you run one of those servers, audit and pin
    its verified names.
  - **ASCII-only tool names.** Matching requires the raw name to be
    `[A-Za-z0-9._-]`. This is deliberate (it blocks Unicode case-fold and
    homoglyph spoofing), but a deployment whose configured MCP server name
    contains other characters (spaces, `@`, `/`, non-ASCII) would see even its
    legitimate tools denied; rename the server to an ASCII slug, or relax the
    character class, if so.
  - **Exact upstream suffixes unverified for your gateway.** The bare names are
    verified from Microsoft's README and `skills-for-fabric`, but the string your
    gateway actually sends depends on the configured server name. Confirm with
    dump-input before pinning.
  - **No identity-based exemptions.** All callers face the same allowlist. If you
    need a platform-admin break-glass group that can call an unaudited tool during
    a controlled window, add a separate `allow if` branch gated on
    `input.subject.claims` groups (placeholder group names — replace with your
    IdP's group name at import time).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - power-bi
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package power_bi.ingress.default_deny_unknown_modeling_ops

# Deny-by-default: a tool call is allowed only if its name ends with an audited
# allowlist suffix below. A missing, empty, non-string, or non-ASCII tool name
# matches nothing and is therefore denied (fail closed).
default allow := false

# Audited Power BI tool-name suffixes — STARTER SET. Pin to the suffixes YOUR
# tenant has reviewed, and re-run dump-input after every Power BI MCP upgrade
# (the modeling server is preview and may rename tools). Matched with endswith
# so one bare suffix also covers any gateway <server-name>- prefix
# (powerbi-modeling-mcp-model_operations).
#
# Sources: microsoft/powerbi-modeling-mcp README (the 21 *_operations names) and
# microsoft/skills-for-fabric (remote wire-level names). Deliberately EXCLUDED —
# default-deny by design, audit before adding any:
#   - Remote Copilot generator: GenerateQuery (consumes Copilot capacity)
#   - Unverified discovery:      DiscoverArtifacts, ResolveReportIdFromUrl
#                                (presence on /mcp/powerbi unverified)
#   - Community server:          execute_dax, desktop_*, cloud_*, pbip_*, delete_*
#   - Fabric server:             OneLake file delete, item CRUD
allowed_tool_suffixes := [
    # Modeling server — session/infra multiplexers
    "connection_operations",
    "database_operations",
    "transaction_operations",
    "trace_operations",

    # Modeling server — model read/write metadata CRUD multiplexers
    "model_operations",
    "table_operations",
    "column_operations",
    "measure_operations",
    "relationship_operations",
    "partition_operations",
    "user_hierarchy_operations",
    "calculation_group_operations",
    "perspective_operations",
    "named_expression_operations",
    "function_operations",
    "culture_operations",
    "object_translation_operations",
    "calendar_operations",
    "query_group_operations",

    # Modeling server — governance-sensitive write multiplexer (name-gated only;
    # pair with freeze-rls-role-edits to constrain the operation enum)
    "security_role_operations",

    # Modeling server — DAX query multiplexer (read)
    "dax_query_operations",

    # Remote hosted server — verified read tools (lowercased for the match below)
    "executequery", # ExecuteQuery
    "valuesearch", # ValueSearch
    "getsemanticmodelschema", # GetSemanticModelSchema
    "getreportmetadata", # GetReportMetadata
]

# Raw tool name straight from the request. Missing resource/name resolves to ""
# via object.get and matches nothing (fail closed).
raw_tool_name := object.get(object.get(input, "resource", {}), "name", "")

# Tool name, lowercased. A non-string name (null, number, object, array — a
# malformed or hostile request) is coerced to "" instead of being handed to
# lower(), which would raise a built-in type error and leave allow/reason
# undefined. Coercing keeps the decision a clean, reasoned deny (fail closed).
tool_name := lower(raw_tool_name) if is_string(raw_tool_name)

tool_name := "" if not is_string(raw_tool_name)

# Character-class guard on the RAW (pre-lowercase) name. Real Power BI tool names
# and gateway <server-name>- prefixes use only ASCII letters, digits, underscore,
# dot, and hyphen. Checking the raw name BEFORE lower() closes a Unicode
# case-folding evasion: lower() folds some non-ASCII code points onto ASCII
# letters (e.g. the Kelvin sign U+212A -> "k"), so an allowlisted suffix could be
# spoofed with a folded character and slip past the default-deny gate despite
# being a visibly different, un-audited name. The regex is not multiline in
# OPA/Go, so a newline in the raw name breaks the whole-string match (^...$).
# Guarded by is_string so a non-string name still yields a clean, reasoned deny.
raw_name_is_plain_ascii if {
    is_string(raw_tool_name)
    regex.match(`^[A-Za-z0-9._-]+$`, raw_tool_name)
}

# Allow only when the raw name is plain ASCII AND ends with an audited suffix.
allow if {
    raw_name_is_plain_ascii
    some suffix in allowed_tool_suffixes
    endswith(tool_name, suffix)
}

reason := "This Power BI tool is not on the audited allowlist, so the gateway denies it by default and surfaces the call as tool drift. The Power BI Modeling MCP server is preview and can add or rename tools between upgrades, and this gate is the only enforcement point that cannot be bypassed with the server's --skipconfirmation flag or unimplemented client elicitation. Re-run the dump-input technique after the upgrade, audit the tool, and if it is safe for agents add its verified suffix to the allowlist. Contact your data-governance team if this is a false positive." if not allow
```
