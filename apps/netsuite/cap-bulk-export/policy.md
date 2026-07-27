---
name: NetSuite Cap SuiteQL Bulk Export
tags:
  - netsuite
  - cap-bulk-export
  - suiteql
  - data-minimisation
  - ingress
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # netsuite / cap-bulk-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `netsuite.ingress.cap_bulk_export`

  ## What it does

  Instantiates the PF-08 `cap-bulk-export` family as a transform-only ingress
  policy on `ns_runCustomSuiteQL` — the NetSuite MCP tool that runs arbitrary
  read-only SQL over the entire ERP. It reads the request's `pageSize` argument
  and, when that value is **missing or exceeds a configured ceiling** (default
  **100**), rewrites `pageSize` down to the ceiling before the call reaches the
  NetSuite AI Connector. All other arguments — `sqlQuery` and `description` —
  pass through unchanged, so the query itself is untouched; only the number of
  rows returned per call is bounded.

  `ns_runCustomSuiteQL` is the single biggest bulk-exfiltration surface on the
  NetSuite server: one query can pull full customer/vendor master data
  (addresses, bank/payment details), employee/HR data, or complete GL/financial
  results. Bounding `pageSize` means a single agent call cannot mass-export a
  whole table in one shot; it must paginate, which is slower, auditable per
  page, and rate-limited.

  The clamp fires in four situations:

  - **Above the ceiling** — a numeric `pageSize` greater than 100 is rewritten
    to 100.
  - **Missing** — when `pageSize` is absent, `object.get(..., "pageSize", 0)`
    yields `0`; the policy injects `pageSize: 100`. This matters because the
    SuiteQL endpoint applies its own server-side default page size when the
    argument is omitted, which can substantially exceed the ceiling.
  - **Non-positive** — an explicit `pageSize` of `0` or a negative number
    (which some SQL layers treat as "unbounded" or fall back to a large default)
    is normalised to 100.
  - **Non-numeric** — a `pageSize` that is present but not a number (e.g. the
    string `"500"`, or `null`) is replaced with 100 as a fail-safe, rather than
    letting the server parse it.

  A numeric `pageSize` already in the range **1–100** passes through untouched.
  The policy never denies (`default allow := true`), so read workflows keep
  functioning — just at a bounded page size. This keeps it single-purpose: it
  only transforms, and leaves *blocking* unbounded queries to a companion deny
  policy (see Composition).

  The **100-row ceiling is a per-tenant constant.** Edit `page_size_ceiling` in
  `policy.md` to match your tenant's data-minimisation standard before import.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by bounding how much ERP data a single agent SuiteQL call can
    move out of NetSuite.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel: the page
    size is minimised *before* the query executes, so the agent retrieves pages
    sized to the task rather than the maximum the API permits; **Art. 5(1)(d)**
    — bounding per-call volume reduces the blast radius of a mass read against
    personal-data tables.
  - **CCPA 11 CCR §7002** — supports proportionality: collection and use of
    personal information stays proportionate to the disclosed purpose rather
    than defaulting to bulk retrieval.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to
    repositories of stored account data: clamping `pageSize` bounds how much a
    single agent SuiteQL query can pull per call, so a programmatic bulk read
    cannot sweep card-adjacent tables in one shot (partial — this caps volume on
    the MCP path; role-based CHD-column restriction is a companion concern).
    **PCI DSS 3.4.2** — supports preventing the copy/relocation of stored account
    data via bulk export by throttling per-call row volume out of NetSuite.

  ## Why ingress

  The over-broad request itself is the problem. Once NetSuite has returned a
  large page, an egress policy can only mask fields — the volume has already
  been fetched, logged in the integration record's Execution Log, and counted
  against API limits. Rewriting `pageSize` at ingress enforces minimisation
  before the query executes, which is the only place the row *count* can be
  controlled.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `netsuite-mcp-ns_runCustomSuiteQL`), so matching is by case-insensitive
  **suffix** to stay portable across deployments. Covered:

  - `ns_runCustomSuiteQL` — official NetSuite MCP Standard Tools SuiteApp
    (verified from Oracle docs), and the `dsvantien/netsuite-mcp-server`
    community proxy, which exposes identical `ns_*` tool names and argument
    shapes.

  Verify the exact name your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  `ns_runCustomSuiteQL` takes `{ sqlQuery: string (required), description?:
  string, pageSize?: number }` (verified from Oracle docs). Only `pageSize` is
  rewritten; `sqlQuery` and `description` are preserved exactly via
  `object.union`.

  **Argument-envelope key.** The DTwo PARC input schema surfaces tool arguments
  under `input.payload.args`, and this policy reads that key. The NetSuite
  landscape note refers to the same object as `input.payload.arguments`; to be
  safe across both conventions the policy resolves the argument object from
  `args` first and falls back to `arguments`. Confirm which key your gateway
  actually sends with the dump-input technique — if it differs from both, the
  clamp will not fire (fail-open). See Known limitations. A `null` or
  non-object envelope (e.g. `"args": null`) is coerced to `{}` so it still
  clamps to the ceiling rather than failing open.

  ## Examples

  ### Passed through unchanged

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_runCustomSuiteQL", "type": "tool" },
      "payload": {
        "name": "netsuite-mcp-ns_runCustomSuiteQL",
        "args": {
          "sqlQuery": "SELECT id, companyName FROM customer WHERE id = 42",
          "pageSize": 50
        }
      }
    }
  }
  ```

  `allow = true`, no transform — the requested page size is already within the
  ceiling.

  ### Transformed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "netsuite-mcp-ns_runCustomSuiteQL", "type": "tool" },
      "payload": {
        "name": "netsuite-mcp-ns_runCustomSuiteQL",
        "args": {
          "sqlQuery": "SELECT * FROM customer",
          "description": "pull all customers",
          "pageSize": 5000
        }
      }
    }
  }
  ```

  `allow = true`, transform rewrites the args to
  `{ "sqlQuery": "SELECT * FROM customer", "description": "pull all customers",
  "pageSize": 100 }`. A call with no `pageSize` at all gets `pageSize: 100`
  injected the same way.

  ## Composition

  This policy bounds per-call *volume* by clamping; it deliberately does **not**
  block. For environments that prefer a hard stop over silent clamping, pair or
  replace it with:

  - **A companion SuiteQL guard (PF-07 `guard-warehouse-sql` family for
    NetSuite):** a `default allow := false` ingress policy that *denies*
    `ns_runCustomSuiteQL` queries whose `sqlQuery` lacks a `WHERE` clause or a
    row-limit construct (`ROWNUM`, `FETCH FIRST … ROWS ONLY`), so an unbounded
    full-table scan is rejected outright rather than trimmed to 100 rows.
  - **An egress financial-PII redaction policy (PF-02 family)** on
    `ns_runCustomSuiteQL` / `ns_getRecord` responses, so SSN/TIN, IBAN, and
    bank-account-shaped strings in whatever rows are returned are masked before
    they reach the agent context.
  - **A SuiteQL HR/payroll scope guard** that denies queries referencing
    `employee` / `payroll` / `compensation` tables outside an HR group.

  Keep these as independent single-purpose policies so each is testable on its
  own.

  ## Known limitations

  - **Per-request caps do not stop patient pagination.** An agent that walks the
    result cursor page by page can still enumerate a whole table — it just takes
    more calls at `pageSize: 100`. Detecting cursor-driven crawls requires
    cross-request state the policy engine does not have; use the gateway audit
    log / alerting and the companion deny policy to catch unbounded queries.
  - **Only `pageSize` is clamped, not the query.** A `SELECT *` with no `WHERE`
    still runs — it just returns 100 rows per page instead of the server
    default. The row *content* and the query *breadth* are out of scope here by
    design; that is the companion deny policy's job (see Composition).
  - **Argument-envelope key is convention-dependent.** The policy reads
    `input.payload.args` (PARC schema) and falls back to `input.payload.arguments`
    (the NetSuite landscape-note convention). If your gateway surfaces SuiteQL
    arguments under some other key, the clamp fails open — verify with
    dump-input and adjust `raw_args` accordingly.
  - **Other SuiteQL implementations are not covered.** `glints-dev/mcp-netsuite`
    exposes `netsuite_run_suiteql` with a different argument shape (`Limit`, not
    `pageSize`), and the ChatFin `get-*` tools use a `Limit` parameter — neither
    matches the `ns_runCustomSuiteQL` suffix or the `pageSize` key, so this
    policy does not clamp them. Author a per-server variant keyed to those
    names/keys if your gateway fronts them.
  - **Sibling bulk-read routes reach the same data uncapped.** This policy caps
    only `ns_runCustomSuiteQL`. The other standard NetSuite bulk-read surfaces —
    `ns_runSavedSearch` and `ns_runReport`, which return the same
    customer/vendor/employee/GL data through pre-built views — do **not** match
    the `ns_runcustomsuiteql` suffix, so a large read through them passes through
    unclamped. Their page/limit argument names are unpublished (the landscape
    note marks them **unverified**), so they cannot be capped by the same
    `pageSize` key even if matched. Likewise, an account-specific custom
    SuiteScript tool on the `/services/mcp/v1/all` endpoint can run SuiteQL under
    an arbitrary developer-chosen name (no forced `ns_` prefix) and will not match
    the suffix. Pair this policy with a saved-search/report throttle keyed to
    those tools, and — on `/v1/all` — a PF-28 `default-deny-unknown-tools` policy
    so any unrecognised, SuiteQL-capable tool must be allow-listed before an agent
    can call it. This policy is deliberately single-purpose (clamp SuiteQL page
    size) and does not attempt to enumerate every bulk-read tool.
  - **`pageSize` is the only unverified-default assumption.** The clamp assumes
    the server's own omitted-`pageSize` default can exceed the ceiling; if your
    account is configured with a small server-side default, injecting 100 on a
    missing value is still a safe upper bound, never an increase below your
    intent — but confirm the server default if exact page sizing matters.
  - **Only the exact `pageSize` key is clamped, and alias keys are never
    removed.** The clamp reads and rewrites the camelCase `pageSize` key (the
    sole page-size argument verified in the NetSuite landscape note). A request
    that carries the page size *only* under an alternate-case or alias key
    (`PageSize`, `pagesize`, `page_size`) reads `pageSize` as absent, so the
    "missing" branch fires and `pageSize: 100` is *injected* — but the alias key
    is still left intact. **More importantly, if a benign in-range `pageSize`
    (1–100) coexists with a large alias key** — e.g. `{"pageSize": 50,
    "PageSize": 5000}` — the clamp condition is not met at all, so **no
    transform fires and nothing is injected**: the large alias passes through
    completely untouched. In either case, a NetSuite endpoint that treats
    argument names case-insensitively or accepts a snake_case alias could honour
    the un-clamped alias value, and pairing a small canonical `pageSize` with a
    large alias is a deliberate way to slip past the clamp. The verified
    official/`dsvantien` schema uses only `pageSize`, so an unknown alias is
    expected to be ignored server-side; if you front a server that accepts
    aliases, extend the clamp to strip/normalise every alias key rather than
    relying on injection.
  - **No identity-based exemptions.** All callers are clamped equally. If a
    finance/data-ops group legitimately needs larger pages, add an
    `input.subject.claims`-gated bypass as a separate `allow`/transform branch.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - netsuite
