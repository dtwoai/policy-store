---
name: Fence Gusto Compensation & Payroll Reads
tags:
  - gusto
  - fence-hr-and-credit-scope
  - compensation
  - payroll
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # gusto / fence-comp-payroll-reads

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on the fenced read tools, allow otherwise
  **Package:** `gusto.ingress.fence_comp_payroll_reads`

  ## What it does

  Denies the highest-sensitivity Gusto read tools unless the caller's IdP-asserted
  groups include the placeholder group `hr-payroll-admins`. Every other Gusto tool
  (company/org lookups, employee directory reads, time tracking, utility tools)
  passes through unchanged.

  The fenced tools cover four need-to-know payroll surfaces:

  - **Salary / compensation:** `get_compensation`, `list_job_compensations`
  - **Full pay register:** `get_payroll`, `list_company_payrolls`
  - **Contractor financials:** `list_company_contractor_payments`, `get_contractor_payment`,
    `list_company_contractor_payment_groups`, `get_contractor_payment_group`
  - **Employment-action reads:** `list_employee_terminations`, `get_employee_rehire`

  Group membership is read with `object.get(input.subject, "claims", {})` and the
  policy **fails closed**: a caller with no `groups` claim (or no `subject` at all) is
  treated as not exempt, so the read is denied. This narrows the agent channel to
  need-to-know payroll data (least-privilege logical access) without touching the
  web-UI or native-API paths, which the gateway cannot see.

  ## Why ingress and not egress

  These tools return regulated data on the way back, but the cheapest and most robust
  control is to stop the call before it reaches Gusto: an ingress deny means the
  salary/pay-register data is never fetched over the agent channel, so there is no
  response to redact and no partial-leak window. Egress redaction of a pay register is
  brittle (many nested numeric fields) and still incurs the upstream read.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets by fencing
    the most sensitive payroll reads behind an IdP-group check; **CC6.3** — supports
    role-based access / least privilege by restricting compensation and pay-register
    reads to a dedicated HR-payroll group.
  - **SOX — ITGC access to programs & data** — supports least-privilege access to
    financial systems (the payroll register is financial data feeding compensation
    expense) by gating the pay-register and contractor-payment reads to an authorized
    group; **SoD (COSO Principle 10)** — keeps broad agent identities out of the
    compensation surface.
  - **GDPR Art. 5(1)(b)** — supports purpose limitation by keeping compensation and
    employment-action data on a need-to-know footing on the agent channel; **Art. 22 /
    CCPA 11 CCR §7200 (ADMT)** — supports scoping the employment data (compensation,
    terminations, rehire) that could feed automated decision-making so it is reachable
    only by the HR-payroll role. (This is the Annex III employment-data fencing pattern
    for the MCP path.)

  ## Tool name matching

  Matching is case-insensitive on `lower(input.resource.name)` using `endswith` against
  the verified official snake_case tool names (from the Gusto MCP docs). The gateway
  prefixes tool names with the configured MCP server name (e.g.
  `gusto-mcp-get_payroll`), and that prefix is not standardized — suffix matching keeps
  the policy portable and survives a server prefix that itself contains `gusto`
  mid-name. Because Gusto's official server puts no vendor prefix on most tools and only
  carries `gusto` mid-name on two unrelated tools (`list_gusto_companies`,
  `get_gusto_employee`), anchoring on the full official suffix is the safe choice.

  Fenced suffixes: `get_compensation`, `list_job_compensations`, `get_payroll`,
  `list_company_payrolls`, `list_company_contractor_payments`, `get_contractor_payment`,
  `list_company_contractor_payment_groups`, `get_contractor_payment_group`,
  `list_employee_terminations`, `get_employee_rehire`.

  ## Argument shape

  This policy inspects only the tool **name** and the caller's identity claims — it does
  not read `input.payload.args`, so it is immune to argument-key drift. Add companion
  policies (see below) if you also need to clamp `per`/`include` on the list tools it
  does allow.

  ## Identity

  Uses `input.subject.claims.groups`, read via `object.get` chains so a missing claim
  fails closed. The required group name `hr-payroll-admins` is a **placeholder** — see
  Known limitations.

  ## Examples

  ### Allowed — non-fenced read

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-list_company_employees", "type": "tool" },
      "payload": { "name": "gusto-mcp-list_company_employees", "args": { "per": 25 } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — fenced read by an HR-payroll admin

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-get_payroll", "type": "tool" },
      "payload": { "name": "gusto-mcp-get_payroll", "args": { "payroll_uuid": "abc" } },
      "subject": { "claims": { "groups": ["hr-payroll-admins"] } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — fenced read, no HR-payroll group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-get_compensation", "type": "tool" },
      "payload": { "name": "gusto-mcp-get_compensation", "args": { "employee_uuid": "e1" } },
      "subject": { "claims": { "groups": ["engineering"] } }
    }
  }
  ```

  `allow = false`, `reason` names the `hr-payroll-admins` group.

  ## Composition

  Single-purpose. Useful companions on a Gusto pipeline:

  - **`cap-bulk-export` (PF-08)** — clamp `per` and strip `include=custom_fields` on the
    directory list tools this policy still allows, throttling full-roster exfiltration.
  - **An egress financial-identifier redactor (PF-02)** — mask SSN/bank/routing patterns
    from any Gusto-server response, covering community/aggregator servers that surface
    bank data the official server does not.
  - **`deny-writes` (PF-12/PF-09)** — deny `create_*`/`update_*`/`delete_*` suffixes; a
    no-op on today's read-only official server but a guard against StackOne-style
    aggregators.

  ## Known limitations

  - **Group names are placeholders — replace `hr-payroll-admins` with your IdP's group
    name at import time.** The policy will deny every fenced read until the group name
    matches what your IdP actually emits in the `groups` claim.
  - **`groups` claim shape.** The policy expects `groups` to be a JSON array of strings
    (per the DTwo identity schema). If your IdP emits group membership as a
    space-separated string or under a namespaced claim (e.g.
    `https://acme.com/groups`), no member ever matches and every fenced read is denied
    (fail-closed) — adjust the claim path before import.
  - **Official-server names only.** Suffixes are the verified official snake_case names.
    Community servers use kebab-case (`get-payrolls`, `get-payroll`) and StackOne uses
    aggregated `hris_*`-style names (unverified); this policy does **not** match those.
    Wire per-server pipelines with a matching name list if you front Gusto through a
    non-official server.
  - **Suffix matching breadth (false positives).** `endswith` on a bare suffix like
    `get_payroll` would also match a hypothetical unrelated tool whose name ends in that
    string. The official Gusto inventory has no such collision today; re-check if you add
    servers.
  - **Suffix-extension evasion (false negatives).** `endswith` fences a tool only when a
    listed name is the *tail* of the tool name. A server that appends text after a fenced
    base — a versioned or renamed variant such as `get_payroll_v2` or
    `get_compensation_history`, or an aggregator verb like `get_employee_compensation` —
    is **not** fenced and passes through, exposing equivalent salary/pay data. The
    official Gusto inventory has no such name today, but re-audit the tool list whenever
    you add or upgrade a Gusto MCP server, and pin an explicit per-server name list for
    community/aggregator servers rather than relying on the official suffixes.
    Trailing whitespace or a trailing newline (`get_payroll\n`) is a degenerate case of
    the same class — it is *appended* text, so `endswith` no longer matches and the read
    passes through. This is not exploitable on a real gateway (the MCP router only
    dispatches a call whose name exactly matches a registered tool, so a
    whitespace-padded name never reaches the upstream `get_payroll`), but the isolated
    tests lock the behavior so a future refactor cannot regress it silently.
  - **Argument shapes unverified.** Entity-ID args shown in examples (`payroll_uuid`,
    `employee_uuid`, etc.) mirror the Gusto Embedded API but were not individually
    verified from the official tool schemas; this policy does not depend on them.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - gusto
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gusto.ingress.fence_comp_payroll_reads

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Highest-sensitivity Gusto read tools, matched by suffix. These are the verified
# official snake_case names from the Gusto MCP docs. Grouped by surface:
#   salary/compensation, full pay register, contractor financials, employment actions.
fenced_read_tools := [
    "get_compensation",
    "list_job_compensations",
    "get_payroll",
    "list_company_payrolls",
    "list_company_contractor_payments",
    "get_contractor_payment",
    "list_company_contractor_payment_groups",
    "get_contractor_payment_group",
    "list_employee_terminations",
    "get_employee_rehire",
]

