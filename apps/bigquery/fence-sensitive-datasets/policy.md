---
name: Fence Regulated BigQuery Datasets by Group
tags:
  - bigquery
  - fence-sensitive-scopes
  - ingress
  - rbac
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # bigquery / fence-sensitive-datasets

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny a regulated-dataset reference for callers outside the mapped data-domain group, allow otherwise
  **Package:** `bigquery.ingress.fence_sensitive_datasets`

  ## What it does

  Fences customer-designated **regulated BigQuery data domains** by data-domain IdP
  group, at ingress, before any statement or metadata lookup reaches BigQuery. The
  policy carries one placeholder map, `sensitive_domains`, pairing a **dataset name
  prefix** with the IdP group required to touch that domain:

  - `phi_` → `clinical-data`
  - `finance_` → `finance`
  - `pii_` → `data-privacy`

  It inspects **two surfaces** so that recon and enumeration are fenced before any
  `SELECT` runs — not just the query itself:

  - **Raw SQL** on the query tools (`execute_sql`, `execute_sql_readonly`,
    `query`, `execute-query`). **Every string argument value** on these tools is
    scanned for a table reference whose dataset component begins with a fenced
    prefix (e.g. `phi_labresults.records`, `myproj.finance_ledger.gl`,
    `` `pii_customers.profiles` ``). Scanning all string args — not just the
    documented `sql`/`query` keys — means a community server that names its SQL
    argument something else cannot slip a query past the fence fail-open.
  - **`dataset_id` / `table_id` arguments** on the metadata and read tools
    (`get_dataset_info`, `get_table_info`, `list_table_ids`, `list-tables`,
    `describe-table`). This closes the enumeration path: a caller cannot map or
    describe a regulated dataset's schema before deciding what to `SELECT`.

  If a fenced prefix is referenced on either surface and the caller's IdP `groups`
  claim does **not** include the mapped group, the call is denied. The deny reason
  names the data domain and the exact group required, plus an escalation hint.

  Group membership is read through `object.get(input.subject, "claims", {})` chains
  that **fail closed**: a missing, empty, or malformed `subject`/`claims`/`groups`
  never grants a fenced domain — no group means not exempt. A caller holding the
  *wrong* domain group (e.g. `finance` querying a `phi_` dataset) is likewise denied,
  because each domain requires its own specific group. Calls that reference no fenced
  prefix, and calls to tools outside the two inspected surfaces, pass through
  untouched.

  ## Compliance alignment

  - **HIPAA §164.502(b)/§164.514(d)** — supports the minimum-necessary and
    role-based-limits standard: agent access to a PHI-bearing dataset (`phi_`) is
    gated to its mapped `clinical-data` group on the MCP path, including the
    metadata/enumeration tools so a caller cannot even map PHI schema without the
    entitlement; **§164.308(a)(4)** — supports information access management by
    authorizing sensitive-domain access via IdP group.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored
    cardholder data by role: fence the `finance_` prefix so only the `finance` group
    can query or enumerate it through an agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information by gating agent SQL and metadata calls against designated
    confidential datasets; **P4.1** — supports limiting personal-information use to
    identified purposes by keeping PI-bearing datasets behind a role fence.
  - **GDPR Art. 9** — supports special-category protection by fencing datasets
    holding health (`phi_`) or other Art. 9 data; **CPRA §1798.121** — supports the
    right to limit use of sensitive personal information by fencing the `pii_` domain
    to a minimal group.
  - **SOX (ITGC — access to programs & data)** — supports least-privilege access to
    financial data: fencing the `finance_` domain to the `finance` group confines
    agent reads of financially relevant warehouse data to authorized personnel on the
    MCP path.

  ## Why ingress and least-privilege

  This is the minimum-necessary / least-privilege control for the warehouse's data
  plane: it stops a regulated-dataset reference — read, query, *or* enumeration —
  before it executes, rather than masking a response the query already produced.
  Fencing the metadata tools matters because schema recon (`get_dataset_info`,
  `list_table_ids`) is itself a disclosure and a targeting step; blocking it early
  denies the agent the map it would use to craft an exfiltration `SELECT`. Pair with
  an **egress redaction backstop** (see Composition) for defense in depth, since
  which specific tables hold regulated data is not knowable from the wire.

  ## Tool name matching

  Tools are matched by **suffix** (the gateway prefixes tool names with the
  configured MCP server name, which is not standardized). Two classes are inspected:

  - **SQL query tools** — `execute_sql` and `execute_sql_readonly` (Google
    official remote server + MCP Toolbox `bigquery` toolset, snake_case),
    `query` (ergut/mcp-bigquery-server), `execute-query`
    (LucasHild/mcp-server-bigquery, kebab-case). `execute_sql_readonly` is
    matched explicitly because a read-only SELECT still bulk-reads a regulated
    dataset. **Every string argument value** on these tools is scanned (not just
    `sql`/`query`).
  - **Metadata / read tools** — `get_dataset_info`, `get_table_info`,
    `list_table_ids`, `list-tables`, `describe-table`. Their `dataset_id`/`table_id`
    arguments are scanned.

  Any other tool (including `list_dataset_ids`, which lists dataset names with no
  target argument) is **not** inspected and passes through — see Known
  limitations. Verify the exact tool names your gateway emits with the
  dump-input debug technique before relying on this in production.

  ## Argument shape

  - **SQL query tools** — `sql` / `query` are the documented keys carrying the
    GoogleSQL text, but **all** string argument values are read and scanned, so a
    server that carries the SQL under a different (unverified) key is still
    fenced rather than passing fail-open.
  - `dataset_id` / `table_id` — the dataset/table identifiers (strings) on the
    metadata tools. A fully-qualified `table_id` (`finance_gl.journal`) is matched as
    readily as a bare dataset id (`pii_customers`). The community kebab-case tools
    (`list-tables`, `describe-table`) whose argument key is unverified are also read
    under the aliases `dataset`, `table`, and `table_name`, so a metadata tool this
    policy claims to inspect is fenced regardless of which of these keys it uses.

  Only string argument values are inspected; a non-string value contributes no text.

  ## Examples

  ### Allowed — cleared caller queries a fenced dataset

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "subject": { "sub": "google-apps|nurse@example.com", "claims": { "groups": ["clinical-data"] } },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "SELECT patient_id, visit_date FROM phi_records.encounters WHERE patient_id = 42" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — uncleared caller references a fenced dataset in SQL

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-execute_sql", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "bigquery-mcp-execute_sql",
        "args": { "sql": "SELECT customer_id, email FROM pii_customers.profiles WHERE id = 5" }
      }
    }
  }
  ```

  `allow = false`, reason names the personal-data (PII) domain and the required
  `data-privacy` group.

  ### Denied — schema recon on a fenced dataset via a metadata tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "bigquery-mcp-get_dataset_info", "type": "tool" },
      "subject": { "sub": "google-apps|analyst@example.com", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "bigquery-mcp-get_dataset_info",
        "args": { "dataset_id": "phi_labresults" }
      }
    }
  }
  ```

  `allow = false` — the caller holds `finance`, not the `clinical-data` group the
  `phi_` domain requires, so even the metadata lookup is fenced.

  ## Composition

  This policy is single-purpose. Curated companions for the BigQuery data plane:

  - **`guard-warehouse-sql` (ingress)** — deny DML/DDL/`GRANT` so a fenced-out caller
    cannot pivot to a destructive write; keeps ordinary agent callers read-only.
  - **`guard-warehouse-export` (ingress)** — deny `EXPORT DATA`/`EXTERNAL_QUERY`
    exfiltration constructs that move regulated data out without looking like a write.
  - **`redact-pii-egress` (egress)** — redact SSN/PAN/email patterns from returned
    rows: the defense-in-depth backstop for regulated tables not yet pinned here, or
    referenced by a dynamic construct this ingress fence cannot see.

  ## Known limitations

  - **Placeholder configuration.** The prefixes (`phi_`, `finance_`, `pii_`) and
    group names (`clinical-data`, `finance`, `data-privacy`) are placeholders —
    replace them with your tenant's real dataset naming scheme and your IdP's
    group-claim values at import time. Which datasets hold regulated data is not
    knowable from the wire, so pinning the naming convention is mandatory for this
    policy to do anything.
  - **Dynamic and indirect references evade the prefix regex.** Detection matches the
    literal fenced prefix at an identifier boundary in the wire text. A dataset
    reference built dynamically (`EXECUTE IMMEDIATE`, string concatenation, a
    parameter/bind) or reached indirectly through a **view defined in another
    dataset** — where the un-prefixed view name is what appears in the SQL — is not
    fenced. This is a fundamental limit of wire-level inspection; pair with
    `guard-warehouse-sql` (to scope dynamic SQL) and keep the egress redaction
    backstop in place. Treat the ingress fence as one layer, not the sole control.
  - **Dataset-listing tool is not inspected.** `list_dataset_ids` lists dataset
    names with no target argument, so it passes through — an uncleared caller can
    still learn that a `phi_`-prefixed dataset *exists* (but not its schema or
    rows). `execute_sql_readonly` **is** now fenced (added to `sql_tool_suffixes`),
    so a read-only `SELECT` from a fenced dataset is denied for an uncleared
    caller just like `execute_sql`.
  - **`INFORMATION_SCHEMA` / region-level enumeration is not fenced.** A query
    such as ``SELECT schema_name FROM `region-us`.INFORMATION_SCHEMA.SCHEMATA``
    enumerates every dataset name in a region without ever writing a fenced
    prefix as a literal table reference, so the boundary-anchored detection does
    not fire and the call passes. This is metadata recon that the wire-level
    prefix match cannot see; pair with a **block-schema-recon** companion policy
    that denies `INFORMATION_SCHEMA`/`__TABLES__` references for callers outside
    analytics/engineering groups, and keep the egress backstop in place.
  - **AI-analytics and catalog-search tools are not inspected.** The MCP Toolbox
    tools `ask_data_insights` (which ships table contents to Google's Conversational
    Analytics API), `forecast`, `analyze_contribution`, and `search_catalog` are
    **not** among the inspected suffixes. The first three take a table reference plus
    a natural-language question (not a `sql`/`dataset_id` argument), so an uncleared
    caller can reference a fenced table through one of them and move its data without
    tripping this fence; their table-reference field name is unverified across
    Toolbox revisions. `search_catalog` is a Dataplex catalog search: it enumerates
    and describes datasets/tables by keyword, so an uncleared caller can use it to
    *discover* a fenced `phi_`/`finance_`/`pii_` dataset's existence and metadata
    (a recon/enumeration path parallel to `list_dataset_ids` and
    `INFORMATION_SCHEMA` above) even though it never carries a literal fenced table
    reference in a scanned argument. Gate the AI tools with a companion
    **gate-ai-analytics** policy and the search tool with a **block-schema-recon**
    companion (deny by group), and keep the egress redaction backstop in place; do
    not rely on this fence to cover the AI-analytics or catalog-search paths.
  - **Non-string / nested argument shapes are not inspected.** Detection reads only
    top-level **string** argument values (SQL tools scan every string arg; metadata
    tools scan the string-valued alias keys). A tool that carries its SQL or target
    identifier inside a **nested object or an array** (e.g. `args.query.sql`, or a
    `statements: [...]` batch) contributes no scanned text, so the call is treated as
    carrying no readable target and **passes through fail-open**. No verified
    BigQuery SQL/metadata server uses such a shape (all pass `sql`/`dataset_id` as
    top-level strings — see the landscape note), so this is a residual for an
    unverified/future community server rather than a live bypass; if you adopt a
    server with a nested argument shape, extend `inspected_text` to walk it, and keep
    the egress backstop in place.
  - **Convention-dependent, boundary-anchored.** Detection keys on a prefix at an
    identifier boundary (`\bphi_`), so a regulated dataset that does not carry the
    pinned prefix is not fenced, and — conversely — a benign column, alias, or
    literal that literally begins with a fenced prefix (e.g. a column named
    `phi_flag`) produces a **conservative (fail-safe) denial** for an un-cleared
    caller. Enforce the dataset naming convention in BigQuery and rely on the egress
    backstop for the residual.
  - **`groups` claim must be an array of strings.** A string-valued or otherwise
    malformed claim fails closed (fenced domains deny). On Auth0 tenants without RBAC
    /permissions configured, no `groups` claim reaches the policy and every fenced
    domain denies until the claim is wired up. If your IdP emits groups under a
    different claim name (e.g. a namespaced custom claim), update `caller_groups` in
    the Rego.
  - **Never uses stripped claims.** Authorization is driven solely by the IdP
    `groups` claim. The ContextForge-internal claims `is_admin`, `user`, and `teams`
    are stripped before reaching the policy and must **never** be used for these
    grants — a rule referencing them would silently never match.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - bigquery
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
package bigquery.ingress.fence_sensitive_datasets

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# ---------------------------------------------------------------------------
# Fence configuration — PLACEHOLDERS, replace at import time.
#
# Maps a BigQuery dataset NAME PREFIX -> the IdP group required to touch that
# data domain. Prefixes are matched case-insensitively at an identifier
# boundary (\bPREFIX); groups are compared case-insensitively against
# `subject.claims.groups`. Replace with the tenant's real dataset naming scheme
# and IdP group names.
sensitive_domains := {
	"phi_": "clinical-data", # e.g. phi_records.encounters, phi_labresults
	"finance_": "finance", # e.g. finance_ledger.gl, finance_ar
	"pii_": "data-privacy", # e.g. pii_customers.profiles, pii_events
}

