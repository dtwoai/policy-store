---
name: "Slack: Mask Card Numbers in Message and Search Responses"
tags:
  - slack
  - mask-pan-egress
  - egress
  - cardholder-data
  - dlp
  - pci-dss
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # slack / mask-pan-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `slack.egress.mask_pan`

  ## What it does

  Masks payment-card numbers (PANs) in Slack content returned to agents by
  message-read, thread-read, canvas-read, history, and search tools. Humans
  type card numbers into chat — DMs with customers, support channels, order
  threads — and every read of that history would otherwise place the full PAN
  into the agent's context. This policy Luhn-validates every 13–19-digit
  card-shaped sequence in the response and rewrites each match to
  **BIN-plus-last4**: the first six digits (the issuer BIN) and last four are
  kept, and every digit in between becomes `*`, e.g.
  `4111 1111 1111 1111` → `411111******1111`. BIN+last4 is the maximum
  display format PCI DSS permits for personnel without a business need to
  see full PAN.

  The policy never blocks a call. When at least one PAN is found the response
  content blocks are rewritten via `transformed_payload`; when nothing
  matches, the transform rule is undefined and the response passes through
  byte-identical.

  Callers whose `input.subject.claims.groups` contains the documented
  placeholder group `pci-full-pan` receive unmasked responses. The exemption
  is fail-closed: a caller with no subject, no claims, no `groups` claim, or
  a malformed `groups` claim is never exempt and always gets masked output.

  ## Compliance alignment

  - **PCI DSS 3.4.1** — supports masking of PAN when displayed: the agent
    channel shows at most BIN+last4, with full-PAN visibility limited to a
    defined role (`pci-full-pan`).
  - **PCI DSS 3.4.2** — supports preventing copy/relocation of PAN via
    remote-access technologies: an agent that only ever receives the masked
    form cannot re-post the full PAN into other channels, tickets, or files.
  - **PCI DSS 12.10.7** — supports PAN-where-not-expected incident
    procedures: chat is a classic not-expected location, and the gateway's
    decision/transform audit events for this policy give the incident
    process a concrete trigger to work from.
  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    confidential information: cardholder data read back from Slack does not
    move into agent context in full.
  - **CCPA/CPRA §1798.150** — supports reducing nonredacted-PI breach
    exposure: card numbers surfaced to agents from chat history are masked
    by default.

  ## Tool name matching

  The policy matches content-returning Slack read tools case-insensitively
  by suffix on `input.resource.name`, after normalizing `_` to `-` so both
  underscore (as the servers publish them) and hyphenated (as some gateways
  deliver them) forms match. It covers all three Slack MCP server
  vocabularies in real use:

  - **Official Slack MCP server** (`mcp.slack.com`, what the Claude
    connector uses): `slack_read_channel`, `slack_read_thread`,
    `slack_read_canvas`, `slack_search_public`,
    `slack_search_public_and_private`.
  - **korotovsky/slack-mcp-server**: `conversations_history`,
    `conversations_replies`, `conversations_search_messages`,
    `conversations_unreads`, `saved_list` (the last two also return message
    bodies, so they are in scope for masking).
  - **Archived reference server** (still widely forked):
    `slack_get_channel_history`, `slack_get_thread_replies`.

  Directory tools (`slack_search_channels`, `slack_search_users`,
  `slack_read_user_profile`, `channels_list`, …) return metadata, not
  message bodies, and are deliberately out of scope — see the companion
  profile-PII policy in Composition.

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `slack-mcp-slack_read_channel`), and that prefix is not
  standardized — suffix matching keeps the policy portable. The official
  server's names are observed-current, not contractual (Slack documents
  `tools/list` as the source of truth and says names can change), so verify
  the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  ## Patterns matched

  Conservative, anchored PAN shapes only — each pattern is commented in the
  Rego, and every candidate must also pass the Luhn check before it is
  masked, which keeps false positives (Slack timestamps, order IDs, phone
  numbers) low:

  - 16-digit PANs grouped 4-4-4-4 with space or dash separators
    (Visa/Mastercard/Discover print format).
  - 15-digit American Express PANs grouped 4-6-5, constrained to the 34/37
    IIN range.
  - Unseparated 13–19-digit runs (the ISO/IEC 7812 PAN length range). Runs
    of 20+ digits never match: there is no word boundary inside a digit
    run, so a longer identifier is never partially masked.

  ## Response shape

  Egress tool output arrives as content blocks in `input.payload.text` (an
  array; entries are typically strings of plain text, markdown, or
  serialized JSON). The policy scans each string block, replaces every
  Luhn-valid match with its own BIN+last4 form, and emits
  `transform.transformed_payload` with the original payload's `text`
  replaced by the masked blocks. Non-string blocks pass through unmodified.
  Because matching is string-level, PANs are masked wherever they appear —
  message bodies, search snippets, canvas markdown — without parsing each
  tool's specific JSON shape.

  ## Examples

  ### Transformed (masked)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "slack-mcp-slack_read_thread", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_read_thread",
        "text": ["customer: my card is 4111 1111 1111 1111, exp 12/27"]
      },
      "subject": { "sub": "google-apps|casey@acme.com", "claims": { "groups": ["support"] } }
    }
  }
  ```

  `allow = true`; the agent sees
  `customer: my card is 411111******1111, exp 12/27`.

  ### Allowed unmasked (exempt group)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "slack-mcp-slack_read_thread", "type": "tool" },
      "payload": {
        "name": "slack-mcp-slack_read_thread",
        "text": ["customer: my card is 4111 1111 1111 1111, exp 12/27"]
      },
      "subject": { "sub": "google-apps|pci-analyst@acme.com", "claims": { "groups": ["pci-full-pan"] } }
    }
  }
  ```

  `allow = true`, no transform — the caller is in the `pci-full-pan` group.

  ### Passthrough (no PAN)

  A Luhn-invalid digit run (a Slack message timestamp, an order number)
  produces no transform; the response is returned byte-identical.

  ## Composition

  First egress policy for Slack — the five existing Slack policies are all
  ingress. One policy, one job; useful companions:

  - [`redact-sensitive-info`](../redact-sensitive-info/policy.md) (ingress)
    covers the opposite direction: it redacts card numbers and other
    sensitive shapes from messages the agent *writes* into Slack. Attach
    both for round-trip coverage.
  - [`deny-read-search-summarize-sensitive-channels`](../deny-read-search-summarize-sensitive-channels/policy.md)
    and [`guard-dm-privacy`](../guard-dm-privacy/policy.md) (ingress) stop
    the highest-risk reads outright; this policy masks card data in the
    reads you do allow.
  - A profile-PII egress policy (PF-02 style) for
    `slack_read_user_profile` / `slack_search_users` responses — directory
    PII is a separate concern from cardholder data, with a different
    exemption group.

  ## Known limitations

  - **Luhn-valid non-card numbers are masked too.** The Luhn check
    eliminates most timestamps and IDs, but some non-card identifiers
    (certain IMEIs and other checksummed numbers) are Luhn-valid and will
    be masked. The masked form keeps first-six/last-four, so such false
    positives usually stay recognizable.
  - **Obfuscated PANs are missed.** Card numbers with separators other
    than space/dash (dots, unicode spaces), split across lines or content
    blocks, spelled out in words, or base64-encoded do not match. Card
    numbers typed with non-ASCII digits (e.g. Unicode fullwidth
    `４１１１ １１１１ １１１１ １１１１`) also do not match: the RE2 `\d`
    class is ASCII-only, so fullwidth/other Unicode digit codepoints are
    never seen as digits. Grouped formats other than 4-4-4-4 and Amex 4-6-5
    (e.g. 19-digit 4-4-4-4-3 print format) match only in their unseparated
    form.
  - **A PAN glued directly to a word character is missed.** Every pattern
    is `\b`-anchored, and the underscore counts as a word character in RE2,
    so a digit run immediately preceded or followed by a letter, digit, or
    underscore with no separator (e.g. `acct_4111111111111111` or
    `card4111111111111111x` inside a serialized-JSON token value) has no
    word boundary and is not masked. This is the deliberate cost of the
    same `\b` anchoring that stops a 20+-digit identifier from being
    partially masked — dropping the anchor would trade this evasion for
    false partial-masking of longer numbers. Punctuation- or
    whitespace-delimited PANs (the normal human-typed case) are unaffected.
  - **Adjacent digit groups can shadow a grouped PAN.** In pathological
    sequences like `1234 5678 4111 1111 1111 1111`, the leftmost 4-4-4-4
    window is consumed first (and fails Luhn), so the real PAN inside it
    is not matched. Unseparated PANs are unaffected.
  - **Substring collisions between two detected PANs.** Replacements are
    applied per distinct matched string in unspecified order; if one
    detected PAN is a literal substring of another in the same block
    (both Luhn-valid), more than BIN+last4 of the longer one can remain
    visible. Middle digits of every match still get masked.
  - **Structured (non-string) content blocks and non-array `text` are not
    masked — fail-open.** The policy scans and rewrites only string entries
    of `input.payload.text`, and only when `text` is a JSON array. A PAN
    carried inside a content block delivered as a JSON *object* (e.g. an MCP
    typed block `{"type":"text","text":"…4111 1111 1111 1111…"}`) passes
    through unmasked, and if a server delivers `payload.text` as a bare
    string instead of an array the transform never fires — in both cases the
    response is returned byte-identical and the PAN reaches the agent. In the
    DTwo egress shape observed to date tool output arrives as an array of
    *string* blocks, and serialized JSON inside a string block **is** scanned
    and masked; only native object shapes and non-array `text` evade it.
    Confirm with the dump-input technique that your gateway/server delivers
    string blocks before relying on this policy against servers that emit
    typed content objects — pair with a schema-aware egress transform if
    yours does.
  - **Egress masking only.** The full card number still exists in Slack
    itself and in Slack's own UI; this policy controls what the *agent*
    sees on the MCP path. Pair with the ingress `redact-sensitive-info`
    policy to keep agents from writing card numbers into Slack.
  - **Tool names are observed, not contractual.** The official Slack MCP
    server publishes exact tool names only at runtime; the names matched
    here are corroborated from the landscape research but may change.
    korotovsky and reference-server names are verified from their
    README/source. Emoji/file/reaction capabilities of the official server
    have no verifiable tool names and are not covered.
  - **Group names are placeholders** — replace `pci-full-pan` with your
    IdP's group name at import time. The exemption reads
    `input.subject.claims.groups` and requires it to be an **array** of
    strings; every other shape (string, object, number, null, or missing)
    fails closed to masked output. Confirm your IdP emits a `groups` claim
    as a string array for your tenant before relying on the exemption.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - slack
