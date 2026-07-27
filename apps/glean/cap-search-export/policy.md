---
name: Cap Glean Bulk Search Export
tags:
  - glean
  - cap-bulk-export
  - data-minimisation
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # glean / cap-search-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `glean.ingress.cap_search_export`

  ## What it does

  Clamps the bulk-export parameters on Glean `search` calls before they reach
  the Glean MCP server, so a single agent request cannot pull an entire indexed
  datasource in one sweep. Two rewrites are applied to `search` arguments:

  - **`num_results` ceiling** — when the requested `num_results` exceeds the
    configured ceiling (50 in this policy; Glean permits up to 500), it is
    lowered to the ceiling. The request is **rewritten, not denied**, so the
    search still runs — just at a bounded page size. This enforces
    minimum-necessary retrieval while keeping the search useful.
  - **`exhaustive` strip** — when `exhaustive` is set to `true` it is rewritten
    to `false`, neutralising Glean's full-scan sweep. `exhaustive:true` combined
    with a high `num_results` is the bulk-export path the Glean landscape note
    flags across every indexed system (Drive, Confluence, Slack, Jira, Gmail,
    GitHub, Salesforce, Gong, HR…), because one Glean call fans out across
    everything the caller can see.

  Every field is read with `object.get(input.payload.args, ...)`, so a
  **missing** `num_results` or `exhaustive` is treated as unset and **left
  alone** — the policy never injects a value, it only lowers an over-broad one.
  A `search` call that requests `num_results` at or below the ceiling and does
  not set `exhaustive:true` passes through completely untouched.

  The policy inspects only `search`. It does **not** constrain `chat` (which
  takes free text with no filterable retrieval bound — egress inspection is the
  only lever there) or any other Glean tool.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by bounding how much indexed corporate data any single agent
    `search` can move out of Glean in one call.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard: agents retrieve result sets sized to the task rather than the
    500-record maximum the API permits, and cannot trigger an exhaustive scan
    of PHI-bearing sources.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel: the query is
    minimised *before* it reaches Glean; **Art. 5(1)(d)** — a bounded result set
    reduces the accuracy/blast-radius surface of downstream processing.
  - **CCPA 11 CCR §7002** — supports proportionality: retrieval of personal
    information stays proportionate to the disclosed purpose rather than
    defaulting to an exhaustive bulk sweep.

  ## Why ingress

  The over-broad request itself is the problem. Once Glean has fanned out and
  returned 500 records (or an exhaustive scan), an egress policy can only mask
  fields — the volume has already been retrieved, logged, and counted against
  the caller's access. Rewriting `num_results` and `exhaustive` at ingress
  enforces minimisation before the query executes, which is the only place the
  result *count* can be controlled.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `glean-search`, `glean-mcp-search`), so matching is by case-insensitive
  suffix to stay portable. The Glean remote server's search tool is the bare
  name `search`, so this policy matches:

  - `search` (unprefixed), or
  - any name ending in `-search` (the gateway's `<server>-<tool>` form)

  This deliberately does **not** match the other Glean read tools whose names
  end in `_search` — `employee_search`, `code_search`, `gmail_search`,
  `outlook_search`, and the deprecated local server's `company_search` /
  `people_profile_search`. Those are governed by other policies (datasource
  fencing, mailbox restriction, transcript gating). Verify the exact name your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  `search(query, app, type, owner, from, channel, updated, after, before,
  sort_by_recency, exhaustive, num_results, dynamic_search_result_filters,
  cursor)` — structured params (verified from Glean's admin docs and tool
  guides). This policy reads only `num_results` (numeric, up to 500) and
  `exhaustive` (boolean). All other arguments are preserved unchanged by the
  rewrite via `object.union`.

  ## Examples

  ### Passed through unchanged

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-search", "type": "tool" },
      "payload": {
        "name": "glean-search",
        "args": { "query": "q3 roadmap", "app": "confluence", "num_results": 25 }
      }
    }
  }
  ```

  `allow = true`, no transform — the request is already within the ceiling and
  does not set `exhaustive`.

  ### Transformed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-search", "type": "tool" },
      "payload": {
        "name": "glean-search",
        "args": { "query": "", "app": "gdrive", "num_results": 500, "exhaustive": true }
      }
    }
  }
  ```

  `allow = true`, transform rewrites the args to
  `{ "query": "", "app": "gdrive", "num_results": 50, "exhaustive": false }` —
  the ceiling is applied and the exhaustive sweep is disabled, while `query` and
  `app` are preserved.

  ## Composition

  This policy bounds retrieval *volume*; it does not fence *which* datasources a
  search may target, nor mask record *content*. Pair it with:

  - **`apps/glean/fence-datasource-scope`** (ingress) — restricts the `app`
    datasource enum by IdP group so agents cannot search `gong`, `salescloud`,
    or HR sources they should not reach.
  - An **egress PII/PAN redaction** policy on `search` / `read_document` /
    `chat` responses so identifiers in whatever records are returned are masked.
  - A **transcript-gating** policy (PF-21) for `meeting_lookup`, whose own
    `exhaustive` / `extract_transcript` flags are out of scope here.

  ## Known limitations

  - **Ceiling is a per-tenant tuning knob.** 50 is a conservative
    data-minimisation default; Glean permits up to 500. Change `max_num_results`
    in `policy.md` to match your posture at import time.
  - **Per-request caps do not stop patient pagination.** An agent that walks the
    `cursor` page by page can still enumerate a large dataset — it just takes
    more calls at `num_results: 50`. Detecting cursor-driven crawls requires
    cross-request state the policy engine does not have; use gateway audit
    logs / alerting to spot high-frequency paging.
  - **Upper bound only.** The policy lowers an over-large `num_results`; it does
    not rewrite non-positive or otherwise malformed values (e.g. `num_results:
    -1` or `0`). Glean caps `num_results` at 500 server-side, so the worst case
    without this policy is bounded at 500 records — and with `exhaustive` forced
    to `false`, the exhaustive full-scan path (the primary bulk lever) is closed
    regardless. If your Glean deployment treats a non-positive `num_results` as
    "unbounded", add a lower-bound branch to `override_entries`.
  - **Only the `search` tool is covered.** `employee_search`, `code_search`,
    `gmail_search`, `outlook_search`, and `meeting_lookup` also return large
    result sets (and `meeting_lookup` has its own `exhaustive` flag), but they
    are intentionally out of scope — govern them with datasource-fencing,
    mailbox-restriction, and transcript-gating policies. The deprecated local
    server's `company_search` is likewise not matched; write against the remote
    `search` name and add a legacy alias only if a tenant still runs the
    archived `@gleanwork/local-mcp-server` package.
  - **Suffix matching assumes the gateway `<server>-<tool>` hyphen convention.**
    A search tool that surfaces with a non-hyphen separator (e.g. `glean_search`
    ending in `_search`) is not matched. Confirm the exact tool name from
    `tools/list` and extend `is_search_tool` if needed.
  - **No identity-based exemptions.** All callers are clamped equally. If a
    data-ops group legitimately needs full-page or exhaustive reads, add an
    `input.subject.claims`-gated bypass as a separate rule.
  - **Coercion defence is best-effort.** Glean's `num_results` is a number and
    `exhaustive` a boolean. As a bypass defence the policy neutralises the
    likely truthy coercions a lenient server might accept:
    - **`exhaustive`** is disabled when it is boolean `true`, a truthy **string**
      (`"true"`/`"1"`/`"yes"`/`"on"`, case-insensitive **and whitespace-trimmed**,
      so `" true "` and `"TRUE "` are caught too), or any **nonzero
      number** — closing the `exhaustive:1` / `exhaustive:"1"` gap. `false`,
      `0`, `"false"`, absent, whitespace-only, and unrecognised strings are left
      alone. `exhaustive` (unlike `num_results`) has no server-side cap, so a
      padded truthy string is trimmed and neutralised rather than left to a
      safety net — a single character short of the truthy set (e.g. `"t"`,
      `"enabled"`) is still passed through, so keep this policy paired with the
      egress redaction companion.
    - **`num_results`** is lowered when it is a number above the ceiling or a
      numeric **string** that `to_number` parses above it (e.g. `"500"`,
      `"5e2"`). It is **not** lowered for a padded/whitespace string (`"  500 "`),
      a hex/radix string (`"0x1F4"`), or any other string `to_number` rejects —
      those fail safe (left unchanged) and rely on Glean's server-side cap of
      500. Because `num_results` is hard-capped at 500 server-side, the worst
      case for an unhandled string is a bounded 500-record page, not an
      unbounded pull; the higher-risk full-scan lever (`exhaustive`) is closed
      above regardless.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - glean
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package glean.ingress.cap_search_export

