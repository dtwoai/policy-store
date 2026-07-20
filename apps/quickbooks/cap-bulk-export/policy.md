---
name: Cap QuickBooks Bulk Search Exports
tags:
  - quickbooks
  - cap-bulk-export
  - bulk-export
  - dlp
  - ingress
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # quickbooks / cap-bulk-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `quickbooks.ingress.cap_bulk_export`

  ## What it does

  Clamps the bulk-read levers on every QuickBooks Online `search_*` tool so an
  agent cannot pull the entire general ledger — or a full customer, vendor, or
  employee list — into its context in a single call. It targets the two knobs the
  landscape note flags as the bulk-exfiltration levers on QBO search: the
  `fetchAll` "give me everything" flag and an oversized `limit`.

  On a `search_*` call (e.g. `search_invoices`, `search_customers`, `search_bills`,
  `search_employees`, `search_accounts`) the policy rewrites the request arguments
  *before* they reach the MCP server:

  - **`fetchAll` is stripped and the limit is pinned to the cap.** When `fetchAll`
    is truthy, it is removed from the criteria object and `limit` is set to the
    ceiling (default **50**). `fetchAll: true` overrides `limit` on the QBO API, so
    removing it and imposing a bounded page is what actually stops the whole-ledger
    pull.
  - **An oversized `limit` is lowered.** When no `fetchAll` is present but `limit`
    is a number above the cap, it is lowered to the cap. This applies both to a
    `limit` *inside* `criteria` (the official advanced-object shape) and to a
    top-level `limit` sibling of `criteria` (the LibreChat shape).
  - **A top-level `fetchAll` sibling of `criteria` is also stripped.** The
    LibreChat shape hoists paging params (`limit`) to the top level, so the same
    fetchAll clamp is applied there: a truthy top-level `fetchAll` is removed and
    the top-level `limit` is pinned to the cap, mirroring the in-`criteria`
    behavior. This closes a bypass where a whole-ledger `fetchAll: true` carried
    as a sibling of `criteria` (rather than inside it) would otherwise pass
    through unclamped.
  - **Smaller explicit limits are left untouched.** A `limit` of 10 stays 10; a
    search with no bulk knobs at all passes through with no transform applied.

  Every non-`search_*` tool — single-record `get_*`, all `create_*` / `update_*` /
  `delete_*` writes, and the whole-company report tools — passes through
  completely unchanged.

  ## Criteria shapes handled

  The QBO `search_*` argument `criteria` arrives in three shapes; the transform
  handles all of them and corrupts none:

  1. **Advanced object** (official server) —
     `{filters, asc, desc, limit, offset, count, fetchAll}`. The `fetchAll` and
     `limit` keys on this object are clamped as described above; `filters`, `asc`,
     `desc`, `offset`, and `count` are preserved untouched.
  2. **Array of clauses** (LibreChat) — `criteria: [{field, value, operator, ...}]`
     with `limit` as a **top-level sibling** of `criteria`. The landscape note
     records LibreChat carrying `limit` alongside `criteria` rather than inside it,
     so the top-level `limit`/`fetchAll` clamp (see "What it does") is what
     actually bounds a LibreChat search. The per-element clamp (`criteria[].limit`,
     per-clause `fetchAll`) is applied defensively as well, so a `limit`/`fetchAll`
     carried inside a clause is also capped/stripped. Non-object array entries are
     left as-is (array length is never changed).
  3. **Bare field map** — `{DisplayName: "Acme"}`. A plain `{field: value}` match
     carries no `limit` / `fetchAll` key, so nothing is clamped and the call passes
     through untouched.

  ## Compliance alignment

  This policy instantiates family **PF-08 (`cap-bulk-export`)** for QuickBooks
  Online.

  - **SOC 2 CC6.7** — supports restricting the transmission, movement, and removal
    of confidential information: bounding page size and disabling `fetchAll` keeps a
    single agent call from lifting the whole ledger or the entire customer/employee
    base out over the MCP path.
  - **PCI DSS 3.4.2 / 7.2.6** — QuickBooks Online can store cardholder data on the
    customer-payment and refund transactions the ledger records. Clamping bulk-read
    levers (`fetchAll`, oversized `limit`) supports restricting the copy/relocation of
    stored payment data through the agent channel (3.4.2) and the least-privilege
    restriction of programmatic queries against repositories of stored cardholder data
    (7.2.6), so a single call cannot relocate the whole transaction set to an
    unmanaged destination (matrix PF-08 → 3.4.2 / 7.2.6).
  - **GDPR Art. 5(1)(c)** — supports data minimisation by preventing the agent from
    reading far more personal and financial data than the task in hand requires.
  - **CCPA/CPRA 11 CCR §7002** — supports the proportionality principle (collection
    and processing limited to what is reasonably necessary) on the agent channel.

  ## Why ingress and transform

  The bulk-read harm is fully determined by the request — the tool name and the
  `criteria` shape are all in `input.payload.args`. Rewriting the arguments at
  ingress means the unbounded query never reaches QuickBooks, so the whole result
  set is never returned to the agent and there is nothing to redact on the way
  back. Because the fix is to *rewrite arguments before the call*, it is an ingress
  transform rather than a deny.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name, so the
  match is on the `search_` verb rather than an exact name. A tool is treated as a
  QBO search when its lowercased name contains `search_` at the start or
  immediately after a non-letter separator — this matches `search_invoices`,
  `quickbooks-search_customers`, `quickbooks-online-mcp-search_bills`, and the like,
  across the official (snake_case) and LibreChat servers, while **not** matching a
  word that merely embeds the substring mid-token (e.g. a hypothetical
  `research_*`).

  The official server's `search_*` names are taken from Intuit's open-source tool
  inventory; the Claude-connector tool names are **not published** and could not be
  verified (see Known limitations). Confirm the exact prefixed names your gateway
  emits with the dump-input debug technique before relying on this in production.

  ## Argument shape

  - `criteria` is read defensively via `object.get(input.payload.args, "criteria", null)`.
    A missing `criteria`, or one reshaped to a string/number, yields no clamp and
    the call passes through.
  - `fetchAll` is treated as set only when it equals `true`; `fetchAll: false` is
    already bounded and is left in place.
  - `limit` is clamped only when it is a **number** above the cap; a non-numeric
    `limit` (string, object) is left untouched — QBO would reject it upstream.

  ## Examples

  ### Clamped — `fetchAll` stripped, limit pinned to the cap

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-search_invoices", "type": "tool" },
      "payload": {
        "name": "quickbooks-search_invoices",
        "args": { "criteria": { "fetchAll": true } }
      }
    }
  }
  ```

  `allow = true`; the transform rewrites `criteria` to `{ "limit": 50 }`.

  ### Clamped — oversized limit lowered, filters preserved

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-search_customers", "type": "tool" },
      "payload": {
        "name": "quickbooks-search_customers",
        "args": {
          "criteria": {
            "filters": [{ "field": "DisplayName", "operator": "LIKE", "value": "A%" }],
            "limit": 500,
            "fetchAll": true
          }
        }
      }
    }
  }
  ```

  `allow = true`; `criteria` becomes
  `{ "filters": [{...}], "limit": 50 }` — `fetchAll` removed, `limit` pinned to 50,
  `filters` intact.

  ### Clamped — top-level `limit` sibling (LibreChat shape)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "quickbooks-search_customers", "type": "tool" },
      "payload": {
        "name": "quickbooks-search_customers",
        "args": {
          "criteria": [{ "field": "Active", "operator": "=", "value": "true" }],
          "limit": 999
        }
      }
    }
  }
  ```

  `allow = true`; the top-level `limit` is lowered to 50, `criteria` untouched.

  ### Passthrough — small explicit limit

  A `search_bills` call with `criteria: { "limit": 25 }` is allowed with no
  transform applied.

  ### Passthrough — non-search tool

  A `get_invoice` or `create_invoice` call is never inspected and passes through
  untouched.

  ## Composition

  Single-purpose. Useful companions on the same gateway:

  - A **role policy** gating the whole-company report tools (P&L, Balance Sheet,
    General Ledger, Trial Balance). Those return the full ledger *by design* and
    take no `criteria` / `limit`, so this policy cannot bound them — restrict them
    by IdP group instead (PF-12 / PF-20).
  - A **PII-redaction egress policy** on `search_employees` / `search_customers`
    output so the (now bounded) rows that do come back have SSN, bank-account, and
    home-address fields masked for callers outside HR/finance.
  - A **money-movement / delete freeze** ingress policy for the write and
    destructive surfaces (PF-06 / PF-09).

  This policy caps how *many* records one search call can pull; the companions
  decide *who* may touch a surface and *what* is returned.

  ## Known limitations

  - **Bounded paging still works.** This raises cost and creates an audit trail; it
    does not make bulk export impossible. An agent can still page through results
    with repeated bounded calls (each clamped to the cap). Pair with rate limiting
    and the audit pipeline for detection.
  - **Report tools are out of scope by design.** Whole-company financial reports
    (P&L, Balance Sheet, General Ledger, Trial Balance) return the full ledger in
    one call and take no `criteria` / `limit`, so there is nothing here to clamp.
    Gate them with a separate role policy — do not rely on this one to bound them.
  - **A limitless search still returns QBO's default page.** The policy clamps a
    `limit` / `fetchAll` that is *present*; it does not *inject* a `limit` onto a
    search that carries neither. A `search_*` call with no `limit` and no `fetchAll`
    passes through untouched and QBO returns its own default page size (which can
    exceed the cap of 50). The whole-ledger lever (`fetchAll`) is still stripped, so
    the residual is a single default-sized page, not the full ledger. If you need a
    hard ceiling on every search, pair this with a role/rate-limit policy or extend
    the transform to inject `limit: cap` when a search carries no bounding knob.
  - **Only a boolean `fetchAll: true` is stripped.** A non-boolean truthy value
    (`"true"`, `1`) is *not* treated as set and passes through unchanged. The
    surveyed servers (Intuit official and LibreChat) are Zod-typed and reject a
    non-boolean `fetchAll` upstream, so this is not a live bypass on them; if you
    front a server that coerces truthy non-booleans, harden `has_fetch_all` to cover
    those forms.
  - **`fetchAll: false` is left in place.** Only a truthy `fetchAll` is stripped; an
    explicit `false` is already bounded and is preserved.
  - **Literal `limit` / `fetchAll` field names.** The clamp acts on any `criteria`
    object carrying those keys. QuickBooks exposes no searchable entity field named
    `limit` or `fetchAll`, so a bare `{field: value}` map cannot collide with them
    in practice; if a future field ever used those names, the clamp would rewrite it.
  - **Claude-connector tool names are unverified.** Intuit's connector page does not
    publish its tool names; this policy assumes the same `verb_entity` vocabulary as
    Intuit's open-source server. Capture the live `tools/list` through your gateway
    and confirm the `search_*` names before relying on this in production.
  - **Match requires the `search_` underscore verb.** The tool matcher keys on
    `search_` at a word boundary, so it covers the `verb_entity` snake_case
    vocabulary (Intuit official + assumed connector) and the LibreChat server. It
    does **not** match a camelCase `searchInvoices` (no underscore) nor the archived
    hvkshetry server's 6 mega-tools (`transaction`, `report`, … carry the read verb
    in an `operation` argument, with no `search_` in the name). Those shapes need a
    separate argument-level policy — confirm your server's tool names with the
    dump-input technique. The boundary anchor also means a name that merely embeds
    the substring mid-token (e.g. `research_*`) is correctly not matched.
  - **No identity gating.** All callers get the same clamp. This is a proportionality
    control, not an access-control one; combine with a role policy for who-may-read
    decisions.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - quickbooks
industries: []
bundles:
  - gdpr-ccpa
  - pci-dss
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package quickbooks.ingress.cap_bulk_export

# Transform-only ingress policy: it never denies, it only clamps the bulk-read
# parameters on QuickBooks `search_*` tools. Every other tool passes through.
default allow := true

# Maximum rows a single search_* call may request. A search that legitimately
# needs more than this should page explicitly (leaving an audit trail) rather than
# pull the whole ledger / customer list into agent context at once. Tune for your
# environment.
limit_cap := 50

# --- Tool matching --------------------------------------------------------------

# Any QuickBooks search_* tool, regardless of the server-name prefix the gateway
# prepends. Tool names are `<server-prefix>search_<entity>` (e.g.
# `quickbooks-search_invoices`), so match `search_` at the start of the name or
# immediately after a non-letter separator. Anchoring on a non-letter boundary
# avoids matching a word that merely embeds "search_" mid-token (e.g. `research_*`).
is_search_tool if {
	regex.match(`(^|[^a-z])search_`, lower(input.resource.name))
}

# --- Transform ------------------------------------------------------------------

# Rewrite the arguments of a search_* call, but only when clamping actually changes
# them. When nothing needs clamping the rewritten args equal the originals and this
# rule is undefined, so the aggregator skips this policy for that request.
transform := {"transformed_payload": rewritten} if {
	is_search_tool
	rewritten := rewrite_args(input.payload.args)
	rewritten != input.payload.args
}

# Rewrite the args in two independent passes: first clamp `limit`/`fetchAll`
# *inside* `criteria`, then clamp a top-level `limit` sibling. The LibreChat
# server carries `limit` alongside `criteria` (not inside it), so a criteria-only
# clamp would miss its bulk lever entirely. Both passes are total, so rewrite_args
# is always defined for a search_* call; the caller only emits a transform when the
# result actually differs from the original args.
rewrite_args(args) := clamp_top_limit(clamp_criteria_in_args(args))

# Replace `criteria` with its clamped form when `criteria` is a clampable
# object/array; otherwise return args untouched. `criteria` is removed before the
# union so the clamped value replaces it wholesale — object.union deep-merges,
# which would otherwise re-introduce the original sub-keys (e.g. a stripped
# fetchAll).
clamp_criteria_in_args(args) := object.union(object.remove(args, {"criteria"}), {"criteria": clamp_criteria(crit)}) if {
	crit := object.get(args, "criteria", null)
	is_clampable(crit)
}

clamp_criteria_in_args(args) := args if {
	not is_clampable(object.get(args, "criteria", null))
}

is_clampable(crit) if is_object(crit)

is_clampable(crit) if is_array(crit)

# Clamp the top-level bulk-read levers that sit as siblings of `criteria` — the
# LibreChat search shape hoists paging params to the top level. Mirrors the
# per-object clamp so the top level has no weaker rule than `criteria`:
#   1. truthy top-level fetchAll -> drop it and pin the top-level limit to the cap
#      (fetchAll is the whole-ledger lever; leaving it at the top level was a
#      bypass on servers that honour a top-level fetchAll).
#   2. no fetchAll, top-level limit a number above the cap -> lower it to the cap.
#   3. otherwise -> unchanged (small / non-numeric top-level limit preserved).
clamp_top_limit(args) := object.union(object.remove(args, {"fetchAll"}), {"limit": limit_cap}) if {
	has_fetch_all(args)
}

clamp_top_limit(args) := object.union(args, {"limit": limit_cap}) if {
	not has_fetch_all(args)
	limit_exceeds(args)
}

clamp_top_limit(args) := args if {
	not has_fetch_all(args)
	not limit_exceeds(args)
}

# `criteria` shapes handled:
#   - advanced object  {filters, asc, desc, limit, offset, count, fetchAll}
#   - array of clauses (LibreChat)  [{field, value, operator, limit, ...}, ...]
#   - bare field map   {DisplayName: "Acme"}  -> no limit/fetchAll, returned as-is
clamp_criteria(crit) := clamp_object(crit) if {
	is_object(crit)
}

clamp_criteria(crit) := [clamp_element(e) | some e in crit] if {
	is_array(crit)
}

# Array entries are usually clause objects; tolerate anything else by leaving
# non-objects untouched so the array length is never changed.
clamp_element(e) := clamp_object(e) if {
	is_object(e)
}

clamp_element(e) := e if {
	not is_object(e)
}

# Clamp one criteria object. Three mutually exclusive cases:
#   1. truthy fetchAll present -> drop fetchAll and pin limit to the cap.
#   2. no fetchAll, but limit is a number above the cap -> lower it to the cap.
#   3. otherwise -> unchanged (small explicit limits are preserved).
clamp_object(o) := out if {
	has_fetch_all(o)
	out := object.union(object.remove(o, {"fetchAll"}), {"limit": limit_cap})
}

clamp_object(o) := object.union(o, {"limit": limit_cap}) if {
	not has_fetch_all(o)
	limit_exceeds(o)
}

clamp_object(o) := o if {
	not has_fetch_all(o)
	not limit_exceeds(o)
}

has_fetch_all(o) if {
	object.get(o, "fetchAll", false) == true
}

limit_exceeds(o) if {
	l := object.get(o, "limit", 0)
	is_number(l)
	l > limit_cap
}
```