industries: []
bundles:
  - pci-dss
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.egress.mask_pan

# Transform-only policy — never denies, only masks Luhn-valid card numbers
# in Slack read/search/history responses to BIN+last4.
default allow := true

# -----------------------------------------------------------------------------
# Tool matching — content-returning Slack read tools across the three MCP
# server vocabularies in real use. The gateway prefixes tool names with the
# configured server name, so we match on the suffix to stay portable.
# Suffixes are hyphenated; the incoming name is normalized `_` -> `-` first so
# both `slack_read_channel` and `slack-read-channel` deliveries match.
# -----------------------------------------------------------------------------

content_read_suffixes := [
    # Official Slack MCP server (mcp.slack.com — used by the Claude connector).
    "slack-read-channel",
    "slack-read-thread",
    "slack-read-canvas",
    "slack-search-public",
    "slack-search-public-and-private",
    # korotovsky/slack-mcp-server (community).
    "conversations-history",
    "conversations-replies",
    "conversations-search-messages",
    # korotovsky content-returning reads that also carry message bodies:
    # unread messages and the saved-items list both return message text.
    "conversations-unreads",
    "saved-list",
    # Archived reference server (deprecated but still widely forked).
    "slack-get-channel-history",
    "slack-get-thread-replies",
]

normalized_name := replace(lower(input.resource.name), "_", "-")

