---
name: Restrict Gmail Thread Searches to Recent Mail
tags:
  - gmail
  - recent-search-only
  - ingress
  - email
  - recency
  - data-minimization
publishedAt: 2026-08-28
description: |
  # gmail / recent-search-only

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `gmail.ingress.recent_search_only`

  ## What it does

  Rewrites every Gmail thread search on the way in to prepend a
  `newer_than:` recency term, so Gmail itself returns only recent
  correspondence. With the default `max_age_days := 14`, a search for
  `from:alice@example.com` reaches Gmail as
  `newer_than:14d (from:alice@example.com)`. Searches are never refused —
  they come back scoped.

  The rewrite is unconditional: it is applied whether or not the caller
  already supplied a `newer_than:` term, so an agent cannot widen the window
  by asking for older mail (Gmail ANDs the terms, and the narrower window
  wins). The caller's own query is wrapped in parentheses so a top-level
  `OR` cannot escape the recency constraint. A missing, blank, or
  non-string query is replaced by the recency filter alone, so a malformed
  request yields the tightest filter rather than an unconstrained search.

  ## Companion policy

  This policy governs searching only. Fetching a known conversation by ID
  takes no query, so `gmail/filter-dormant-threads` holds the same window on
  the direct-read path (`get-thread` / `get-message`). The two are designed
  to be attached together, and each carries its own copy of `max_age_days` —
  change them in step.

  The split exists for a subtle reason: a `search-threads` response carries
  only a truncated preview of each thread's messages (the oldest few), so
  recency cannot be tested reliably on the egress side of search — an active
  thread whose recent replies fall outside the preview would be wrongly
  dropped. Enforcing search recency server-side, in the query, avoids that
  failure mode entirely.

  ## Tool name matching

  The policy matches the Gmail thread-search tool case-insensitively by
  suffix on `input.resource.name`, covering both naming styles seen on the
  thread-centric Gmail MCP surface:

  - `*-search-threads` — Google official Gmail MCP server
    (`gmailmcp.googleapis.com`, kebab-case tool names).
  - `*-search_threads` — snake_case variant of the same tool name.

  The DTwo gateway prefixes tool names with the configured MCP server name
  plus a hyphen (e.g. `mail-search-threads`), and the suffix match includes
  that separator, so an unrelated tool whose name merely ends in these
  characters (e.g. `research_threads`) does not match. Message-centric
  community servers (`search_emails`, `search_gmail_messages`) also accept
  Gmail query syntax; add their suffixes to `search_tool_suffixes` after
  verifying the argument name with the dump-input technique.

  ## Examples

  ### Transformed (scoped)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "mail-search-threads", "type": "tool" },
      "payload": {
        "name": "mail-search-threads",
        "args": { "query": "from:alice@example.com", "pageSize": 10 }
      }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload.query` becomes
  `newer_than:14d (from:alice@example.com)` and `pageSize` is preserved.

  ### Passed through (not a search tool)

  A `mail-get-thread` call has no query to rewrite; the policy leaves it
  untouched. Direct reads are governed by the companion egress policy.

  ## Composition

  - `apps/gmail/filter-dormant-threads` — the direct-read half of the same
    recency window. Attach both.
  - `apps/gmail/filter-blocked-senders` and
    `apps/gmail/filter-labeled-threads` — orthogonal mailbox-hygiene
    filters that compose cleanly with this one.

  ## Known limitations

  - **Gmail query terms are message-level.** `newer_than:` matches threads
    with at least one message in the window, which is the desired
    thread-level semantic for a bare listing. But when the caller's own
    terms match only *old* messages of an active thread (e.g. `from:` a
    participant who last wrote a month ago), Gmail requires one message to
    satisfy both sides of the AND and the thread may be missing from the
    listing even though it is active. A direct `get-thread` still returns
    it. This is inherent to Gmail query semantics, not fixable in the
    rewrite.
  - **Search-shaped tools only.** Tools not ending in the listed suffixes
    are untouched; if your server exposes other query-bearing search tools,
    add their suffixes.
  - **Validation status.** The kebab-case suffix and the rewrite behavior
    were validated live against the Google official Gmail MCP server behind
    a DTwo gateway; the snake_case variant comes from documentation and has
    not been exercised against a live server.
direction: ingress
apps:
  - gmail
industries: []
bundles: []
experimental: false
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gmail.ingress.recent_search_only

# Constrains Gmail thread searches to the recency window by prepending a
# newer_than: term to the caller's query. Transform-only — never denies.

# --- Configuration -----------------------------------------------------------
# How many days of history a search may reach back. Keep in step with
# gmail.egress.filter_dormant_threads, which carries its own copy.
max_age_days := 14

recency_filter := sprintf("newer_than:%dd", [max_age_days])

default allow := true

# --- Scope ---------------------------------------------------------------------
# Only the thread-search tool takes a query. Matched case-insensitively on
# tool-name suffix including the separator: the gateway prefixes tool names
# with the MCP server's configured name (mail, gmail, gm, ...), so a prefix
# match would not port, and the leading hyphen prevents an unrelated tool
# whose name merely ends in these characters (e.g. "research_threads") from
# matching. Both kebab-case and snake_case tool vocabularies are covered.

tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

search_tool_suffixes := {
  "-search-threads",
  "-search_threads",
}

is_search_tool if {
  some suffix in search_tool_suffixes
  endswith(tool_name, suffix)
}

# --- Transform -----------------------------------------------------------------
# The filter is prepended unconditionally rather than skipped when the caller
# already supplied a newer_than: term, so a caller cannot widen the window by
# asking for one. Gated on the pre-invoke hook: there is nothing to rewrite on
# egress.

transform := {"transformed_payload": object.union(
  object.get(object.get(input, "payload", {}), "args", {}),
  {"query": new_query},
)} if {
  input.action == "tool_pre_invoke"
  is_search_tool
  original := object.get(object.get(object.get(input, "payload", {}), "args", {}), "query", "")
  new_query := build_query(original)
}

# --- Query construction ----------------------------------------------------------
# Three mutually exclusive definitions. The non-string case exists so that a
# malformed query yields the tightest possible filter rather than causing the
# transform to go undefined and the search to run unconstrained.

# Non-string query (number, array, object) — filter alone.
build_query(original) := recency_filter if {
  not is_string(original)
}

# Absent or blank query — filter alone.
build_query(original) := recency_filter if {
  is_string(original)
  trim_space(original) == ""
}

# Non-empty query — parenthesised so a top-level OR in the caller's query
# cannot escape the recency constraint.
build_query(original) := sprintf("%s (%s)", [recency_filter, trim_space(original)]) if {
  is_string(original)
  trim_space(original) != ""
}
```
