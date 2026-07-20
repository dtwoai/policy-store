---
name: Gusto Cap Roster Export
tags:
  - gusto
  - cap-bulk-export
  - pii
  - data-minimisation
  - ingress
  - gdpr-ccpa
  - soc2
publishedAt: 2026-07-12
description: |
  # gusto / cap-roster-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `gusto.ingress.cap_roster_export`

  ## What it does

  Throttles full-roster exfiltration on Gusto's two broad outbound list tools —
  `list_company_employees` and `list_company_contractors` — by rewriting their
  arguments before the call reaches the Gusto MCP server:

  - **Page-size clamp** — the docs-confirmed pagination arg `per` is clamped to a
    maximum of **25**. Any numeric `per` above 25 is rewritten to 25; a
    non-positive `per` (`0` or negative, which some servers treat as
    "unbounded") and a present-but-non-numeric `per` are also normalised to 25.
  - **Custom-field strip** — the docs-confirmed `include=custom_fields`
    expansion is removed from the `include` argument (string or array form), so
    the roster page comes back without the custom PII fields attached.

  Both rewrites apply only to callers whose IdP claims lack the placeholder group
  `hr-payroll-admins`. HR-payroll admins retain full pagination and field
  expansion.

  This is a **transform, not a deny** (`default allow := true`): it rewrites args
  with safe defaults rather than blocking, so ordinary single-employee lookups
  and small roster reads keep working while bulk pulls are curtailed. A call that
  already requests `per` ≤ 25 and does not ask for `custom_fields` passes through
  untouched. Every possibly-missing field is read with `object.get`, so malformed
  or minimal calls pass through rather than erroring.

  ## Why this shape is the risk

  The Gusto landscape note identifies exactly this pattern as the exfiltration
  channel: a broad list tool with a high `per` plus `include=custom_fields` pulls
  the entire employee roster — names, home addresses, custom PII fields — in a
  few calls, which can then leak through any other connector in the same session.
  Because the official Gusto server is read-only, bulk PII egress (not destructive
  writes) is the primary DTwo exposure, and clamping the list surface is the
  cheapest structural control over it.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal of
    information by bounding how many employee/contractor records — and which
    fields — a single agent list call can move out of Gusto.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel: the page size
    and field expansion are minimised *before* the call reaches Gusto, so the
    agent retrieves the roster slice sized to the task rather than the whole
    company plus its custom fields.
  - **CCPA 11 CCR §7002** — supports proportionality: retrieval of employee PII
    (including custom fields) stays proportionate to the disclosed purpose rather
    than defaulting to full-roster export.

  ## Why ingress

  The over-broad request itself is the problem: once Gusto has returned a
  200-row roster with custom fields, an egress policy can only mask fields — the
  volume has already been fetched, logged, and counted against rate limits.
  Rewriting `per` and `include` at ingress enforces minimisation before the query
  executes, which is the only place the record *count* and the *field expansion*
  can be controlled.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `gusto-mcp-list_company_employees`), so matching is by **case-insensitive
  suffix** to stay portable across deployments. Covered names (verified verbatim
  from the official Gusto MCP docs):

  - `list_company_employees`
  - `list_company_contractors`

  Verify the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Argument shape

  - `per` — the docs-confirmed pagination arg on Gusto list tools (alongside
    `page`). Read as a top-level numeric argument. If `per` is **omitted** the
    call passes through unchanged — Gusto's documented default page size is 25,
    already at the cap. If your server defaults to a larger page when `per` is
    absent, extend the policy to inject `per: 25` on absence.
  - `include` — the docs-confirmed field-selection arg; `include=custom_fields`
    is the docs-confirmed expansion this policy strips. The policy handles both
    the comma-separated **string** form (`"custom_fields"`,
    `"jobs,custom_fields"`) and an **array** form (`["custom_fields", "jobs"]`),
    removing only the `custom_fields` token (case-insensitive) and leaving any
    other requested expansions intact.
  - All other arguments (`page`, entity-ID filters, date ranges) are preserved
    unchanged by the rewrite.

  ## Examples

  ### Passed through unchanged

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-list_company_employees", "type": "tool" },
      "subject": { "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "gusto-mcp-list_company_employees",
        "args": { "company_uuid": "co-1", "per": 25, "include": "jobs" }
      }
    }
  }
  ```

  `allow = true`, no transform — `per` is already within the cap and no
  `custom_fields` expansion was requested.

  ### Transformed (non-admin bulk pull)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-list_company_employees", "type": "tool" },
      "subject": { "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "gusto-mcp-list_company_employees",
        "args": { "company_uuid": "co-1", "per": 200, "include": "custom_fields" }
      }
    }
  }
  ```

  `allow = true`, transform rewrites the args to
  `{ "company_uuid": "co-1", "per": 25, "include": "" }` — page size clamped and
  the custom-field expansion stripped.

  ### Exempt (HR-payroll admin)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gusto-mcp-list_company_employees", "type": "tool" },
      "subject": { "claims": { "groups": ["hr-payroll-admins"] } },
      "payload": {
        "name": "gusto-mcp-list_company_employees",
        "args": { "company_uuid": "co-1", "per": 500, "include": "custom_fields" }
      }
    }
  }
  ```

  `allow = true`, no transform — HR-payroll admins keep full pagination and field
  expansion.

  ## Composition

  This policy bounds roster *volume* and strips the *custom-field* expansion on
  the two broad list tools. It is not a complete Gusto guard on its own. Useful
  companions:

  - An ingress **default-deny allowlist** (PF-28) that pins the audited official
    tool names per tenant — this is what covers community kebab-case list tools
    (`get-all-employees`) and any StackOne/aggregator write surfaces that this
    suffix-matching transform does not.
  - An ingress **deny of compensation/payroll reads** by IdP group, and an egress
    **home-address / financial-identifier redaction** policy, so the records that
    *do* come back through the capped page are also content-masked.

  ## Known limitations

  - **Group names are placeholders — replace `hr-payroll-admins` with your IdP's
    group name at import time.** The exemption reads `input.subject.claims.groups`
    (an array). A caller with no claims, no `groups` claim, or a `groups` claim
    that is not an array is treated as **not** an HR-payroll admin and is clamped
    (fail-closed for the exemption). If your IdP emits groups as a
    space-delimited string rather than an array, adapt the `caller_is_hr_payroll_admin`
    helper.
  - **Official names only; community and aggregator servers are not covered.**
    Suffix matching anchors on the official `list_company_*` names. The community
    `Savinda96/gusto-mcp` server uses kebab-case (`get-all-employees`) and
    StackOne uses unified `hris_*`-style names (unverified) — neither matches
    this policy. Cover those surfaces with a per-server default-deny allowlist
    (see Composition), not by widening this transform.
  - **`per` absence is not injected.** If `per` is omitted the call passes
    through; this relies on Gusto's documented default page size being 25. Verify
    your server's default and inject `per: 25` on absence if it is larger.
  - **Argument keys are matched exactly (`per`, `include`, lowercase).** The
    clamp reads the top-level key `per` and the strip reads `include` verbatim —
    the docs-confirmed Gusto arg names. A case-variant key (`Per`, `PER`) or an
    aggregator/community server that names its page-size arg differently
    (`limit`, `maxResults`, `pageSize`) is **not** clamped: an unrecognised key
    is treated as `per` being absent, so the call falls back to the per-absence
    behaviour above (server default page size). This is safe against the official
    server (which uses lowercase `per`) but means the same per-server default
    caveat applies — if you wire Gusto through an aggregator with a different
    pagination arg, extend `per_value` / `covered_tool_suffixes` to that server's
    key, or front it with a default-deny allowlist (see Composition).
  - **`include` argument shape is docs-confirmed but the exact serialization is
    not verbatim.** The policy handles comma-separated string and array forms of
    `include`, and (as of the red-team hardening) also splits each string element
    of the array form on comma, so a token smuggled inside a single comma-joined
    array element (`["jobs,custom_fields"]`) is still stripped. Two residuals
    remain: (a) **only comma is treated as a delimiter** — if your server accepts
    a non-comma separator (semicolon, space), `"jobs;custom_fields"` passes
    through unstripped; (b) a server that nests field selection under a different
    key or non-string structure passes through unstripped. Confirm the live shape
    from `tools/list` and extend `is_custom_fields_token` / the delimiter if
    needed.
  - **Per-request caps do not stop patient pagination.** An agent that walks the
    `page` cursor page by page at `per: 25` can still enumerate the full roster —
    it just takes more calls. Detecting cursor-driven crawls requires
    cross-request state the policy engine does not have; use gateway audit
    logs / alerting to spot high-frequency paging.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - gusto
industries: []
bundles:
  - gdpr-ccpa
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gusto.ingress.cap_roster_export

# Transform-only policy — never denies, only clamps page size and strips the
# custom-field expansion on Gusto's broad roster list tools.
default allow := true

# Maximum records a single non-admin list call may request.
max_per := 25

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match case-insensitively by suffix to stay portable. These are the official
# Gusto MCP list tools (verified verbatim from the Gusto MCP docs). Community
# kebab-case (`get-all-employees`) and aggregator (`hris_*`) list tools are not
# matched here — cover those with a default-deny allowlist. See Known limitations.
covered_tool_suffixes := [
    "list_company_employees",
    "list_company_contractors",
]

is_covered_tool if {
    some suffix in covered_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

# --- Identity exemption ------------------------------------------------------
# HR-payroll admins retain full pagination and field expansion. Missing/empty
# claims fail closed for the exemption (no group -> not exempt -> clamped).
# `hr-payroll-admins` is a placeholder — replace with your IdP group at import.
claims := object.get(object.get(input, "subject", {}), "claims", {})

groups := object.get(claims, "groups", [])

caller_is_hr_payroll_admin if {
    some g in groups
    lower(g) == "hr-payroll-admins"
}

# --- Argument access (object.get everywhere — fields may be missing) ---------

args := object.get(input.payload, "args", {})

# --- Page-size clamp ---------------------------------------------------------

per_value := object.get(args, "per", null)

# Clamp when a numeric `per` exceeds the cap.
needs_per_clamp if {
    is_number(per_value)
    per_value > max_per
}

# Clamp when a numeric `per` is below 1 (0 or negative). Some servers treat a
# non-positive `per` as "unbounded" or fall back to a large default page, so
# `per: 0` / `per: -1` would otherwise be a fail-open bypass of the cap.
needs_per_clamp if {
    is_number(per_value)
    per_value < 1
}

# Clamp when `per` is present but not a number (fail safe: replace an
# unparseable value with the cap rather than letting the server default win).
needs_per_clamp if {
    per_value != null
    not is_number(per_value)
}

default per_patch := {}

per_patch := {"per": max_per} if needs_per_clamp

# --- Custom-field strip ------------------------------------------------------
# `include=custom_fields` is the docs-confirmed expansion we remove. Handle both
# the comma-separated string form and the array form; leave other tokens intact.

raw_include := object.get(args, "include", null)

is_custom_fields_token(tok) if {
    is_string(tok)
    lower(trim_space(tok)) == "custom_fields"
}

# String form contains custom_fields as one of its comma-separated tokens.
include_has_custom_fields if {
    is_string(raw_include)
    some tok in split(raw_include, ",")
    is_custom_fields_token(tok)
}

# Array form contains a custom_fields entry. Each string element is also split
# on comma before matching, so a caller cannot smuggle the token inside a single
# comma-joined element (e.g. ["jobs,custom_fields"]) past the array branch.
include_has_custom_fields if {
    is_array(raw_include)
    some elem in raw_include
    is_string(elem)
    some tok in split(elem, ",")
    is_custom_fields_token(tok)
}

# Rebuild the string include without the custom_fields token (order preserved,
# empty tokens dropped). Result may be "" when custom_fields was the only token.
stripped_include_string := concat(",", [trim_space(tok) |
    some tok in split(raw_include, ",")
    not is_custom_fields_token(tok)
    trim_space(tok) != ""
])

# Rebuild the array include without any custom_fields entries. Each string
# element is split on comma so comma-joined elements are normalised into
# individual tokens and any custom_fields token inside them is dropped; empty
# tokens are removed. (Non-string elements are not expected in `include` and are
# dropped — field selectors are strings.)
stripped_include_array := [trim_space(tok) |
    some elem in raw_include
    is_string(elem)
    some tok in split(elem, ",")
    not is_custom_fields_token(tok)
    trim_space(tok) != ""
]

default include_patch := {}

include_patch := {"include": stripped_include_string} if {
    is_string(raw_include)
    include_has_custom_fields
}

include_patch := {"include": stripped_include_array} if {
    is_array(raw_include)
    include_has_custom_fields
}

# --- Transform ---------------------------------------------------------------
# One combined transform: both the page-size clamp and the custom-field strip
# can apply to the same call, so we union both patches into a single rewrite.

any_change if needs_per_clamp

any_change if include_has_custom_fields

transform := {"transformed_payload": object.union(object.union(args, per_patch), include_patch)} if {
    input.action == "tool_pre_invoke"
    is_covered_tool
    not caller_is_hr_payroll_admin
    any_change
}
```