is_content_read_tool if {
    some suffix in content_read_suffixes
    endswith(normalized_name, suffix)
}

# -----------------------------------------------------------------------------
# PAN candidate shapes — anchored with \b word boundaries so digit runs inside
# longer identifiers are never partially matched. Every candidate must also
# pass the Luhn check below before it is masked.
# -----------------------------------------------------------------------------

pan_pattern := concat("|", [
    # 16-digit PANs grouped 4-4-4-4 with space or dash separators
    # (Visa / Mastercard / Discover print format, e.g. 4111 1111 1111 1111).
    `\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b`,
    # 15-digit American Express PANs grouped 4-6-5 with space or dash
    # separators, constrained to the 34/37 IIN range (e.g. 3782 822463 10005).
    `\b3[47]\d{2}[ -]\d{6}[ -]\d{5}\b`,
    # Unseparated 13-19 digit runs — the ISO/IEC 7812 PAN length range.
    # Runs of 20+ digits never match: there is no word boundary inside a
    # digit run, so this cannot partially mask a longer identifier.
    `\b\d{13,19}\b`,
])

# -----------------------------------------------------------------------------
# Luhn check — filters card-shaped candidates so timestamps, order numbers,
# and other digit runs that merely look like PANs are left alone.
# -----------------------------------------------------------------------------

