---
name: Gmail Cap Bulk Export
tags:
  - gmail
  - cap-bulk-export
  - data-minimisation
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # gmail / cap-bulk-export

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny oversized or malformed batch content reads; allow everything else; transform-clamp `maxResults` on searches
  **Package:** `gmail.ingress.cap_bulk_export`

  ## What it does

  Throttles mass-harvesting of a mailbox by capping the per-call blast radius
  of the two Gmail MCP surfaces that return many full email bodies at once:

  - **Batch content reads are denied above the cap** — the taylorwilsdon
    Workspace server's `get_gmail_messages_content_batch` and
    `get_gmail_threads_content_batch` return dozens of full message bodies in a
    single call. When the ID array (`message_ids` / `thread_ids`) exceeds
    **10** entries, the call is denied with a reason telling the agent to page
    through the mailbox in smaller batches. The check **fails closed**: a
    batch call whose ID argument is missing or is not an array is denied
    rather than passed through for the server to interpret.
  - **Search page sizes are clamped** — the GongRzhe server's `search_emails`
    takes a numeric `maxResults`. Any value above **25**, a non-positive value
    (`0` or negative — some servers read these as "use default" or
    "unbounded"), a missing value, or a non-numeric value is rewritten to
    `maxResults: 25` via a `transformed_payload`; only a number already in the
    range `[1, 25]` is passed through unchanged. All other arguments are
    preserved. Searches are never denied.

  Everything else passes through untouched — the official connector's
  `search_threads` and `get_thread` are single-query/single-thread by design,
  and non-batch reads (`read_email`, `get_gmail_message_content`,
  `get_gmail_thread_content`) are the minimum-necessary sanctioned path for
  thread-granularity access.

  The constants (10 IDs per batch, 25 search results) are documented tuning
  knobs — adjust `max_batch_ids` and `max_search_results` in `policy.md` to
  your environment's tolerance.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information by bounding how much mailbox content any single agent call
    can move out of Gmail.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary
    standard: patient email routinely carries PHI, and agents retrieve
    thread-sized reads scoped to the task rather than the maximum the batch
    API permits.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel: the read
    volume is minimised *before* the query reaches Gmail.
  - **CCPA 11 CCR §7002** — supports proportionality: collection and use of
    personal information stays proportionate to the disclosed purpose rather
    than defaulting to bulk mailbox retrieval.

  ## Why ingress

  The over-broad request itself is the problem: once the server has returned
  50 full email bodies, an egress policy can only mask patterns in text that
  has already been fetched and logged. Denying the oversized batch and
  clamping the search page size at ingress is the only place the *volume* of
  mailbox content can be controlled.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `gmail-workspace-get_gmail_messages_content_batch`), so matching is by
  case-insensitive suffix to stay portable across deployments. Covered names,
  per server family:

  - **taylorwilsdon/google_workspace_mcp** (verified from
    `gmail/gmail_tools.py`): `get_gmail_messages_content_batch`,
    `get_gmail_threads_content_batch` — denied above the ID cap.
  - **GongRzhe/Gmail-MCP-Server** (verified from the README):
    `search_emails` — `maxResults` clamped.
  - **Official Google / Claude connector** (verified): `search_threads`,
    `get_thread` — intentionally untouched; both are single-query /
    single-thread.

  Verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production, and extend the suffix lists
  if your server exposes additional batch-read tools.

  ## Argument shape

  - `get_gmail_messages_content_batch` takes a `message_ids` array;
    `get_gmail_threads_content_batch` takes a `thread_ids` array (both
    verified from source). The policy counts **both** keys on every batch call
    (`object.get`, no direct indexing) and denies when the larger present array
    exceeds the cap, so an oversized array cannot ride in on the key the
    matched tool doesn't read while a small decoy sits in the other key. If
    neither key is present as an array, the call is denied — fail closed rather
    than letting the server decide.
  - `search_emails` takes `query` (Gmail search syntax) and a numeric
    `maxResults` (verified). The clamp preserves every other argument via
    `object.union`.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-workspace-get_gmail_messages_content_batch", "type": "tool" },
      "payload": {
        "name": "gmail-workspace-get_gmail_messages_content_batch",
        "args": { "message_ids": ["m1", "m2", "m3"] }
      }
    }
  }
  ```

  `allow = true` — three IDs is within the cap of 10.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-workspace-get_gmail_messages_content_batch", "type": "tool" },
      "payload": {
        "name": "gmail-workspace-get_gmail_messages_content_batch",
        "args": { "message_ids": ["m1", "m2", /* … */ "m12"] }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Gmail batch read requests 12 message/thread IDs; the cap is 10 per call. …"`.

  ### Transformed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gongrzhe-gmail-search_emails", "type": "tool" },
      "payload": {
        "name": "gongrzhe-gmail-search_emails",
        "args": { "query": "from:finance has:attachment", "maxResults": 200 }
      }
    }
  }
  ```

  `allow = true`, transform rewrites the args to
  `{ "query": "from:finance has:attachment", "maxResults": 25 }`. A call with
  no `maxResults` at all gets `maxResults: 25` injected the same way.

  ## Composition

  This policy bounds read *volume*; it does not inspect message *content* or
  guard the write path. Useful companions:

  - [`apps/gmail/guard-external-send`](../guard-external-send/policy.md) —
    ingress guard on outbound mail.
  - [`apps/gmail/guard-mailbox-persistence`](../guard-mailbox-persistence/policy.md) —
    blocks filter/auto-forward persistence primitives.
  - [`apps/gmail/role-gate-writes`](../role-gate-writes/policy.md) —
    identity-gates the Gmail write surface.

  ## Known limitations

  - **`search_gmail_messages` is documented, not clamped.** The taylorwilsdon
    server's search tool exists, but its page-size parameter name is
    unverified in the landscape research, so this policy does not rewrite it.
    Confirm the live parameter from `tools/list` and extend the clamp before
    relying on it.
  - **Per-call caps do not stop patient pagination.** Stateless Rego cannot
    track per-session cumulative volume: an agent that issues many
    10-ID batches or 25-result searches can still enumerate a mailbox — it
    just takes proportionally more calls. Use gateway audit logs / alerting
    to spot high-frequency crawls.
  - **Only the listed argument keys are covered.** A server that spells the
    batch key or page size differently is not covered — extend the policy if
    your `tools/list` shows other shapes.
  - **No identity-based exemptions.** All callers are capped equally. If an
    e-discovery or backup group legitimately needs larger batches, add an
    `input.subject.claims`-gated bypass as a separate rule.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - gmail
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
package gmail.ingress.cap_bulk_export

# Deny-by-default: batch mailbox content reads must present a bounded,
# well-formed ID array. Everything else is allowed (searches are clamped by
# the transform below, never denied).
default allow := false

# --- Tuning knobs --------------------------------------------------------------
# Maximum IDs a single batch content read may request.
max_batch_ids := 10

# Maximum results a single search_emails call may request.
max_search_results := 25

# --- Tool matching -------------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name, so we
# match case-insensitively by suffix to stay portable. Verify the exact names
# your gateway sends with the dump-input debug technique before production use.

# Batch content reads (taylorwilsdon/google_workspace_mcp, verified from source).
batch_tool_suffixes := [
    "get_gmail_messages_content_batch",
    "get_gmail_threads_content_batch",
]

is_batch_tool if {
    some suffix in batch_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

# The cap applies to the ingress hook only — egress hooks on the same tool
# names pass through.
is_capped_batch_call if {
    input.action == "tool_pre_invoke"
    is_batch_tool
}

# Search tool with a clampable page size (GongRzhe/Gmail-MCP-Server, verified).
is_search_tool if {
    endswith(lower(input.resource.name), "search_emails")
}

# --- Argument access (object.get everywhere — fields may be missing) -----------

args := object.get(input.payload, "args", {})

# The batch ID keys we inspect. The messages batch reads message_ids and the
# threads batch reads thread_ids, but we count BOTH keys on every batch call:
# checking only the first-present key would let an oversized array slip through
# in the other key alongside a small decoy (e.g. a threads-batch call carrying
# thread_ids: [50 items] plus a 2-item message_ids decoy would otherwise be
# selected on the small decoy and allowed while the server harvests the 50).
batch_id_keys := ["message_ids", "thread_ids"]

# The length of every ID key actually present as an array. A key that is
# absent, null, or the wrong type contributes nothing.
id_array_counts := [count(value) |
    some key in batch_id_keys
    value := object.get(args, key, null)
    is_array(value)
]

# A batch call is well-formed only when at least one ID key is a real array.
valid_batch_ids if {
    count(id_array_counts) > 0
}

# The largest present ID array drives the cap decision — an oversized array in
# either key trips the cap regardless of any smaller decoy in the other key.
max_batch_id_count := max(id_array_counts) if {
    count(id_array_counts) > 0
}

# --- Allow rules -----------------------------------------------------------------

# Anything that is not a capped batch content read passes through: single
# message/thread reads, searches, label tools, and egress hooks.
allow if {
    not is_capped_batch_call
}

# Batch content reads are allowed only with a well-formed ID array at or
# under the cap. If the ID argument is missing or not an array, no allow rule
# fires and the default deny holds (fail closed).
allow if {
    is_capped_batch_call
    valid_batch_ids
    max_batch_id_count <= max_batch_ids
}

# --- Deny reasons ---------------------------------------------------------------

reasons contains msg if {
    is_capped_batch_call
    valid_batch_ids
    max_batch_id_count > max_batch_ids
    msg := sprintf(
        "This Gmail batch read requests %d message/thread IDs; the cap is %d per call. Page through the mailbox in batches of %d IDs or fewer. Contact your InfoSec team if a sanctioned workflow needs a larger batch.",
        [max_batch_id_count, max_batch_ids, max_batch_ids],
    )
}

reasons contains msg if {
    is_capped_batch_call
    not valid_batch_ids
    msg := sprintf(
        "This Gmail batch read is missing a valid ID array (message_ids or thread_ids must be an array). Retry with an explicit array of %d or fewer IDs. Contact your InfoSec team if this was a false positive.",
        [max_batch_ids],
    )
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}

# --- Transform: clamp search_emails page size -----------------------------------

max_results_value := object.get(args, "maxResults", null)

# Clamp when maxResults is absent (the server's own default wins otherwise).
needs_max_results_clamp if {
    max_results_value == null
}

# Clamp when a numeric maxResults exceeds the cap.
needs_max_results_clamp if {
    is_number(max_results_value)
    max_results_value > max_search_results
}

# Clamp non-positive page sizes too. A maxResults of 0 or a negative number is
# not a smaller-than-cap request: Gmail's users.messages.list treats an
# absent/zero page size as its own default (100), and several servers read a
# negative value as "unbounded". Anything outside [1, cap] is rewritten to the
# cap so a non-positive value cannot slip the volume ceiling.
needs_max_results_clamp if {
    is_number(max_results_value)
    max_results_value < 1
}

# Fail safe: a non-numeric maxResults is replaced with the cap rather than
# letting the server's parsing decide.
needs_max_results_clamp if {
    max_results_value != null
    not is_number(max_results_value)
}

transform := {"transformed_payload": object.union(args, {"maxResults": max_search_results})} if {
    input.action == "tool_pre_invoke"
    is_search_tool
    needs_max_results_clamp
}
```