# Human-readable domain label for the deny reason.
domain_labels := {
	"phi_": "protected health information (PHI)",
	"finance_": "financial",
	"pii_": "personal data (PII)",
}

# ---------------------------------------------------------------------------
# Identity — read groups via object.get chains so a missing subject/claims/
# groups fails closed (no group -> no access to a fenced domain).
caller_groups := object.get(object.get(input, "subject", {}), "claims", {})

caller_group_list := object.get(caller_groups, "groups", [])

# True when the caller's groups claim (an array of strings) contains `group`.
# A malformed (non-array) claim makes the iteration fail -> fail closed.
caller_has_group(group) if {
	some g in caller_group_list
	lower(g) == lower(group)
}

# ---------------------------------------------------------------------------
# Tool classification — match by suffix (gateway prefixes the server name).

# Raw-SQL query tools. `execute_sql_readonly` is matched explicitly (its
# `_readonly` suffix is NOT caught by the `execute_sql` suffix) because a
# read-only SELECT still bulk-reads a regulated dataset, which is exactly what
# this fence governs. Every string argument on these tools is scanned, so a
# community server that names its SQL argument something other than `sql`/
# `query` cannot slip a query through fail-open.
sql_tool_suffixes := ["execute_sql_readonly", "execute_sql", "execute-query", "query"]