# Placeholder IdP group; replace with your tenant's group name at import time.
required_group := "hr-payroll-admins"

# True when the request targets one of the fenced high-sensitivity reads. Matching is
# case-insensitive and by suffix so it survives the gateway's server-name prefix
# (including a prefix that contains `gusto` mid-name).
is_fenced_read if {
    name := lower(input.resource.name)
    some tool in fenced_read_tools
    endswith(name, tool)
}

# Caller's IdP-asserted groups. Read via object.get chains so a missing `subject`,
# missing `claims`, or missing `groups` yields an empty list rather than erroring —
# the exemption below then never fires, so the read fails closed (denied).
caller_groups := object.get(object.get(input.subject, "claims", {}), "groups", [])

is_exempt if {
    some g in caller_groups
    g == required_group
}

# Allow any tool that is not a fenced high-sensitivity read.
allow if {
    not is_fenced_read
}

# Allow a fenced read only for callers in the HR-payroll group.
allow if {
    is_fenced_read
    is_exempt
}

reasons contains "This Gusto tool exposes compensation, payroll, or employment-action data and is limited to members of the 'hr-payroll-admins' group. Route salary and pay-register questions through an HR-scoped pipeline instead. If your role should already carry this access, ask your IdP administrator to add you to the 'hr-payroll-admins' group." if {
    is_fenced_read
    not is_exempt
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
