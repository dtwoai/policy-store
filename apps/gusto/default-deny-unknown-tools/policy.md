---
name: Default-Deny Unknown Gusto Tools
tags:
  - gusto
  - default-deny-unknown-tools
  - allowlist
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # gusto / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — only tool names on the pinned allowlist pass
  **Package:** `gusto.ingress.default_deny_unknown_tools`

  ## What it does

  Pins an allowlist of the **36 official Gusto MCP tool names** and allows a call
  only when `lower(input.resource.name)` is an exact member of that list.
  Everything else is denied before it reaches the Gusto server and surfaced as a
  gateway event — the drift signal that flags a new, renamed, or unrecognized
  tool the moment it first appears.

  `allow` defaults to `false`, so an unrecognized, missing, empty, non-string, or
  non-ASCII tool name matches nothing and fails **closed**. This is the outer
  boundary for the Gusto pipeline: the default state of any tool the tenant has
  not enumerated is "inaccessible."

  Gusto is a payroll system — **nearly every tool returns regulated data** (PII,
  salaries, home addresses, contractor payments; on non-official servers, bank
  accounts, pay stubs, and tax IDs). The official vendor server is strictly
  read-only, so there is no destructive-write or raw-SQL surface here; matching
  is therefore about *which reads the agent can reach*, and about catching the
  three real ways the Gusto tool surface diverges from the audited official set:

  - **Aggregator servers (StackOne).** A tenant wiring Gusto through StackOne
    (72 actions, including create/update/delete and payroll deletion) exposes a
    write surface the official server does not have. StackOne's unified action
    IDs are **not published verbatim** and could not be verified (they typically
    follow an `hris_*` shape — unverified for Gusto specifically). None of them
    match an official name, so every one is denied until explicitly audited and
    re-pinned.
  - **Community servers (kebab-case + wider read surface).** The
    `Savinda96/gusto-mcp` community server names its tools in **kebab-case**
    (`get-all-employees`, `get-payrolls`, `get-company-details` — verified from
    source), which never match the official `snake_case` names. Other community
    wrappers surface deeper sensitive reads than the official server (company /
    contractor **bank accounts**, **pay stubs**, federal/state **tax IDs**,
    garnishment agencies). All are denied by default.
  - **Renamed or newly added upstream tools.** Any official tool that is renamed,
    versioned, or added upstream stops matching an allowlisted name and is denied
    until it is re-audited — the default-deny-by-design posture.

  ## Pin the allowlist to YOUR pipeline at import time

  The shipped `allowed_tool_names` array is the **36 bare official Gusto names**,
  verified verbatim from [docs.gusto.com](https://docs.gusto.com/app-integrations/docs/mcp).
  Matching is **exact** (no suffix, no prefix stripping) — this is deliberate,
  because exact matching is what gives the strong drift guarantee: any prefix
  change, rename, kebab-case spelling, or aggregator action ID is a non-member
  and is denied.

  Exact matching has one direct consequence you **must** handle at import time:
  the DTwo gateway prepends the configured MCP server name to every tool
  (`<server-name>-<tool-name>`), so on a prefixed deployment the gateway sends
  `gusto-mcp-get_payroll`, not the bare `get_payroll` — and the bare starter list
  will deny it. **Pin the array to the exact strings your gateway sends**: prefix
  each entry with your server name (verify it with the dump-input debug
  technique), or, if you swap the official server for a community/aggregator
  server, replace the list with that server's audited tool names. The allowlist
  is **per-pipeline, pinned to the specific Gusto implementation in use** — when
  you change servers, you re-pin. Until you do, the swapped-in tools are denied
  (which is the point).

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: the
    agent channel can only reach Gusto tools that were explicitly reviewed and
    enumerated.
  - **SOC 2 CC6.6** — supports boundary protection: upstream-added, renamed, or
    server-swapped tools (aggregator write actions, community kebab-case reads,
    deeper bank-account/tax-ID reads) do not become reachable through the gateway
    boundary without an explicit allowlist change.
  - **SOC 2 CC6.8** — supports prevention of unauthorized software: tools not on
    the audited list are unauthorized-by-default on the agent path.
  - **SOC 2 CC7.2 / CC7.3** — deny decisions from this policy surface tool drift
    (new/renamed upstream tools, swapped-in aggregator or community surfaces) as
    observable gateway events that feed anomaly monitoring and event evaluation.
  - **GDPR Art. 25** — supports data protection by design and by default on the
    agent channel: the default state of any new Gusto tool is "inaccessible until
    audited," and Gusto tools routinely return personal data (names, dates of
    birth, home addresses, compensation, contractor payments).

  ## Tool name matching

  Official Gusto tool names are **bare `snake_case`** with no vendor prefix on
  most tools — two carry `gusto` mid-name (`list_gusto_companies`,
  `get_gusto_employee`) to disambiguate in multi-connector sessions. Matching is
  case-insensitive (`lower(input.resource.name)`) and **exact** against the
  pinned list. There is intentionally no `endswith`/suffix matching: a suffix
  match would auto-admit a future or renamed tool that merely ends in an
  allowlisted string, silently defeating the drift-detection posture that is the
  whole point of this policy.

  Before matching, the **raw** (pre-lowercase) name must consist only of the
  ASCII set real tool names and gateway prefixes use — `[A-Za-z0-9._-]`. This is
  checked before `lower()` runs, which closes a Unicode case-folding evasion:
  `lower()` folds a handful of non-ASCII code points onto ASCII letters (e.g. the
  Kelvin sign `U+212A` → `k`), and several allowlisted names contain `k`
  (`get_token_info`), so a homoglyph could otherwise fold onto a member. A name
  containing any character outside that ASCII set is denied.

  ## Argument shape

  This policy inspects only the tool **name** (`input.resource.name`); it reads no
  arguments, so it is insensitive to argument-shape differences between the
  official, aggregator, and community servers. A missing `resource` or
  `resource.name` resolves to `""` via `object.get` and matches nothing (deny). A
  **non-string** name (null, number, object, array — a malformed or hostile
  request) is coerced to `""` rather than handed to `lower()`; without that guard
  `lower()` would raise a built-in type error that leaves `allow`/`reason`
  undefined — a deny with no surfaced reason. With the guard it is a clean,
  reasoned deny.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "get_payroll", "type": "tool" },
      "payload": {
        "name": "get_payroll",
        "args": { "company_uuid": "c-123", "payroll_uuid": "p-456" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — community kebab-case name

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "get-all-employees", "type": "tool" },
      "payload": {
        "name": "get-all-employees",
        "args": { "terminated": false }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Gusto tool is not on the audited allowlist (...)"`.

  ## Composition

  This policy is the outer gate — it decides *which* Gusto tools exist for agents.
  Because Gusto exposes no raw-SQL / query surface, there is **no PF-07
  `guard-warehouse-sql` companion** here; PF-28 alone is the drift and
  unknown-tool backstop for this app. Pair it with policies that constrain *how*
  the allowlisted reads are used:

  - An **ingress deny — compensation/payroll reads by IdP group** so salary and
    pay-register tools (`get_compensation`, `list_job_compensations`,
    `get_payroll`, `list_company_payrolls`, `list_company_contractor_payments`)
    are gated to an HR/payroll group even when they are on the allowlist.
  - An **egress redaction policy** on employee/payroll responses so home-address,
    SSN-like, bank-account, and routing-number strings are masked before they
    reach the model — cheap insurance if a tenant later re-pins to a
    community/aggregator server that surfaces bank data.
  - An **ingress anti-bulk-export transform** clamping `per` and stripping
    `include=custom_fields` on `list_company_employees` / `list_company_contractors`
    to throttle full-roster exfiltration.

  ## Known limitations

  - **The starter allowlist is the official server's names, not your gateway's
    strings.** Pinning it to the exact names your gateway sends (server prefix
    included) is a required deployment step, not a tuning step. On a prefixed
    deployment the bare starter list denies every real call until you re-pin.
  - **StackOne aggregator action IDs are unverified.** The landscape note records
    that StackOne's Gusto tool-name strings are not published verbatim and could
    not be verified (they likely follow an `hris_*` shape). This policy does not
    enumerate them by name — it denies them by default because they are not
    official names. If you deliberately adopt StackOne, discover its exact tool
    names with dump-input and pin the ones you audit.
  - **Single-app gate.** This policy denies *everything* not on the list, so it is
    intended for a Gusto-scoped pipeline. If you attach it to a pipeline that also
    fronts other MCP servers, those servers' tools are denied too — attach it to
    the Gusto pipeline, or add the other servers' audited names to the list.
  - **ASCII-only tool names.** Matching requires the raw name to be
    `[A-Za-z0-9._-]`. This is deliberate (it blocks Unicode case-fold and homoglyph
    spoofing), but a deployment whose configured MCP server name contains other
    characters (spaces, `@`, `/`, non-ASCII) would see even its legitimate tools
    denied; rename the server to an ASCII slug, or relax the character class, if
    so.
  - **Name-based trust only.** The policy audits tool *names*, not behavior. A tool
    that keeps an allowlisted name but changes behavior upstream bypasses the
    intent while matching the letter. Re-audit when the upstream server changes.
  - **No identity-based exemptions.** All callers face the same allowlist. If you
    need a platform-admin break-glass group that can call an unaudited tool, add a
    separate `allow if` branch gated on `input.subject.claims` groups.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - gusto
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gusto.ingress.default_deny_unknown_tools

# Deny-by-default: a tool call is allowed only if its name is an EXACT member of
# the audited allowlist below. A missing, empty, non-string, or non-ASCII tool
# name matches nothing and is therefore denied (fail closed).
default allow := false

# The 36 official Gusto MCP tool names — verified verbatim from
# docs.gusto.com/app-integrations/docs/mcp. The official server is READ-ONLY;
# there are no create/update/delete or raw-SQL tools, so this is the complete
# audited surface for the official implementation.
#
# STARTER SET — pin to the exact strings YOUR gateway sends at import time.
# The gateway prepends the configured server name (<server-name>-<tool-name>),
# so on a prefixed deployment you must prefix each entry (e.g. gusto-mcp-get_payroll).
# Matching is EXACT (no suffix, no prefix stripping): this is what makes drift
# detection strong — StackOne aggregator action IDs (unverified, ~hris_*),
# community kebab-case names (get-all-employees, get-payrolls), and any renamed
# or newly added upstream tool are all non-members and are denied until re-pinned.
# Lower-case only.
allowed_tool_names := [
    # Company / org
    "list_gusto_companies",
    "list_company_locations",
    "list_company_departments",
    "get_department",
    "get_location",

    # Employees
    "list_company_employees",
    "get_gusto_employee",
    "list_employee_jobs",
    "get_job",
    "list_job_compensations",
    "get_compensation",
    "list_employee_employment_history",
    "list_employee_terminations",
    "get_employee_rehire",
    "list_employee_custom_fields",
    "list_employee_home_addresses",
    "get_employee_home_address",
    "list_employee_work_addresses",
    "get_employee_work_address",

    # Contractors
    "list_company_contractors",
    "get_contractor",
    "list_company_contractor_payments",
    "get_contractor_payment",
    "list_company_contractor_payment_groups",
    "get_contractor_payment_group",

    # Payroll
    "list_company_payrolls",
    "get_payroll",
    "list_company_pay_schedules",
    "get_pay_schedule",
    "list_company_pay_periods",
    "list_company_pay_schedule_assignments",
    "list_company_earning_types",

    # Time tracking
    "list_company_time_sheets",
    "get_time_sheet",

    # Utility
    "get_token_info",
    "list_company_custom_fields_schema",
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

# Character-class guard on the RAW (pre-lowercase) name. Real Gusto / community
# tool names and gateway <server-name>- prefixes use only ASCII letters, digits,
# underscore, dot, and hyphen. Checking the raw name BEFORE lower() closes a
# Unicode case-folding evasion: lower() folds some non-ASCII code points onto
# ASCII letters (e.g. the Kelvin sign U+212A -> "k"), and allowlisted names such
# as get_token_info contain "k", so a homoglyph could otherwise fold onto a
# member and slip past the default-deny gate despite being a visibly different,
# un-audited name. Guarded by is_string so a non-string name still yields a
# clean, reasoned deny (no built-in type error).
raw_name_is_plain_ascii if {
    is_string(raw_tool_name)
    regex.match(`^[A-Za-z0-9._-]+$`, raw_tool_name)
}

# Allow only when the raw name is plain ASCII AND lowercases to an exact member
# of the audited allowlist. Exact match (no suffix) is intentional — see the
# allowlist comment and the policy description.
allow if {
    raw_name_is_plain_ascii
    some name in allowed_tool_names
    tool_name == name
}

reason := "This Gusto tool is not on the audited allowlist, so the gateway denies it by default and surfaces the call as tool drift. The allowlist pins the 36 read-only official Gusto tool names; anything else — StackOne aggregator write actions, community kebab-case tools (get-all-employees, get-payrolls) with their wider bank-account / pay-stub / tax-ID read surface, or a renamed or newly added upstream tool — is denied until it is re-audited. If this tool is legitimate, ask a gateway admin to review it and, once approved, add its exact name (with your server-name prefix) to the allowlist for this Gusto pipeline." if not allow
```