# Metadata / read tools whose `dataset_id`/`table_id` argument is scanned.
metadata_tool_suffixes := [
	"get_dataset_info",
	"get_table_info",
	"list_table_ids",
	"list-tables",
	"describe-table",
]

tool_name := lower(object.get(input.resource, "name", ""))

is_sql_tool if {
	some suffix in sql_tool_suffixes
	endswith(tool_name, suffix)
}

is_metadata_tool if {
	some suffix in metadata_tool_suffixes
	endswith(tool_name, suffix)
}

# ---------------------------------------------------------------------------
# Argument extraction — object.get everywhere; only string values contribute.
args := object.get(object.get(input, "payload", {}), "args", {})

# SQL text (from a query tool). Scan EVERY string argument value, not only the
# documented `sql`/`query` keys, so a divergent/unverified argument key on a
# community server cannot let an un-fenced query pass fail-open. A stray non-SQL
# string arg that happens to start with a fenced prefix yields a conservative
# (fail-safe) denial — consistent with the boundary-anchored detection below.
inspected_text contains t if {
	is_sql_tool
	some _, v in args
	is_string(v)
	v != ""
	t := v
}

# Metadata identifiers (from a metadata tool). Official servers name these
# `dataset_id`/`table_id`; the community kebab-case tools (LucasHild
# `list-tables`/`describe-table`) may name them `dataset`/`table`/`table_name`.
# Read the union so a metadata tool this policy CLAIMS to inspect cannot slip
# through fail-open just because it used a different (unverified) key name.
metadata_arg_keys := ["dataset_id", "table_id", "dataset", "table", "table_name"]