digits_only(s) := regex.replace(s, `[^0-9]`, "")

luhn_contribution(d, parity) := d if { parity == 0 }

luhn_contribution(d, parity) := 2 * d if {
    parity == 1
    (2 * d) < 10
}

luhn_contribution(d, parity) := (2 * d) - 9 if {
    parity == 1
    (2 * d) >= 10
}

luhn_valid(digits) if {
    chars := split(digits, "")
    n := count(chars)
    total := sum([v |
        some i, c in chars
        v := luhn_contribution(to_number(c), (n - 1 - i) % 2)
    ])
    total % 10 == 0
}

# All card-shaped substrings of t that pass the Luhn check.
pan_candidates(t) := {c |
    some c in regex.find_n(pan_pattern, t, -1)
    luhn_valid(digits_only(c))
}

# -----------------------------------------------------------------------------
# Masking — each match is rewritten to BIN+last4: first six digits (issuer
# BIN) and last four kept, everything between masked with `*`. Separators are
# dropped in the masked form (e.g. `4111 1111 1111 1111` -> `411111******1111`).
# -----------------------------------------------------------------------------

mask_pan(c) := masked if {
    d := digits_only(c)
    n := count(d)
    masked := concat("", [
        substring(d, 0, 6),
        # Replace every middle digit with `*` (RE2 has no repeat builtin, so we
        # mask the middle substring char-by-char instead of building a `*` run).
        regex.replace(substring(d, 6, n - 10), `\d`, "*"),
        substring(d, n - 4, 4),
    ])
}

# Rewrite every Luhn-valid candidate in a string block to its masked form.
mask_block(b) := out if {
    is_string(b)
    replacements := {c: mask_pan(c) | some c in pan_candidates(b)}
    count(replacements) > 0
    out := strings.replace_n(replacements, b)
}

mask_block(b) := b if {
    is_string(b)
    count(pan_candidates(b)) == 0
}

# Non-string content blocks (structured/JSON blocks) pass through unmodified.
mask_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Full-PAN exemption — callers in the placeholder group see unmasked content.
# Fail-closed: missing subject, missing claims, missing groups, or a malformed
# groups claim all leave this rule undefined, so masking applies. The
# is_array guard is load-bearing: without it a groups claim shaped as an
# object (e.g. {"role":"pci-full-pan"}) would iterate its *values* and match,
# granting the exemption to a caller who never held the group in an array.
# Requiring an array keeps every non-array shape (string, object, number,
# null) fail-closed. Replace "pci-full-pan" with your IdP's group name at
# import time.
# -----------------------------------------------------------------------------

caller_may_view_full_pan if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    group == "pci-full-pan"
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not exempt, and at
# least one block actually changed. Otherwise the rule is undefined and the
# aggregator skips this policy, returning the response byte-identical.
# -----------------------------------------------------------------------------

text_blocks := object.get(input.payload, "text", [])

masked_blocks := [out |
    some block in text_blocks
    out := mask_block(block)
]

transform := {
    "transformed_payload": object.union(input.payload, {"text": masked_blocks}),
} if {
    input.mode == "output"
    is_content_read_tool
    not caller_may_view_full_pan
    is_array(text_blocks)
    masked_blocks != text_blocks
}
```
