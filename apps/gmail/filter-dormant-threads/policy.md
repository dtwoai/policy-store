---
name: Filter Dormant Conversations Out of Gmail Reads
tags:
  - gmail
  - filter-dormant-threads
  - egress
  - email
  - recency
  - data-minimization
publishedAt: 2026-08-28
description: |
  # gmail / filter-dormant-threads

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only, with a fail-closed deny for unparseable
  governed responses)
  **Package:** `gmail.egress.filter_dormant_threads`

  ## What it does

  Keeps dormant correspondence out of agent context while leaving active
  conversations fully readable. When an agent fetches a conversation by ID
  (`get-thread` / `get-message`), the policy judges the conversation as a
  whole: one message within the recency window (default
  `max_age_days := 14`) keeps the entire thread, older messages included. A
  conversation with nothing recent comes back with its `messages` emptied
  and a `notice` field, so the agent can tell mail was withheld by policy
  rather than absent from the mailbox.

  A governed response that carries content but where no block parses as
  JSON is denied rather than returned unfiltered — that is the signature of
  an upstream schema change, and failing closed beats silently leaking a
  dormant conversation.

  ## Companion policy — and why search is deliberately not governed

  This policy does **not** filter `search-threads`, and that is a
  correctness decision, not an omission. A search response carries only a
  truncated preview of each thread's messages (the oldest few), so testing
  recency over it wrongly drops active threads whose recent replies fall
  outside the preview. Search recency is instead enforced server-side by
  the companion ingress policy `gmail/recent-search-only`, which constrains
  the Gmail query itself. Attach both; each carries its own copy of
  `max_age_days` — change them in step.

  ## Tool name matching

  Matched case-insensitively by suffix on `input.resource.name`, covering
  both naming styles of the thread-centric Gmail MCP surface:

  - `*-get-thread`, `*-get-message` — Google official Gmail MCP server
    (kebab-case tool names).
  - `*-get_thread`, `*-get_message` — snake_case variant.

  The suffix includes the gateway's hyphen separator, so an unrelated tool
  whose name merely ends in these characters (e.g. `forget-message`) does
  not match. Message-centric community servers (`read_email`,
  `get_gmail_message_content`) return different response shapes and are
  deliberately out of scope — verify shapes with the dump-input technique
  before extending `gmail_read_suffixes`.

  ## Response shape

  The policy parses each block of `input.payload.text` as JSON and expects
  the Google-official conversation shape: a top-level `messages` array whose
  entries carry an RFC 3339 `date`. Blocks that do not need changing — and
  blocks that do not parse, as long as at least one block in the response
  does — pass through byte-identical.

  ## Examples

  ### Withheld (dormant)

  A `get-thread` response whose messages are all older than the window
  comes back as `{"messages":[],"notice":"Conversations with no activity in
  the last 14 days were removed by gateway policy."}` (other top-level
  fields preserved).

  ### Passed through (active)

  A thread with one recent reply is returned complete — including its old
  messages. The recency window gates the conversation, not the individual
  message.

  ## Composition

  - `apps/gmail/recent-search-only` — the search half of the same window.
    Attach both.
  - `apps/gmail/filter-blocked-senders`, `apps/gmail/filter-labeled-threads`
    — orthogonal mailbox filters; all three egress filters compose in any
    order.

  ## Known limitations

  - **The window is evaluated at read time** via `time.now_ns()`, so a
    conversation ages out of reach as time passes; there is no caching.
  - **Message `date` must be RFC 3339.** A message whose `date` is missing
    or unparseable counts as not-recent; a thread whose only recent message
    has a malformed date would be wrongly withheld. All observed responses
    from the Google official server carry clean RFC 3339 dates.
  - **Search listings are not filtered here** (by design — see above).
    Without the companion ingress policy attached, dormant threads appear
    in search results but still come back empty when actually read.
  - **Validation status.** The kebab-case suffixes and both filtering
    branches were validated live against the Google official Gmail MCP
    server behind a DTwo gateway; the snake_case variants come from
    documentation and have not been exercised against a live server.
direction: egress
apps:
  - gmail
industries: []
bundles: []
experimental: false
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gmail.egress.filter_dormant_threads