inspected_text contains t if {
	is_metadata_tool
	some key in metadata_arg_keys
	t := object.get(args, key, "")
	is_string(t)
	t != ""
}

# This policy only inspects the SQL and metadata surfaces above; every other
# tool, and an inspected tool carrying no readable target text, passes through.
is_inspected_call if {
	count(inspected_text) > 0
}

# ---------------------------------------------------------------------------
# Detection.

# True when `text` references an identifier beginning with `prefix`. `\b`
# anchors to an identifier boundary (start of string, whitespace, `.`, `(`,
# backtick, comma), so phi_records and myproj.finance_ledger match but a prefix
# buried mid-identifier (my_pii_col) does not.
domain_in_text(prefix, text) if {
	regex.match(sprintf(`(?i)\b%s`, [prefix]), text)
}

# A fenced domain the caller is NOT cleared for is referenced in the request.
denied_domains contains prefix if {
	some prefix, group in sensitive_domains
	some t in inspected_text
	domain_in_text(prefix, t)
	not caller_has_group(group)
}

# ---------------------------------------------------------------------------
# Allow rules.

# Any call this policy does not inspect passes through untouched.
allow if {
	not is_inspected_call
}

# Inspected call that references no fenced domain the caller lacks clearance for.
allow if {
	is_inspected_call
	count(denied_domains) == 0
}

# ---------------------------------------------------------------------------
# Deny reasons — name the data domain, the dataset prefix, and the required
# group, with an escalation hint.
reasons contains msg if {
	some prefix in denied_domains
	group := sensitive_domains[prefix]
	label := domain_labels[prefix]
	msg := sprintf("Access to the %s data domain (BigQuery dataset prefix '%s') requires membership in the '%s' IdP group, which your identity does not carry. Request the '%s' group from your data-governance owner and retry; if you believe this dataset is misclassified, contact your data platform team.", [label, prefix, group, group])
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
