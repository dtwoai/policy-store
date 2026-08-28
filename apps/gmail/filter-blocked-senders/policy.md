---
name: Strip Blocked Senders from Gmail Reads
tags:
  - gmail
  - filter-blocked-senders
  - egress
  - email
  - sender-blocklist
  - data-minimization
publishedAt: 2026-08-28
description: |
  # gmail / filter-blocked-senders

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only, with a fail-closed deny for unparseable
  governed responses)
  **Package:** `gmail.egress.filter_blocked_senders`

  ## What it does

  Keeps mail from specified senders out of agent reach, whatever its age.
  Agents reading Gmail through the gateway see correspondence with the
  listed senders removed at the **message** level: a thread a blocked
  sender merely took part in stays readable, minus their own messages, and
  a thread left with nothing is dropped from search results. Anything
  withheld is marked with a `notice`, so the agent can tell mail was held
  back by policy rather than absent from the mailbox.

  An entry in `blocked_senders` may name a single address
  (`old-address@example.com`) or a whole domain (`@vendor.example`) — in
  which case every sender at that domain is filtered. Matching is
  case-insensitive substring matching, because the sender field may carry a
  display name (`Vendor Support <support@vendor.example>`).

  Typical use: automated mail an agent has no business reading — bank
  transfer notices, payroll runs, vendor billing — and former addresses
  whose history should stay out of agent context.

  **The `blocked_senders` entries are placeholders** — replace them with
  your own addresses and domains at import time.

  A governed response that carries content but where no block parses as
  JSON is denied rather than returned unfiltered (the signature of an
  upstream schema change).

  ## Tool name matching

  Matched case-insensitively by suffix on `input.resource.name` across the
  thread-centric Gmail read surface, in both naming styles:

  - `*-search-threads`, `*-get-thread`, `*-get-message` — Google official
    Gmail MCP server (kebab-case tool names).
  - `*-search_threads`, `*-get_thread`, `*-get_message` — snake_case
    variant.

  The suffix includes the gateway's hyphen separator, so an unrelated tool
  whose name merely ends in these characters (e.g. `forget-message`) does
  not match.

  ## Response shape

  Two shapes are handled, matching the Google-official server:

  - **search-threads:** a top-level `threads` array, each thread carrying
    `messages` with a `sender`. Threads are scrubbed message by message;
    a thread scrubbed down to nothing is dropped rather than returned as an
    empty husk. A thread that never carried a `messages` array is left
    alone.
  - **get-thread / get-message:** a top-level `messages` array — blocked
    messages are removed and the remaining ones returned.

  Unchanged blocks pass through byte-identical.

  ## Examples

  With `blocked_senders := {"@vendor.example", ...}`, a thread where
  `support@vendor.example` replied to a colleague comes back containing
  only the colleague's messages plus the notice; a thread consisting
  entirely of vendor notifications disappears from search results.

  ## Composition

  - `apps/gmail/recent-search-only` + `apps/gmail/filter-dormant-threads` —
    the recency pair; this policy is orthogonal to the window.
  - `apps/gmail/filter-labeled-threads` — the whole-thread manual override;
    note the deliberate contrast (label filter withholds entire threads,
    this one scrubs individual messages).

  ## Known limitations

  - **Substring matching is deliberately loose.** `@vendor.example` also
    matches `@sub.vendor.example` (usually desirable) — but a very short
    entry could over-match display names; prefer full domains
    (`@vendor.example`) or full addresses.
  - **Sender field only.** Mail *about* a blocked sender, or quoted text
    from them inside another person's reply body, is not filtered.
  - **Blocklist lives in the policy.** Changing it means editing and
    redeploying the policy — appropriate for a short, stable list.
  - **Validation status.** Validated live against the Google official
    Gmail MCP server (kebab-case names) behind a DTwo gateway; the
    snake_case variants come from documentation and have not been exercised
    against a live server.
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
package gmail.egress.filter_blocked_senders

# Removes messages from blocked senders out of Gmail read responses. Filters
# rather than denies — the agent still receives every other message in the
# response, including the rest of a thread a blocked sender participated in.

# --- Configuration -----------------------------------------------------------
# Addresses whose mail agents may not read. An entry may be a full address or
# a whole domain (with the leading @). Placeholders — replace at import time.