# Removes conversations with no recent activity from Gmail direct-fetch
# responses. Filters rather than denies — the agent still receives active
# conversations. A conversation is judged as a whole: one recent message keeps
# the entire thread, older messages included.
#
# Scope note: this policy governs get-thread / get-message only. It does NOT
# filter search-threads. A search response carries only a truncated preview of
# each thread's messages (the oldest few), so a recency test over it wrongly
# drops active threads whose recent messages fall outside the preview. Search
# recency is enforced server-side by the companion ingress policy
# gmail.ingress.recent_search_only, which constrains the Gmail query itself.

# --- Configuration -----------------------------------------------------------
# How many days of history an agent may read. Change this one number to widen
# or narrow the window. Keep in step with gmail.ingress.recent_search_only.

max_age_days := 14

# days -> hours -> minutes -> seconds -> nanoseconds
max_age_ns := max_age_days * 24 * 60 * 60 * 1000000000

cutoff_ns := time.now_ns() - max_age_ns

default allow := true

filter_notice := sprintf(
  "Conversations with no activity in the last %d days were removed by gateway policy.",
  [max_age_days],
)

# --- Scope ---------------------------------------------------------------------
# Gated on tool name only, so a response from any other server is never
# inspected or parsed. Matched case-insensitively as a suffix including the
# separator: the gateway prefixes tool names with the MCP server's configured
# name (mail, gmail, gm, ...), and the leading hyphen stops an unrelated tool
# whose name merely ends in these characters (for example "forget-message")
# from matching. Both kebab-case and snake_case vocabularies are covered.
#
# search-threads is deliberately absent: its response is a truncated preview
# that cannot be recency-tested reliably (see the header note). Search recency
# lives in the ingress companion instead.

gmail_read_suffixes := {
  "-get-thread",
  "-get_thread",
  "-get-message",
  "-get_message",
}

tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

is_governed if {
  some suffix in gmail_read_suffixes
  endswith(tool_name, suffix)
}

# --- Recency -------------------------------------------------------------------

message_is_recent(m) if {
  ts := object.get(m, "date", "")
  is_string(ts)
  ts != ""
  time.parse_rfc3339_ns(ts) >= cutoff_ns
}

any_recent(msgs) if {
  some m in msgs
  message_is_recent(m)
}

# --- Response payload ------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

# --- Per-block filtering ----------------------------------------------------------
# get-thread / get-message shape: a top-level messages[] is one conversation,
# kept entire or removed entire. get-thread returns the FULL message list
# (unlike search), so this recency test operates on complete data.
#
# Guarded by is_governed so nothing is unmarshalled for a tool this policy does
# not govern. Defined only when the block actually needs changing; an unchanged
# or unparseable block is passed through byte-identical by kept_block below.

filtered_block(b) := out if {
  is_governed
  is_string(b)
  parsed := json.unmarshal(b)
  is_object(parsed)
  msgs := object.get(parsed, "messages", [])
  is_array(msgs)
  count(msgs) > 0
  not any_recent(msgs)
  out := json.marshal(object.union(parsed, {
    "messages": [],
    "notice": filter_notice,
  }))
}

kept_block(b) := filtered_block(b)

kept_block(b) := b if {
  not filtered_block(b)
}

kept_blocks := [out |
  some block in text_blocks
  out := kept_block(block)
]

# --- Transform -----------------------------------------------------------------
# Emitted only when at least one block changed, so an untouched response is
# returned byte-identical rather than re-serialised.

transform := {
  "transformed_payload": object.union(response_payload, {"text": kept_blocks}),
} if {
  input.mode == "output"
  is_governed
  is_array(text_blocks)
  kept_blocks != text_blocks
}

# --- Deny path -------------------------------------------------------------------
# A governed response (get-thread / get-message) that carries content but where
# nothing parses cannot be filtered at all. That is the signature of an upstream
# schema change, so it is denied rather than returned unfiltered.

parseable_count := count([b |
  is_governed
  some b in text_blocks
  is_string(b)
  obj := json.unmarshal(b)
  is_object(obj)
])

allow := false if {
  is_governed
  count(text_blocks) > 0
  parseable_count == 0
}

reason := "Blocked: this mail response could not be parsed, so dormant conversations could not be filtered out of it." if not allow
```
