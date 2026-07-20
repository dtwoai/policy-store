---
name: Fence Sensitive Databricks Schemas
tags:
  - databricks
  - fence-sensitive-scopes
  - ingress
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # databricks / fence-sensitive-schemas

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny fenced-namespace references for callers outside the data-privacy group, allow otherwise
  **Package:** `databricks.ingress.fence_sensitive_schemas`

  ## What it does

  Fences off the most sensitive lakehouse namespaces from agents on the **read side** of
  Databricks. It inspects two request surfaces and denies a call whose target catalog,
  schema, or table identifier matches a flagged pattern — unless the caller's
  `input.subject.claims.groups` include `data-privacy`:

  - **SQL statements** on the SQL-execution tools (`execute_sql`, `execute_sql_read_only`,
    `execute_sql_query`) — the SQL text is scanned for any flagged identifier. This covers
    even read-only `SELECT`s against fenced schemas, complementing the write guard
    (`guard-warehouse-sql`) that only stops DML/DDL.
  - **Unity Catalog metadata calls** — `describe_uc_table(full_table_name)` (the
    `full_table_name` argument is scanned) and `describe_uc_schema(catalog_name, schema_name)`
    (the catalog/schema pair is scanned as a fully-qualified prefix). Table- and schema-level
    metadata recon is how an agent discovers what to exfiltrate, so it is fenced alongside the
    data plane. Catalog-level enumeration (`list_uc_catalogs`, `describe_uc_catalog`) is **not**
    fenced here — see Known limitations.

  Before matching, the identifier text is normalized: backticks and double-quotes are dropped
  and whitespace around the `.` separator is collapsed, so ordinary Databricks/Spark quoting
  (`` `hr`.`salaries` ``) and spacing (`hr . salaries`) cannot slip a fenced namespace past a
  trailing-dot pattern like `hr.`.

  Fenced namespaces are pinned in a per-tenant list (`fenced_namespaces`) the operator tunes
  at import time; example patterns are `hr.`, `payroll.`, `pii_`, `_phi`, and `comp`. Catalog,
  schema, and table names are matched **case-insensitively**.

  Group membership is read through `object.get` chains and fails closed: a missing, empty, or
  malformed `subject`/`claims`/`groups` never grants a fenced namespace (no group → not exempt).
  The check also **fails closed when the SQL or table-name argument is absent — or present but
  not a string** (e.g. an array/object/number the normalizer cannot read). A fenced tool whose
  identifier-bearing argument cannot be inspected is denied rather than passed through, so an
  uninspectable call cannot slip past the fence. Tools this policy does not recognize (e.g.
  `list_uc_catalogs`, cluster/job tools) pass through untouched.

  ## Compliance alignment

  - **HIPAA §164.502(b)/§164.514(d)** — supports the minimum-necessary and role-based-limits
    standard: agent read access to a PHI-bearing schema (SQL *or* metadata discovery) is gated
    to the `data-privacy` group on the MCP path; **§164.308(a)(4)** — supports information access
    management by authorizing sensitive-namespace access via IdP group; **§164.522(a)** — the
    namespace list can encode agreed-to restrictions on specific regulated schemas.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored cardholder data
    by role: fence the cardholder schema/catalog so only the mapped group can read it through an
    agent, on both the SQL and the Unity Catalog metadata path.
  - **SOC 2 C1.1** — supports identification and protection of confidential information by gating
    agent SQL and metadata calls against designated confidential namespaces; **P4.1** — supports
    limiting personal-information use to identified purposes by keeping PI-bearing schemas behind
    a role fence.
  - **GDPR Art. 9** — supports special-category protection by fencing schemas holding health, HR,
    or other Art. 9 data; **CPRA §1798.121** — supports the right to limit use of sensitive
    personal information by fencing SPI schemas to a minimal group; **GDPR Art. 5(1)(b)** —
    supports purpose limitation on the agent channel.

  ## Why ingress and least-privilege

  This is the minimum-necessary / least-privilege control for the lakehouse **read** path: it
  stops a fenced-schema read (or a metadata probe against one) before it executes, rather than
  masking a response the query already produced. It complements the write guard
  (`guard-warehouse-sql`) — which stops mutations but lets read-only `SELECT`s through — and
  pairs with an **egress redaction backstop** (`redact-pii-egress` on `poll_sql_result`) for
  defense in depth, since which specific tables hold regulated data is not knowable from the
  wire and egress redaction catches leaks from schemas an operator has not yet pinned here.

  ## Tool name matching

  Databricks managed servers ship stable canonical tool names, so this policy matches by name:

  - **SQL tools** — matched by the shared stem `execute_sql` (`contains`), which catches the
    managed `execute_sql` / `execute_sql_read_only` and the community `execute_sql_query`
    (`RafaelCartenet`) in one rule. The landscape note recommends matching the shared stem
    because three different servers each expose an `execute_sql`-ish tool.
  - **Metadata tools** — `describe_uc_table` and `describe_uc_schema` matched by suffix
    (`endswith`), since the gateway prefixes tool names with the configured server name.

  Verify the exact names your gateway sends with the dump-input debug technique before relying
  on this in production. The managed single-space Genie tool name and the managed SQL execution
  tool's exact argument key are unverified in the landscape note — see Known limitations.

  ## Argument shape

  - **SQL tools:** the SQL text is read from `sql`, `statement`, and `query` — every non-empty
    string value among those keys is scanned (their union), so stuffing a decoy in one key while
    hiding a fenced reference in another does not help. `execute_sql_query` uses `sql`; the
    managed SQL tool's exact key is unverified, so `statement` and `query` are checked defensively.
    Only string values are inspected; a non-string value under any of these keys is uninspectable
    and fails closed (see What it does).
  - **`describe_uc_table`:** `full_table_name` (e.g. `main.hr.salaries`) — scanned directly.
  - **`describe_uc_schema`:** `catalog_name` and `schema_name` — scanned as the synthetic
    fully-qualified prefix `"<catalog>.<schema>."` so a pattern like `hr.` fences a schema
    literally named `hr` (which would otherwise have no trailing dot to match).

  A fenced tool that carries none of its identifier arguments fails closed (see What it does).

  ## Examples

  ### Allowed — non-fenced schema

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-sql-execute_sql_read_only", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "databricks-sql-execute_sql_read_only",
        "args": { "statement": "SELECT order_id, total FROM sales.orders LIMIT 10" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — data-privacy caller reads a fenced schema

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-sql-execute_sql_read_only", "type": "tool" },
      "subject": { "sub": "google-apps|dpo@example.com", "claims": { "groups": ["data-privacy"] } },
      "payload": {
        "name": "databricks-sql-execute_sql_read_only",
        "args": { "statement": "SELECT employee_id FROM hr.salaries" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — uncleared caller reads a fenced schema (read-only SELECT)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-sql-execute_sql_read_only", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "databricks-sql-execute_sql_read_only",
        "args": { "statement": "SELECT employee_id, salary FROM hr.salaries" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Databricks call targets the fenced sensitive namespace 'hr.'. (...)"`.

  ### Denied — Unity Catalog metadata probe against a fenced schema

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "databricks-uc-describe_uc_schema", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "databricks-uc-describe_uc_schema",
        "args": { "catalog_name": "main", "schema_name": "payroll" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Databricks call targets the fenced sensitive namespace 'payroll.'. (...)"`.

  ## Composition

  This policy is single-purpose. Curated companions for the Databricks data plane:

  - **`guard-warehouse-sql` (ingress)** — the write guard: deny DML/DDL/`GRANT` and bulk-export
    constructs. This fence complements it by covering read-only `SELECT`s against fenced schemas.
  - **`redact-pii-egress` (egress)** — redact SSN/PAN/email patterns from `poll_sql_result` and
    `genie_poll_response` rows: the defense-in-depth backstop for regulated tables not yet pinned
    into `fenced_namespaces`.
  - **`default-deny-unknown-tools` (ingress)** — allowlist the audited Databricks tool names so a
    dynamic `{CATALOG}__{SCHEMA}__{INDEX}` search tool or a renamed SQL tool cannot introduce an
    uninspected data path.

  ## Known limitations

  - **Placeholder configuration.** The patterns (`hr.`, `payroll.`, `pii_`, `_phi`, `comp`) are
    placeholders — replace them with your real catalog/schema/table naming convention at import
    time, and replace the `data-privacy` group with your IdP's group-claim value. Which tables
    hold regulated data is not knowable from the wire, so pinning the naming convention is
    mandatory for this policy to fence anything.
  - **`data-privacy` is a placeholder group name** — replace it with your IdP's group name at
    import time.
  - **Broad substring patterns over-match.** `comp` matches `comp`, `compensation`, and also
    unrelated identifiers like `company` or `component`; `_phi` matches any `..._phi...` token.
    These are the operator's tuning trade-off — anchor the patterns (`\bcomp`, `_phi\b`) if the
    false-positive rate is too high. Tune against representative queries before publishing.
  - **Convention-dependent, not lineage-aware.** Detection keys on the literal pattern appearing
    in the wire text. A regulated table that does not follow the naming convention
    (`salaries`, `patient_data`) is **not** fenced, and a caller reading it through a view or an
    alias that omits the pattern evades the fence. Enforce the naming convention in Unity Catalog
    and keep the egress redaction backstop in place.
  - **Prefix detection can be evaded by identifier obfuscation.** Ordinary quoting
    (`` `hr`.`salaries` ``) and whitespace/newlines around the dot (`hr . salaries`) are
    normalized away and *do* fire the fence (locked in as tests). But a caller who constructs the
    identifier dynamically — split across concatenated string literals (`'pi' || 'i_customers'`),
    a session variable, a `USE SCHEMA hr` context followed by an *unqualified* `SELECT ... FROM
    salaries`, or an inline (`/* */`) or line (`--`) SQL comment wedged between the schema name and
    its dot (`main.hr/**/.salaries`, `main.hr--x⏎.salaries`) — references the fenced table without
    the contiguous pattern ever appearing in the wire text, so the fence does not fire (documented
    residual, locked in as tests). Likewise a read through a view or alias that omits the pattern
    evades it. Comment stripping is deliberately **not** attempted at the wire level: because comment
    delimiters can also appear inside SQL string literals, a naive regex strip could delete a real
    trailing `FROM hr.salaries` and *introduce* a false negative — worse than the residual. This is
    a fundamental limit of wire-level SQL inspection; enforce the naming convention in Unity Catalog
    and pair with `guard-warehouse-sql` and the egress backstop.
  - **Catalog-level metadata recon is not fenced.** `list_uc_catalogs` and
    `describe_uc_catalog(catalog_name)` (RafaelCartenet) enumerate catalogs/schemas but do not
    read table data; they pass through untouched (locked in as a test), consistent with the
    read-side focus on schema/table identifiers. A catalog whose *name* matches a pattern (e.g. a
    catalog literally named `payroll`) is therefore still discoverable via `describe_uc_catalog`.
    Deny or tightly scope these enumeration tools via `default-deny-unknown-tools` if catalog-name
    disclosure is itself sensitive.
  - **Managed argument key unverified.** The managed `execute_sql` tool's exact SQL argument key
    is not published in the landscape note; the policy checks `sql`, `statement`, and `query`.
    If your server uses a different key, the SQL text is unseen and the call fails closed (denied)
    for non-exempt callers rather than passing silently — verify the key with the dump-input
    technique and add it to the SQL candidates if needed.
  - **`groups` claim must be an array of strings.** A string-valued or otherwise malformed claim
    fails closed (fenced namespaces deny). If your IdP emits groups under a different claim name
    (e.g. a namespaced custom claim), update `caller_groups` in the Rego.
  - **Genie / AI Search not covered.** Natural-language Genie tools and dynamic
    `{CATALOG}__{SCHEMA}__{INDEX}` AI Search tools are not inspected here — deny or tightly scope
    them via `default-deny-unknown-tools`, and rely on the egress backstop for their responses.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - databricks
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
package databricks.ingress.fence_sensitive_schemas

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# Fence configuration — PLACEHOLDERS, replace at import time.
#
# Each entry pairs a human `label` (named in the denial reason) with a `pattern`
# matched case-insensitively against the target identifier text (SQL statement,
# full table name, or synthetic catalog.schema. prefix). Which tables hold
# regulated data is not knowable from the wire, so the operator pins the naming
# convention here. Broad patterns (`comp`) over-match by design — anchor them
# (\bcomp) if the false-positive rate is too high. See Known limitations.
fenced_namespaces := [
	{"label": "hr.", "pattern": `hr\.`}, # e.g. hr.salaries, main.hr.comp
	{"label": "payroll.", "pattern": `payroll\.`}, # e.g. payroll.runs
	{"label": "pii_", "pattern": `pii_`}, # e.g. pii_customers, analytics.pii_profiles
	{"label": "_phi", "pattern": `_phi`}, # e.g. labresults_phi
	{"label": "comp", "pattern": `comp`}, # e.g. comp, compensation (broad — tune)
]

# IdP group that is exempt from the fence (a placeholder — replace at import).
exempt_group := "data-privacy"

# ---------------------------------------------------------------------------
# Identity — read groups via object.get chains so a missing subject/claims/
# groups fails closed (no group -> no access to a fenced namespace).
raw_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# Only an array is honored as the groups claim. Any other shape — a string, a
# number, or an OBJECT — is coerced to [] so it fails closed for the exemption.
# This is load-bearing: `some g in <object>` iterates the object's VALUES, so an
# object-valued claim like {"role0": "data-privacy"} would otherwise leak
# "data-privacy" into the membership check and spoof the exempt group.
caller_groups := raw_groups if is_array(raw_groups)

caller_groups := [] if not is_array(raw_groups)

# True when the caller's groups claim (an array of strings) contains `group`.
# A malformed (non-array) claim makes the iteration fail -> fail closed.
caller_has_group(group) if {
	some g in caller_groups
	lower(g) == lower(group)
}

# ---------------------------------------------------------------------------
# Tool matching. SQL tools are matched by the shared `execute_sql` stem
# (contains) so managed execute_sql / execute_sql_read_only and community
# execute_sql_query are all caught. Metadata tools are matched by suffix.
name := lower(object.get(object.get(input, "resource", {}), "name", ""))

is_sql_tool if {
	contains(name, "execute_sql")
}

is_describe_table if {
	endswith(name, "describe_uc_table")
}

is_describe_schema if {
	endswith(name, "describe_uc_schema")
}

# The set of tools this policy fences.
is_fenced_tool if {
	is_sql_tool
}

is_fenced_tool if {
	is_describe_table
}

is_fenced_tool if {
	is_describe_schema
}

# ---------------------------------------------------------------------------
# Argument extraction — object.get everywhere. `scan_texts` is the set of
# identifier strings to check against the fenced patterns.
args := object.get(object.get(input, "payload", {}), "args", {})

# SQL text: check sql, statement, query (managed key unverified — see docs).
# `is_string` is load-bearing: object.get returns the raw arg, and a non-string
# value (array/object/number) is > "" yet cannot be normalized or regex-matched.
# Without this guard it would be counted as "present" (arg_present true) but
# produce no normalized text, so the fence would silently ALLOW an uninspectable
# call. Requiring a string keeps a present-but-uninspectable arg failing closed.
scan_texts contains t if {
	is_sql_tool
	t := object.get(args, "sql", "")
	is_string(t)
	t != ""
}

scan_texts contains t if {
	is_sql_tool
	t := object.get(args, "statement", "")
	is_string(t)
	t != ""
}

scan_texts contains t if {
	is_sql_tool
	t := object.get(args, "query", "")
	is_string(t)
	t != ""
}

# describe_uc_table: the fully-qualified table name (string only — see above).
scan_texts contains t if {
	is_describe_table
	t := object.get(args, "full_table_name", "")
	is_string(t)
	t != ""
}

# describe_uc_schema: synthesize "<catalog>.<schema>." so a trailing-dot
# pattern like `hr\.` fences a schema literally named `hr`. Both parts must be
# strings; a non-string catalog/schema is uninspectable and fails closed.
scan_texts contains t if {
	is_describe_schema
	schema := object.get(args, "schema_name", "")
	is_string(schema)
	schema != ""
	catalog := object.get(args, "catalog_name", "")
	is_string(catalog)
	t := sprintf("%s.%s.", [catalog, schema])
}

# A fenced tool is inspectable only when it carried a string identifier argument.
# Absent OR non-string (uninspectable) argument -> fail closed (denied for
# non-exempt callers).
arg_present if {
	is_fenced_tool
	count(scan_texts) > 0
}

# ---------------------------------------------------------------------------
# Identifier text is normalized before matching so ordinary SQL quoting and
# spacing cannot hide a fenced namespace. Databricks/Spark SQL routinely quotes
# identifiers (`hr`.`salaries`) and tolerates whitespace/newlines around the dot
# separator (hr . salaries) — without normalization both evade a trailing-dot
# pattern like `hr\.`. We drop backticks and double-quotes and collapse any
# whitespace surrounding a '.'. Normalization only ever merges tokens (adds
# matches), never hides a contiguous pattern, so it is safe for a deny fence.
normalized_texts contains n if {
	some t in scan_texts
	unquoted := replace(replace(t, "`", ""), `"`, "")
	n := regex.replace(unquoted, `\s*\.\s*`, ".")
}

# ---------------------------------------------------------------------------
# Detection — labels of fenced namespaces referenced in the request.
matched_labels contains lbl if {
	some entry in fenced_namespaces
	some t in normalized_texts
	regex.match(sprintf(`(?i)%s`, [entry.pattern]), t)
	lbl := entry.label
}

# ---------------------------------------------------------------------------
# Allow rules.

# Tools this policy does not recognize pass through untouched.
allow if {
	not is_fenced_tool
}

# Callers in the exempt group may read fenced namespaces.
allow if {
	is_fenced_tool
	caller_has_group(exempt_group)
}

# Non-exempt caller: allow only an inspectable call that references no fenced
# namespace. A missing identifier argument makes arg_present false -> deny.
allow if {
	is_fenced_tool
	not caller_has_group(exempt_group)
	arg_present
	count(matched_labels) == 0
}

# ---------------------------------------------------------------------------
# Deny reasons.

reasons contains msg if {
	is_fenced_tool
	not caller_has_group(exempt_group)
	some lbl in matched_labels
	msg := sprintf("This Databricks call targets the fenced sensitive namespace '%s'. Reading fenced lakehouse schemas requires the 'data-privacy' IdP group — request access through your data-privacy access-request process. Contact your data platform admin if this namespace is mislabeled.", [lbl])
}

reasons contains msg if {
	is_fenced_tool
	not caller_has_group(exempt_group)
	not arg_present
	msg := "This Databricks SQL or Unity Catalog call is missing its statement or table-name argument, so its target namespace cannot be checked against the sensitive-schema fence — the call is denied fail-closed. Supply the SQL text or the full table/schema name, or request the 'data-privacy' IdP group through your data-privacy access-request process."
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