blocked_senders := {"@vendor.example", "old-address@example.com"}

default allow := true

filter_notice := "Messages from addresses on the gateway's blocked-sender list were removed by policy."

# --- Scope ---------------------------------------------------------------------
# Gated on tool name only, so a response from any other server is never
# inspected or parsed. Matched case-insensitively as a suffix including the
# separator: the gateway prefixes tool names with the MCP server's configured
# name (mail, gmail, gm, ...), and the leading hyphen stops an unrelated tool
# whose name merely ends in these characters (for example "forget-message")
# from matching. Both kebab-case and snake_case vocabularies are covered.

gmail_read_suffixes := {
  "-search-threads",
  "-search_threads",
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

# --- Sender matching --------------------------------------------------------------
# `contains` rather than equality: the sender field may carry a display name,
# e.g. "Vendor Support <support@vendor.example>".

sender_is_blocked(m) if {
  raw := object.get(m, "sender", "")
  is_string(raw)
  addr := lower(raw)
  addr != ""
  some blocked in blocked_senders
  contains(addr, lower(blocked))
}

# --- Response payload ------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

# --- Per-thread scrubbing ----------------------------------------------------------
# Defined only when the thread actually loses a message, so a thread with no
# blocked participant passes through byte-identical via kept_thread below.

scrubbed_thread(t) := out if {
  msgs := object.get(t, "messages", [])
  is_array(msgs)
  kept := [m |
    some m in msgs
    not sender_is_blocked(m)
  ]
  count(kept) < count(msgs)
  out := object.union(t, {"messages": kept})
}

kept_thread(t) := scrubbed_thread(t)

kept_thread(t) := t if {
  not scrubbed_thread(t)
}

# A thread scrubbed down to nothing is dropped rather than returned as an empty
# husk. A thread that never carried a messages array at all is left alone —
# there is nothing in it for this policy to filter.

thread_survives(t) if {
  count(object.get(t, "messages", [])) > 0
}

thread_survives(t) if {
  not is_array(object.get(t, "messages", null))
}

# --- Per-block filtering -----------------------------------------------------------
# Each definition is guarded by is_governed so nothing is unmarshalled for a
# tool this policy does not govern. Both are defined only when the block
# actually needs changing; an unchanged or unparseable block is passed through
# byte-identical by kept_block below.

# search-threads shape: threads[] — scrub each thread, then drop any thread
# left with nothing.
filtered_block(b) := out if {
  is_governed
  is_string(b)
  parsed := json.unmarshal(b)
  is_object(parsed)
  threads_in := object.get(parsed, "threads", [])
  is_array(threads_in)
  count(threads_in) > 0
  kept := [scrubbed |
    some t in threads_in
    scrubbed := kept_thread(t)
    thread_survives(scrubbed)
  ]
  kept != threads_in
  out := json.marshal(object.union(parsed, {
    "threads": kept,
    "notice": filter_notice,
  }))
}

# get-thread / get-message shape: top-level messages[] is one conversation, so
# the blocked messages are removed and the remaining ones returned.
filtered_block(b) := out if {
  is_governed
  is_string(b)
  parsed := json.unmarshal(b)
  is_object(parsed)
  count(object.get(parsed, "threads", [])) == 0
  msgs := object.get(parsed, "messages", [])
  is_array(msgs)
  count(msgs) > 0
  kept := [m |
    some m in msgs
    not sender_is_blocked(m)
  ]
  count(kept) < count(msgs)
  out := json.marshal(object.union(parsed, {
    "messages": kept,
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
# Rewrites payload.text only. Emitted only when at least one block changed, so
# a response with no blocked sender in it is returned byte-identical rather
# than re-serialised.

transform := {
  "transformed_payload": object.union(response_payload, {"text": kept_blocks}),
} if {
  input.mode == "output"
  is_governed
  is_array(text_blocks)
  kept_blocks != text_blocks
}

# --- Deny path -------------------------------------------------------------------
# A single unparseable block among several passes through, but a governed
# response where nothing parses cannot be filtered at all. That is the
# signature of an upstream schema change, so it is denied rather than returned
# unfiltered.

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

reason := "Blocked: this mail response could not be parsed, so messages from blocked senders could not be filtered out of it." if not allow
```