# Transform-only policy — never denies, only clamps bulk-export parameters on
# Glean `search` calls.
default allow := true

# Maximum results a single `search` call may request. Glean permits up to 500;
# this conservative data-minimisation default lowers anything above it. Tune to
# your posture at import time.
max_num_results := 50

# --- Tool matching -----------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match case-insensitively by suffix to stay portable. Match ONLY the Glean
# `search` tool: the bare name, or the `<server>-search` form. This excludes the
# sibling read tools whose names end in `_search` (employee_search, code_search,
# gmail_search, outlook_search, company_search) — they are out of scope.

is_search_tool if {
    lower(input.resource.name) == "search"
}

is_search_tool if {
    endswith(lower(input.resource.name), "-search")
}

# --- Argument access (object.get everywhere — fields may be missing) ---------

args := object.get(input.payload, "args", {})

# --- Overrides ---------------------------------------------------------------
# A partial object collecting the argument rewrites that should be applied.
# Each branch is only defined when its field is present and over-broad, so a
# missing num_results / exhaustive contributes nothing (left alone).

# Lower a numeric num_results above the ceiling to the ceiling.
override_entries["num_results"] := max_num_results if {
    n := object.get(args, "num_results", null)
    is_number(n)
    n > max_num_results
}

# Defensive: a numeric *string* num_results above the ceiling (Glean's field is
# numeric, but a lenient server might coerce "500"). to_number on a
# non-numeric string errors and the branch fails safe (leaves the value alone).
override_entries["num_results"] := max_num_results if {
    n := object.get(args, "num_results", null)
    is_string(n)
    to_number(n) > max_num_results
}

