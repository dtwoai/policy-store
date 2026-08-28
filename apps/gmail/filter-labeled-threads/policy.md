---
name: Hide Threads Carrying a Restricted Gmail Label
tags:
  - gmail
  - filter-labeled-threads
  - egress
  - email
  - label-filter
  - confidentiality
publishedAt: 2026-08-28
description: |
  # gmail / filter-labeled-threads

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only, with a fail-closed deny for unparseable
  governed responses)
  **Package:** `gmail.egress.filter_labeled_threads`

  ## What it does

  A manual override for individual conversations: any thread carrying a
  restricted Gmail label is withheld **whole** — every message in it, not
  just the labeled one. The operator keeps (for example) a `Confidential`
  label; when a specific conversation shouldn't be in an agent's reach,
  labeling it in Gmail puts it out of reach in a click, with no policy edit
  and no redeploy. Restricted threads are dropped from search listings and
  come back emptied (with a `notice`) when fetched directly.

  This is the deliberate contrast with `gmail/filter-blocked-senders`,
  which scrubs individual messages and keeps the rest of the thread: a
  label marks the *conversation* as sensitive, so the whole conversation is
  withheld.

  A governed response that carries content but where no block parses as
  JSON is denied rather than returned unfiltered (the signature of an
  upstream schema change).

  ## Configuration — the label ID placeholder

  `target_labels` ships with the placeholder `Label_XXXXXXXXXXXXXXXXX`.
  Gmail **user** labels appear in responses as opaque IDs
  (`Label_1693...857`), not display names — list the exact tokens your
  server returns, which you can discover with the Gmail `list-labels` tool
  or the dump-input technique. Gmail **system** labels arrive by name
  (`INBOX`, `IMPORTANT`, `SPAM`, `CATEGORY_*`) and can be listed as-is.
  Matching is case-insensitive and exact per token.

  ## Tool name matching

  Matched case-insensitively by suffix on `input.resource.name` across the
  thread-centric Gmail read surface, in both naming styles:

  - `*-search-threads`, `*-get-thread`, `*-get-message` — Google official
    Gmail MCP server (kebab-case tool names).
  - `*-search_threads`, `*-get_thread`, `*-get_message` — snake_case
    variant.

  The suffix includes the gateway's hyphen separator, so an unrelated tool
  whose name merely ends in these characters does not match.

  ## Response shape

  Labels may arrive in any of three shapes, and all are collected into one
  token set before matching: `labelIds: ["INBOX", "Label_1..."]`,
  `labels: ["INBOX", ...]` as strings, or `labels: [{"id": ..., "name":
  ...}]` objects. A thread is restricted if the thread object itself, or
  any message in it, carries a restricted token.

  - **search-threads:** restricted threads are dropped from `threads[]`;
    the rest pass through unchanged.
  - **get-thread / get-message:** if any message carries a restricted
    label, `messages[]` is emptied and the `notice` added.

  ## Composition

  - `apps/gmail/recent-search-only` + `apps/gmail/filter-dormant-threads` —
    the recency pair.
  - `apps/gmail/filter-blocked-senders` — the per-message counterpart.
    All the egress filters compose in any order.

  ## Known limitations

  - **The label is the control surface.** Anyone (or any rule) that can
    remove the Gmail label re-exposes the thread; the policy inherits
    Gmail's label permissions.
  - **New messages inherit protection only via the thread.** Gmail applies
    user labels to messages; the policy also honors a label on the thread
    object, and one labeled message restricts the whole conversation — but
    a brand-new reply in a labeled conversation is only caught if the label
    landed on the thread or on at least one message the response carries.
  - **Search previews are truncated.** A search-threads response carries
    only a preview of each thread's messages; if the only labeled message
    falls outside the preview, the thread survives the *listing* (it is
    still withheld on direct read, where the full message list is
    visible). Labeling promptly — or relying on Gmail's thread-level
    labeling, which the preview does carry — closes the gap in practice.
  - **Validation status.** Validated live against the Google official
    Gmail MCP server (kebab-case names, `labelIds` shape) behind a DTwo
    gateway; the snake_case variants and the `labels` string/object shapes
    come from documentation and have not been exercised against a live
    server.
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
package gmail.egress.filter_labeled_threads