industries: []
bundles:
  - soc2
  - pci-dss
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package netsuite.ingress.cap_bulk_export

# Transform-only policy — never denies, only clamps the SuiteQL page size.
default allow := true

# Maximum rows a single ns_runCustomSuiteQL call may request per page.
# Per-tenant constant — edit to match your data-minimisation standard.
page_size_ceiling := 100

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match case-insensitively by suffix to stay portable. Covered: the official
# NetSuite MCP Standard Tools SuiteApp tool `ns_runCustomSuiteQL` and the
# dsvantien community proxy, which exposes identical ns_* names/shapes.
# Verify the exact name your gateway sends with the dump-input debug technique.
is_suiteql_tool if {
    endswith(lower(input.resource.name), "ns_runcustomsuiteql")
}

# --- Argument access ---------------------------------------------------------
# The DTwo PARC schema surfaces tool arguments under `input.payload.args`; the
# NetSuite landscape note calls the same object `arguments`. Resolve `args`
# first (real gateway key), then fall back to `arguments` so the clamp works
# under either convention. `object.get` everywhere — every field may be absent.
payload := object.get(input, "payload", {})

# Resolve the argument object: PARC `args` first, NetSuite-note `arguments`
# fallback. Coerce a null / non-object envelope (e.g. `"args": null`) to {} so
# such a request still clamps to the ceiling instead of failing open — a null
# envelope leaves `page_size` undefined, which would otherwise skip the clamp.
resolved_args := object.get(payload, "args", object.get(payload, "arguments", {}))