# Disable an exhaustive sweep: force exhaustive to false when it is set true.
override_entries["exhaustive"] := false if {
    exhaustive_is_true
}

exhaustive_is_true if {
    object.get(args, "exhaustive", false) == true
}

# Defensive: some servers coerce truthy strings ("true"/"1"/"yes"/"on").
# `exhaustive` is boolean-semantic, so any truthy encoding should be neutralised
# — matching only "true" would leave the equally-common "1"/"yes" coercions open.
# trim_space first, or a lenient server that trims before coercing would let a
# padded " true " / "TRUE " slip past the set membership check (the bare "true"
# is caught, so the padded form is a trivial evasion of this same defence).
exhaustive_is_true if {
    v := object.get(args, "exhaustive", false)
    is_string(v)
    lower(trim_space(v)) in {"true", "1", "yes", "on"}
}

# Defensive: a lenient server may coerce a nonzero number to true. Only true is
# ever intended, so any nonzero numeric exhaustive is treated as the sweep flag
# (0 stays falsy and is left alone).
exhaustive_is_true if {
    v := object.get(args, "exhaustive", false)
    is_number(v)
    v != 0
}

# --- Transform ---------------------------------------------------------------
# Rewrite the args only when there is at least one override to apply, and only
# on the ingress path for the search tool. object.union preserves every other
# argument unchanged.

transform := {"transformed_payload": object.union(args, override_entries)} if {
    input.action == "tool_pre_invoke"
    is_search_tool
    count(override_entries) > 0
}
```