# Removes whole threads carrying a restricted label from Gmail read responses.
# If ANY message in a thread carries one of the target labels, the ENTIRE
# thread is withheld — unlike the per-sender filter, which scrubs individual
# messages and keeps the rest of the thread. Filters rather than denies, except
# a governed response that cannot be parsed at all is denied (fail closed)
# rather than returned unfiltered.

# --- Configuration -----------------------------------------------------------
# Labels whose threads agents may not read. A thread is dropped if any of its
# messages carries any of these. Matching is case-insensitive and exact against
# whatever the response carries. Gmail system labels arrive by name (INBOX,
# IMPORTANT, SPAM, CATEGORY_*); user labels are usually opaque ids
# ("Label_1234..."), not the display name — list the exact tokens your server
# returns (discover them with the list-labels tool or dump-input technique).
# Placeholder — replace at import time.

target_labels := {"Label_XXXXXXXXXXXXXXXXX"}

default allow := true

filter_notice := "Threads carrying a label on the gateway's restricted-label list were removed by policy."

# --- Scope ---------------------------------------------------------------------
# Gated on tool name only, so a response from any other server is never
# inspected or parsed. Matched case-insensitively as a suffix including the
# separator: the gateway prefixes tool names with the MCP server's configured
# name, and the leading hyphen stops an unrelated tool whose name merely ends
# in these characters from matching. Both kebab-case and snake_case
# vocabularies are covered.

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

# --- Label matching --------------------------------------------------------------
# A message (or thread) may carry labels as labelIds:["INBOX","Label_1"], as
# labels:["INBOX",...] strings, or as labels:[{"id","name"}] objects. Collect
# all of those into one lowercased token set and test against the target set.

label_tokens(obj) := toks if {
  ids := {lower(x) | some x in object.get(obj, "labelIds", []); is_string(x)}
  strs := {lower(x) | some x in object.get(obj, "labels", []); is_string(x)}
  obj_ids := {lower(v) | some x in object.get(obj, "labels", []); is_object(x); v := object.get(x, "id", null); is_string(v)}
  obj_names := {lower(v) | some x in object.get(obj, "labels", []); is_object(x); v := object.get(x, "name", null); is_string(v)}
  toks := ((ids | strs) | obj_ids) | obj_names
}

target_labels_lower := {lower(l) | some l in target_labels}

has_restricted_label(obj) if {
  count(label_tokens(obj) & target_labels_lower) > 0
}

# A thread is excluded if the thread object itself, or any message in it,
# carries a restricted label.

thread_is_restricted(t) if has_restricted_label(t)

thread_is_restricted(t) if {
  some m in object.get(t, "messages", [])
  has_restricted_label(m)
}

# --- Response payload ------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

# --- Per-block filtering -----------------------------------------------------------
# Each definition is guarded by is_governed so nothing is unmarshalled for a
# tool this policy does not govern. Both are defined only when the block
# actually needs changing; an unchanged or unparseable block is passed through
# byte-identical by kept_block below.

# search-threads shape: threads[] — drop every thread carrying a restricted
# label; the rest pass through unchanged.
filtered_block(b) := out if {
  is_governed
  is_string(b)
  parsed := json.unmarshal(b)
  is_object(parsed)
  threads_in := object.get(parsed, "threads", [])
  is_array(threads_in)
  count(threads_in) > 0
  kept := [t |
    some t in threads_in
    not thread_is_restricted(t)
  ]
  kept != threads_in
  out := json.marshal(object.union(parsed, {
    "threads": kept,
    "notice": filter_notice,
  }))
}

# get-thread / get-message shape: top-level messages[] is one conversation, so
# if any message carries a restricted label the whole thread is withheld — its
# messages are emptied and the response marked.
filtered_block(b) := out if {
  is_governed
  is_string(b)
  parsed := json.unmarshal(b)
  is_object(parsed)
  count(object.get(parsed, "threads", [])) == 0
  msgs := object.get(parsed, "messages", [])
  is_array(msgs)
  count(msgs) > 0
  some m in msgs
  has_restricted_label(m)
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
# Rewrites payload.text only. Emitted only when at least one block changed, so
# a response with no restricted thread in it is returned byte-identical rather
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

reason := "Blocked: this mail response could not be parsed, so threads carrying restricted labels could not be filtered out of it." if not allow
```