raw_args := resolved_args if is_object(resolved_args)

raw_args := {} if not is_object(resolved_args)

# Missing `pageSize` reads as 0 (default), which we treat as "clamp to ceiling"
# below — the server would otherwise apply its own large default page size.
page_size := object.get(raw_args, "pageSize", 0)

# --- Clamp conditions --------------------------------------------------------

# A numeric pageSize above the ceiling.
needs_clamp if {
    is_number(page_size)
    page_size > page_size_ceiling
}

# A non-positive numeric pageSize: 0 (also the "missing" default) or negative.
# Some SQL layers treat these as unbounded / fall back to a large page, so a
# non-positive value would otherwise be a fail-open bypass of the ceiling.
needs_clamp if {
    is_number(page_size)
    page_size < 1
}

# A pageSize that is present but not a number (e.g. "500" as a string, or null):
# fail-safe to the ceiling rather than letting the server parse it.
needs_clamp if {
    not is_number(page_size)
}

# --- Transform ---------------------------------------------------------------
# Rewrite (or inject) pageSize on ns_runCustomSuiteQL, preserving sqlQuery and
# description via object.union. The action guard keeps this ingress transform
# from firing on the egress (tool_post_invoke) path.
transform := {"transformed_payload": object.union(raw_args, {"pageSize": page_size_ceiling})} if {
    input.action == "tool_pre_invoke"
    is_suiteql_tool
    needs_clamp
}
```
