---
name: Fence Zoom Agentic Search to Native Corpora
tags:
  - zoom
  - agentic-search
  - constrain-aggregator
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # zoom / fence-agentic-search

  **Direction:** ingress (`tool_pre_invoke`), transform-first
  **Default:** allow (rewrite args); deny only when nothing Zoom-native remains
  **Package:** `zoom.ingress.fence_agentic_search`

  ## What it does

  Constrains Zoom's **agentic-search** tool (`*search_zoom`) so it can only reach
  Zoom-native content. Zoom's agentic search fans a single query out across Zoom
  content **and connected third-party systems** — Salesforce accounts, Workday
  employee/time-off records, ServiceNow tickets — with the required
  `search_entities` argument selecting which corpora are searched. Left
  unconstrained, an agent (or a prompt-injection) can laterally pull CRM,
  employee/HR, and ticketing records through the Zoom connector, outside those
  systems' own trust boundaries and governed connectors.

  This policy rewrites `search_entities` at ingress, before the call reaches the
  Zoom MCP server:

  1. It reads `search_entities` via `object.get`, accepting either an **array**
     (`["meetings","salesforce"]`) or a **single string** (`"meetings"`).
  2. It filters the requested entities down to a **pinned per-tenant allowlist**
     of Zoom-native corpora (`zoom_native_entities`), comparing case-insensitively
     and dropping everything else (`salesforce`, `workday`, `servicenow`, and any
     unrecognized value).
  3. If at least one Zoom-native entity survives, it **transforms** the call —
     `search_entities` is replaced with the filtered allowlist and all other
     arguments (`query`, `page_size`, …) pass through unchanged.
  4. If **no** Zoom-native entity remains (the caller asked only for external or
     unrecognized corpora, or omitted the required argument), it **denies** with
     an actionable reason pointing the caller at the governed connector for the
     system they actually wanted.

  The allowlist is a pinned constant (PF-28 style) documented for import, so a
  tenant with no Workday or ServiceNow integration still gets a clean default:
  external values are simply never in the set and are stripped.

  This is a single, focused constraint on one tool — `search_zoom` — that would
  otherwise reach sensitive data outside Zoom's own trust boundary. It does not
  touch Zoom's transcript, recording, chat, or docs tools; compose the companion
  policies below for those surfaces.

  ## Compliance alignment

  This policy instantiates policy family **PF-14 (constrain-aggregator)** for
  Zoom's `search_zoom` fan-out.

  - **SOC 2 CC6.6 (Enforceable)** — supports boundary protection against external
    threats by keeping the agent's search inside Zoom's trust boundary and denying
    lateral reach into third-party systems through the meta-connector; **CC9.2
    (Partial)** — supports vendor/business-partner risk management by preventing
    uncontrolled cross-connector data pulls; **CC6.8 (Partial)** — supports
    restricting unauthorized functionality by fencing a self-expanding search
    surface.
  - **HIPAA §164.508 (Partial)** — supports the authorization requirement for
    uses/disclosures of PHI by preventing agentic search from pulling
    employee/HR or other records into Zoom's fan-out along an ungoverned path
    that no BAA or minimum-necessary determination covers.
  - **GDPR Arts. 44/46 (Partial)** — supports control over cross-border and
    cross-system transfers on agent-visible flows by keeping personal data in
    Salesforce/Workday/ServiceNow from being routed through the Zoom connector.

  All alignment is on the MCP path only (see the compliance note below).

  ## Tool name matching

  Zoom's official workspace server uses **bare snake_case verbs with no vendor
  prefix** (`search_zoom`), so only the gateway server-name prefix disambiguates.
  The policy matches by **suffix** on `lower(input.resource.name)`:

  - `*search_zoom`

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `zoom-workspace-search_zoom`); that prefix is not standardized across
  deployments, so suffix matching keeps the policy portable. Verify the exact name
  your gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  - **`search_entities`** is read from `input.payload.args` with `object.get`,
    robust to a missing `payload`/`args` object (fail closed). It is accepted as
    either an array of strings or a single string; any other shape (a number,
    an object, or an absent argument) normalizes to an empty list, which lands the
    call in the deny branch (fail closed).
  - Matching against `zoom_native_entities` is **case-insensitive** — requested
    values are lowercased before lookup, so `"Salesforce"` and `"SERVICENOW"` are
    stripped just like their lowercase forms.
  - The rewrite preserves every other argument via `object.union(args, {...})` and
    replaces only `search_entities` with the sorted, de-duplicated allowlist match.

  ## Examples

  ### Transformed (external corpora stripped)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-workspace-search_zoom", "type": "tool" },
      "payload": {
        "name": "zoom-workspace-search_zoom",
        "args": {
          "query": "Q3 renewal risks",
          "search_entities": ["meetings", "salesforce", "workday"],
          "page_size": 20
        }
      }
    }
  }
  ```

  `allow = true`; `search_entities` rewritten to `["meetings"]`; `query` and
  `page_size` preserved. `salesforce` and `workday` are dropped.

  ### Allowed unchanged in effect (all-native, normalized)

  A request for `search_entities: "chat"` is rewritten to `["chat"]` — same
  corpus, normalized to the allowlisted array form. `allow = true`.

  ### Denied (only external corpora)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "zoom-workspace-search_zoom", "type": "tool" },
      "payload": {
        "name": "zoom-workspace-search_zoom",
        "args": { "query": "open tickets", "search_entities": ["servicenow", "workday"] }
      }
    }
  }
  ```

  `allow = false`, with a reason naming the stripped corpora and pointing the
  caller at the governed connector for that system. A `search_zoom` call that
  omits `search_entities` entirely is denied the same way (fail closed).

  ## Composition

  This policy is single-purpose. Useful companions on the Zoom connector:

  - **`zoom/guard-transcripts-by-group`** (ingress) — gates transcript/summary
    retrieval by IdP group.
  - **`zoom/redact-pii-meeting-intelligence`** (egress) — redacts PII in returned
    meeting content.
  - A defense-in-depth **egress** policy that inspects `search_zoom` responses and
    blocks any external-system rows that slip through, since this ingress transform
    fences the request but cannot see the response.

  ## Known limitations

  - **`search_entities` corpus vocabulary is unverified.** Zoom's landscape note
    confirms `search_zoom` takes a required `search_entities` argument that selects
    corpora and that external systems (Salesforce, Workday, ServiceNow) are among
    them, but the **exact accepted string values** — for both Zoom-native and
    external corpora — are not published or source-verified. The
    `zoom_native_entities` set in `policy.md` is a **placeholder allowlist**:
    replace its values with your tenant's actual Zoom-native entity vocabulary at
    import time. If Zoom uses different tokens (e.g. `zoom_meetings` instead of
    `meetings`), unedited values will strip *everything* and every call will deny —
    verify with the dump-input debug technique before relying on this in production.
  - **Allowlist, not blocklist.** Any corpus value not explicitly in
    `zoom_native_entities` is stripped — including future Zoom-native corpora Zoom
    may add. This is deliberate (default-deny for the fan-out) but means the
    constant must be maintained as Zoom's native surface grows.
  - **Idempotent rewrite.** All-native requests are still rewritten (lowercased and
    normalized to an array). If your upstream corpus tokens are case-sensitive,
    adjust the allowlist and the lowercasing accordingly.
  - **Ingress only.** This fences the request; it does not inspect the response.
    Pair with an egress policy if you need to catch external data that a
    misconfigured or renamed corpus still returns.
  - **Single tool.** Only `*search_zoom` is constrained. Other Zoom tools or
    community/sub-server surfaces that reach third-party data are not covered here.
  - **Sibling arguments pass through unchanged.** The rewrite replaces only
    `search_entities`; every other argument is preserved verbatim (by design, to
    keep `query`/`page_size`). Zoom's landscape note documents `search_entities`
    as the *sole* corpus selector, but the tool's argument schema is not
    source-verified. If a deployment's `search_zoom` also honors a second,
    undocumented corpus-selection argument (e.g. `sources`, `connectors`,
    `include_external`), this policy would **not** constrain it and external
    corpora could still be reached — the transform copies that sibling argument
    through unchanged. Confirm the full argument schema with the dump-input debug
    technique; if a second selector exists, extend the transform to strip or pin
    it too. **This includes a case-variant of `search_entities` itself:** the
    lookup and rewrite key are the exact lowercase string `search_entities`, so a
    sibling key that differs only in case (`Search_Entities`, `SEARCH_ENTITIES`)
    is treated as an unrelated argument and passes through verbatim. Standard
    JSON-RPC MCP tools match argument keys case-sensitively, so a lowercase
    `search_entities` is the only key the server reads and this is harmless; but
    if a deployment's server folds argument-key case, an attacker could smuggle
    external corpora past the fence in `SEARCH_ENTITIES` while a token
    `search_entities: ["meetings"]` keeps the call in the transform branch.
    Verify your server's key-casing behavior; if it is case-insensitive, pin the
    key by lowercasing/normalizing all argument keys before the rewrite.
  - **Meta / wildcard corpus values.** A value such as `all` or `everything` that
    the upstream might expand to *every* corpus (including external systems) is
    stripped by default because it is not in `zoom_native_entities` — a request
    for only `["all"]` therefore denies (fail closed). Never add such an
    expanding token to the allowlist, or the fence is defeated at its root.
  - **No identity-based exemptions.** All callers are treated identically. To let
    a designated group run cross-system search, add an `allow`/passthrough branch
    keyed on `object.get(input.subject, "claims", {})` groups (placeholder group
    names must be replaced with your IdP's group name at import time).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - zoom
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zoom.ingress.fence_agentic_search

# Transform-first ingress policy. On Zoom's agentic-search tool (`*search_zoom`)
# it rewrites the required `search_entities` argument to a pinned allowlist of
# Zoom-native corpora, stripping external systems (salesforce, workday,
# servicenow, ...) so the agent cannot laterally pull CRM / HR / ticketing
# records through Zoom's search fan-out. Allows by default; denies only when
# filtering leaves no Zoom-native corpus to search.
default allow := true

# --- Pinned per-tenant allowlist of Zoom-native search corpora (PF-28 style) ---
# Documented for import: replace these values with the Zoom-native entity
# vocabulary your tenant's agentic search actually exposes. External connectors
# (salesforce, workday, servicenow, ...) are intentionally ABSENT so their values
# are stripped rather than searched. Lookups are case-insensitive (values are
# lowercased before membership tests).
zoom_native_entities := {
    "meetings",
    "recordings",
    "transcripts",
    "chat",
    "team_chat",
    "docs",
    "whiteboards",
}

# The Zoom agentic-search tool. Zoom's workspace server exposes it as a bare
# snake_case verb, so match by suffix — the gateway's server-name prefix (e.g.
# `zoom-workspace-search_zoom`) is not standardized. Verify with dump-input.
is_search_zoom if {
    endswith(lower(input.resource.name), "search_zoom")
}

# Tool arguments, robust to a missing payload/args object (fail closed on absence).
args := object.get(object.get(input, "payload", {}), "args", {})

# Raw `search_entities` value exactly as sent (default [] when absent).
raw_entities := object.get(args, "search_entities", [])

# Normalize `search_entities` to an array of values, accepting an array or a
# single string. Any other shape (number, object, absent) becomes [] so the call
# fails closed into the deny branch.
requested_entities := raw_entities if is_array(raw_entities)

requested_entities := [raw_entities] if is_string(raw_entities)

requested_entities := [] if {
    not is_array(raw_entities)
    not is_string(raw_entities)
}

# The requested corpora that are Zoom-native, lowercased, de-duplicated, sorted.
# Non-string elements are skipped (their lower(...) call fails harmlessly).
allowed_entities := sort({e |
    some raw_e in requested_entities
    e := lower(raw_e)
    zoom_native_entities[e]
})

# All requested corpus names, lowercased and sorted — used only for the reason.
requested_names := sort([lower(x) |
    some x in requested_entities
    is_string(x)
])

requested_display := concat(", ", requested_names) if count(requested_names) > 0

requested_display := "none specified" if count(requested_names) == 0

# Rewrite the call: pin `search_entities` to the Zoom-native subset, preserve
# every other argument. Fires whenever the tool is search_zoom and at least one
# Zoom-native corpus survives filtering.
transform := {
    "transformed_payload": object.union(args, {"search_entities": allowed_entities}),
} if {
    is_search_zoom
    count(allowed_entities) > 0
}

# Deny when the search targets no Zoom-native corpus after filtering (only
# external/unrecognized values, or the required argument was missing/malformed).
allow := false if {
    is_search_zoom
    count(allowed_entities) == 0
}

reasons contains sprintf("Zoom agentic search is fenced to Zoom-native corpora, and this request named only external or unrecognized corpora (%s). None can be reached through Zoom's search fan-out. Query those systems through their own governed connector, or re-run search_zoom with a Zoom-native corpus. Contact your InfoSec team if a Zoom-native corpus was wrongly rejected.", [requested_display]) if {
    is_search_zoom
    count(allowed_entities) == 0
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
