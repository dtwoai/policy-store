---
name: Fence NetSuite HR & Payroll SuiteQL Queries
tags:
  - netsuite
  - fence-sensitive-scopes
  - ingress
  - gdpr-ccpa
  - soc2
publishedAt: 2026-07-12
description: |
  # netsuite / fence-hr-payroll-suiteql

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny HR/payroll references for callers outside the `hr` group, allow otherwise
  **Package:** `netsuite.ingress.fence_hr_payroll_suiteql`

  ## What it does

  Fences the single biggest exfiltration surface on the NetSuite MCP server —
  `ns_runCustomSuiteQL`, which runs arbitrary read-only SuiteQL across the entire ERP.
  One query can pull employee SSN/TIN, compensation, and payroll data in a single call.
  This policy inspects the `sqlQuery` argument and, case-insensitively, denies
  the call when the query text references HR/payroll table and column names —
  `employee`, `payroll`, `payrollitem`, `paycheck`/`paycheckjournal`, `compensation`,
  `salary`, and SSN/TIN column tokens (`ssn`, `socialsecuritynumber`, `tin`, `taxid`) —
  **unless** the caller carries the `hr` IdP group in `input.subject.claims.groups`.

  The same restriction covers `ns_runSavedSearch`: because the saved-search identifier reaches
  the same HR/payroll data through a pre-built view, the policy denies the call when any string
  argument on it contains an `hr` or `payroll` token — again unless the caller is in the `hr`
  group. All other NetSuite tools (`ns_getRecord`, `ns_runReport`, writes, metadata helpers, and
  everything on the wider `/v1/all` surface) pass through this policy untouched.

  This limits sensitive-personal-data access on the agent channel to authorized HR users.
  Group membership is read through `object.get` chains and fails closed: a missing, empty, or
  malformed `subject`/`claims`/`groups` never grants the exemption (no group → not exempt), so a
  sensitive query with absent identity is denied. `default allow := false` is the deny-policy
  default; the pass-through `allow` rules below permit everything this policy does not fence.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identifying and protecting confidential information by gating agent
    SuiteQL against the employee/payroll domain; **P4.1** — supports limiting personal-information
    use to identified purposes by keeping HR/payroll data behind an IdP-group fence on the MCP path.
  - **GDPR Art. 9** — supports special-category protection: compensation, payroll, and national
    tax-identifier data are fenced to a minimal authorized group on the agent channel;
    **CPRA §1798.121** — supports the consumer right to limit use of sensitive personal information
    (SSN/TIN, precise compensation) by fencing it to the `hr` group; **GDPR Art. 5(1)(b)** —
    supports purpose limitation by preventing general-purpose agents from sweeping HR data.

  ## Why ingress and least-privilege

  SuiteQL is read-only, but the leak happens the moment the query executes and the rows land in
  the agent's context — an egress redactor would only mask what has already been retrieved and
  logged (every MCP call is written to the NetSuite integration Execution Log). Denying at ingress,
  before the query reaches NetSuite, is the only way to actually prevent the retrieval. This is the
  minimum-necessary control for the ERP's most sensitive personal-data surface; pair it with an
  egress redaction backstop (see Composition) for defense in depth.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `netsuite-mcp-ns_runCustomSuiteQL`), and that prefix is not standardized. The policy therefore
  matches case-insensitively on the **suffix**:

  - `*ns_runcustomsuiteql`
  - `*ns_runsavedsearch`

  The official NetSuite AI Connector SuiteApp and the dsvantien community proxy expose identical
  `ns_*` tool names, so one policy covers both. The ChatFin (`get-*`) and glints-dev (`netsuite_*`)
  servers use different naming conventions and are **not** matched by this policy. Verify the exact
  tool name your gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  - `ns_runCustomSuiteQL`: `{ sqlQuery: string, description?: string, pageSize?: number }`. The
    policy reads `sqlQuery` and scans it for the HR/payroll patterns. The DTwo PARC schema
    surfaces tool arguments under `payload.args`, while the NetSuite landscape note calls the
    same object `payload.arguments`; for a fail-safe fence the policy merges **both** containers
    (via `object.union`, with `arguments` winning on conflict) so a `sqlQuery` delivered under
    either key is inspected. A null / non-object container is coerced to `{}` so the merge cannot
    type-error and silently disable the fence.
  - `ns_runSavedSearch`: takes a saved-search identifier plus filters. Oracle does not publish the
    exact identifier field name, so it is **unverified** — to avoid failing open on the wrong key,
    the policy scans **every top-level string argument** on the call for an `hr`/`payroll` token.
    `payroll` matches as a bare case-insensitive substring (so `payrolls`, `payrolldata`, and the
    `hrpayroll` concatenation are all caught, matching the SuiteQL `payroll` prefix); the 2-char
    `hr` token requires a non-alphanumeric boundary on both sides so it does not fire on embedded
    "hr" (`threshold`, `href`, `chrome`). This is a deliberately fail-safe (over-block) choice;
    see Known limitations.

  ## Examples

  ### Allowed — non-HR query, non-HR caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_runCustomSuiteQL", "type": "tool" },
      "subject": { "sub": "google-apps|analyst@example.com", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "netsuite-mcp-ns_runCustomSuiteQL",
        "arguments": { "sqlQuery": "SELECT tranid, amount FROM transaction WHERE type = 'SalesOrd'" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — HR/payroll query, non-HR caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_runCustomSuiteQL", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "netsuite-mcp-ns_runCustomSuiteQL",
        "arguments": { "sqlQuery": "SELECT firstname, ssn, compensation FROM employee" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This SuiteQL query references HR or payroll data (...)"`.

  ### Allowed — same query, HR caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_runCustomSuiteQL", "type": "tool" },
      "subject": { "sub": "google-apps|hrlead@example.com", "claims": { "groups": ["hr"] } },
      "payload": {
        "name": "netsuite-mcp-ns_runCustomSuiteQL",
        "arguments": { "sqlQuery": "SELECT firstname, ssn, compensation FROM employee" }
      }
    }
  }
  ```

  `allow = true` — the `hr` group is exempt.

  ## Composition

  This policy is single-purpose. Curated companions for the NetSuite data plane:

  - **`redact-pii-egress` (egress)** — redact SSN/TIN, IBAN, and bank-account-shaped strings from
    responses: the defense-in-depth backstop for HR data that reaches the agent through a table or
    column name this policy does not pattern-match, or through `ns_getRecord` / `ns_runReport`.
  - **`cap-bulk-export` / bulk-exfil throttle (ingress)** — clamp `pageSize` and require a bounded
    SuiteQL query so a single call cannot sweep the whole `employee` table even for an HR caller.
  - **`default-deny-unknown-tools` (ingress)** — allowlist the audited `ns_*` standard tools so a
    custom SuiteScript tool on the `/v1/all` endpoint cannot introduce an uninspected data path.

  ## Known limitations

  - **Placeholder group name.** The exempt group is `hr` — a placeholder. Replace `hr` with your
    IdP's real HR group-claim value at import time (edit `hr_group` in the Rego). Group names are
    placeholders — replace `hr` with your IdP's group name at import time.
  - **Wire-level SQL inspection.** Detection matches the literal token at an identifier boundary in
    the `sqlQuery` text. A caller who obfuscates the identifier — building it from concatenated
    string literals, aliasing the `employee` table behind a non-HR-named view, or referencing it
    through dynamic SQL — references the fenced data without the contiguous token ever appearing, so
    the fence does not fire. This is a fundamental limit of inspecting SQL on the wire; keep the
    egress redaction backstop in place and treat this as one layer, not the sole control.
  - **Convention-dependent tokens.** The token list mirrors NetSuite's standard HR/payroll record
    and column names. A regulated column under a non-standard name (a custom field like
    `custentity_pay_band`) is **not** matched — add its token to `hr_payroll_patterns` if your
    account uses custom naming.
  - **`ns_runSavedSearch` identifier field is unverified.** Oracle does not publish the identifier
    argument name, so the policy scans **all** top-level string arguments for an `hr`/`payroll`
    token. This over-blocks: a saved search whose filter value (not identifier) happens to contain
    "hr" or "payroll" is denied for non-HR callers. This is the fail-safe bias for a deny fence;
    confirm the real identifier field against a live connector and narrow the check if the
    over-blocking is disruptive. The policy cannot see which underlying tables a saved search reads,
    so a payroll-bearing saved search with an innocuous name (`customsearch123`) is **not** fenced —
    rely on the egress backstop for that residual.
  - **`ns_runReport` and `ns_getRecord` are not fenced.** They reach HR data too but are out of
    scope for this policy (one policy, one job). Fence them with the companion policies above.
  - **`groups` claim must be an array of strings.** A string-valued or otherwise malformed claim
    fails closed (the `hr` exemption is not granted). If your IdP emits groups under a different
    claim name, update `caller_groups` in the Rego.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - netsuite
industries: []
bundles:
  - gdpr-ccpa
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package netsuite.ingress.fence_hr_payroll_suiteql

# Deny-by-default (standards §6). The pass-through allow rules below permit
# every call this policy does not fence; only HR/payroll references on the two
# fenced tools, by a caller outside the `hr` group, are denied.
default allow := false

# ---------------------------------------------------------------------------
# Exempt group — PLACEHOLDER. Replace `hr` with the tenant's IdP HR group at
# import time.
hr_group := "hr"

# ---------------------------------------------------------------------------
# Identity — read groups via object.get chains so a missing subject/claims/
# groups fails closed (no group -> not exempt from the fence).
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# True when the caller's groups claim (an array of strings) contains the HR
# group. A malformed (non-array) claim yields no iterations -> fails closed.
caller_is_hr if {
    some g in caller_groups
    lower(g) == lower(hr_group)
}

# ---------------------------------------------------------------------------
# Tool matching — the gateway prefixes the configured server name, so match on
# the `ns_*` suffix, case-insensitively.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

is_suiteql_tool if {
    endswith(tool_name, "ns_runcustomsuiteql")
}

is_savedsearch_tool if {
    endswith(tool_name, "ns_runsavedsearch")
}

# ---------------------------------------------------------------------------
# Arguments. The DTwo PARC schema surfaces tool arguments under
# `input.payload.args`; the NetSuite landscape note calls the same object
# `arguments`. For a deny-fence the fail-safe choice is to scan BOTH: merge the
# two containers (with `arguments` winning on conflict) so a sqlQuery delivered
# under either key is inspected. `as_object` coerces a null / scalar container
# to {} so `object.union` cannot type-error and silently disable the fence.
as_object(x) := x if is_object(x)

as_object(x) := {} if not is_object(x)

payload := object.get(input, "payload", {})

arguments := object.union(
    as_object(object.get(payload, "args", {})),
    as_object(object.get(payload, "arguments", {})),
)

sql_query := object.get(arguments, "sqlQuery", "")

# ---------------------------------------------------------------------------
# HR/payroll patterns for the SuiteQL text. Each pattern is anchored at an
# identifier boundary (`\b`, i.e. start-of-string, whitespace, `.`, `(`, comma,
# quote) so the token matches a real table/column reference, not a substring
# buried inside an unrelated identifier. All are case-insensitive.
hr_payroll_patterns := [
    `(?i)\bemployee`,             # employee master record (SSN/TIN, comp) + employeeid etc.
    `(?i)\bpayroll`,              # payroll, payrolls, and payrollitem (prefix match)
    `(?i)\bpaycheck`,             # paycheck + paycheckjournal payroll txn records (prefix match)
    `(?i)\bcompensation`,         # compensation records/columns
    `(?i)\bsalary`,               # salary columns
    `(?i)\bssn\b`,                # social security number column
    `(?i)\bsocialsecuritynumber\b`, # spelled-out SSN column
    `(?i)\btin\b`,                # taxpayer identification number column
    `(?i)\btaxid`,                # taxid / taxidnum / taxidentifier columns
]

# True when the SuiteQL query text references any fenced HR/payroll token.
sql_matches_hr_payroll if {
    some p in hr_payroll_patterns
    regex.match(p, sql_query)
}

# ---------------------------------------------------------------------------
# Saved-search identifier check. Oracle does not publish the identifier field
# name, so scan every top-level string argument (fail-safe over-block).
# `payroll` is a distinctive token, matched as a bare case-insensitive substring
# so plural / suffixed / concatenated forms (`payrolls`, `payrolldata`,
# `hrpayroll`) cannot slip the fence — same coverage as the SuiteQL `\bpayroll`
# prefix. `hr` is a 2-char token, so it requires a non-alphanumeric boundary on
# both sides (start/end or `_`, `-`, space) to fire: `customsearch_hr` and
# `hr_report` match, but `threshold` / `href` / `chrome` (embedded "hr") do not.
savedsearch_id_pattern := `(?i)(payroll|(^|[^a-z0-9])hr([^a-z0-9]|$))`

savedsearch_matches_hr_payroll if {
    some _, v in arguments
    is_string(v)
    regex.match(savedsearch_id_pattern, v)
}

# ---------------------------------------------------------------------------
# Violations — fenced tool + sensitive reference + caller not in the HR group.
suiteql_violation if {
    is_suiteql_tool
    sql_matches_hr_payroll
    not caller_is_hr
}

savedsearch_violation if {
    is_savedsearch_tool
    savedsearch_matches_hr_payroll
    not caller_is_hr
}

# ---------------------------------------------------------------------------
# Allow rules.

# Any tool this policy does not fence passes through untouched.
allow if {
    not is_suiteql_tool
    not is_savedsearch_tool
}

# A fenced SuiteQL call with no violation (HR caller, or no HR/payroll tokens).
allow if {
    is_suiteql_tool
    not suiteql_violation
}

# A fenced saved-search call with no violation.
allow if {
    is_savedsearch_tool
    not savedsearch_violation
}

# ---------------------------------------------------------------------------
# Deny reasons.

reasons contains msg if {
    suiteql_violation
    msg := sprintf("This SuiteQL query references HR or payroll data (employee, payroll, paycheck, compensation, salary, or SSN/TIN columns), restricted to the '%s' IdP group. Request only the non-HR columns you need, or ask an HR-authorized user to run it. Contact InfoSec if this fence is wrong.", [hr_group])
}

reasons contains msg if {
    savedsearch_violation
    msg := sprintf("This saved search targets HR or payroll data, restricted to the '%s' IdP group. Ask an HR-authorized user to run it, or contact InfoSec if this fence is wrong.", [hr_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
