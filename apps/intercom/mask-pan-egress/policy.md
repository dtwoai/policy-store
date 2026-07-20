---
name: "Intercom: Mask Card Numbers in Conversation Responses"
tags:
  - intercom
  - mask-pan-egress
  - egress
  - cardholder-data
  - dlp
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # intercom / mask-pan-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `intercom.egress.mask_pan`

  ## What it does

  Masks payment-card numbers (PANs) in Intercom conversation content returned
  to agents by the conversation- and free-text-returning read tools. Support
  chat is a well-known place for customers to paste a full card number into a
  message, and `get_conversation` returns every conversation part verbatim, so
  a read of that thread would otherwise place the full PAN into the agent's
  context. This makes conversation reads the cardholder-data egress path for
  Intercom.

  The policy Luhn-validates every 13–19-digit card-shaped sequence in the
  response (tolerating single spaces or hyphens between digit groups) and
  rewrites each match to **BIN-plus-last4**: the first six digits (the issuer
  BIN) and the last four are kept, and every digit in between becomes `*`, e.g.
  `4111 1111 1111 1111` → `411111******1111`. BIN+last4 is the maximum display
  format PCI DSS permits for personnel without a business need to see the full
  PAN. The Luhn check is mandatory here: it keeps false positives (order
  numbers, ticket IDs, conversation IDs) from being mangled.

  The policy never blocks a call. When at least one Luhn-valid PAN is found the
  response content blocks are rewritten via `transformed_payload`; when nothing
  matches, the transform rule is undefined and the response passes through
  byte-identical.

  Callers whose `input.subject.claims.groups` contains the documented
  placeholder group `pci-full-pan` receive unmasked responses, so fraud and
  chargeback staff who genuinely need the complete number still see it. The
  exemption is fail-closed: a caller with no subject, no claims, no `groups`
  claim, or a malformed `groups` claim is never exempt and always gets masked
  output.

  ## Why egress and not ingress

  Egress transform (default allow) is the right posture: the PAN already lives
  in Intercom (a customer typed it into the chat), so there is no write to
  block — the only enforceable action on the MCP path is masking the
  agent-visible copy of the number as it is read back. Ingress cannot help,
  because the sensitive data flows *out* of Intercom, not in.

  ## Tool name matching

  The policy scopes to conversation-content responses on
  `input.resource.name`, matched case-insensitively after normalizing `_` to
  `-` so both underscore (as the official server publishes them) and
  hyphenated (community `search-conversations`) forms match:

  - **`*get_conversation`** — the official Intercom MCP server's full-thread
    read; returns every conversation part body verbatim. The main egress
    surface.
  - **`*search_conversations`** (official, snake_case) and
    **`*search-conversations`** (fabian1710/mcp-intercom, kebab-case) —
    filtered conversation search whose results carry conversation-part text.
  - **`*list_conversations`**, **`*search_conversations_by_customer`**,
    **`*search_tickets_by_customer`**, and **`*search_tickets_by_status`**
    (raoulbia-ai/mcp-server-for-intercom, the most-listed community server) —
    conversation and ticket reads that return full customer free-text bodies.
    Ticket bodies are support-chat content and carry the same paste-a-card-number
    risk as conversations, so they are in scope. Matched unconditionally like the
    other typed reads.

  Two generic connector aliases are handled specially. The official server
  also exposes the OpenAI/Anthropic-convention `search` and `fetch` tools that
  *alias* the typed tools (`search` with `object_type: "conversations"`, or
  `fetch` resolving a `conversation_…`-prefixed ID both return conversation
  bodies). A policy that matched only `search_conversations` and not these two
  would be trivially bypassed. Because an **egress** policy sees only the
  response — not the request's `object_type` / fetch-ID argument — `*search`
  and `*fetch` are brought into scope only when the response itself carries a
  conversation marker (a `conversation_`-prefixed ID or a
  `"type":"conversation"` object), which is the egress-observable proxy for
  "this was a conversation search / fetch". Contact, company, and article
  responses from `search`/`fetch` carry no such marker and pass through
  untouched.

  Structured PII tools (`get_contact`, `search_contacts`, `get_company`,
  articles) are deliberately out of scope — card data in a contact profile is
  a separate concern with a different exemption group; see Composition.

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `intercom-mcp-get_conversation`), and that prefix is not standardized —
  suffix matching keeps the policy portable. The official server's names are
  verified against Intercom's developer docs and the Speakeasy governance
  catalog; verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production.

  ## Patterns matched

  Conservative, anchored PAN shapes only — each pattern is commented in the
  Rego, and every candidate must also pass the Luhn check before it is masked:

  - 16-digit PANs grouped 4-4-4-4 with space or dash separators
    (Visa/Mastercard/Discover print format).
  - 15-digit American Express PANs grouped 4-6-5, constrained to the 34/37
    IIN range.
  - Unseparated 13–19-digit runs (the ISO/IEC 7812 PAN length range). Runs of
    20+ digits never match: there is no word boundary inside a digit run, so a
    longer identifier is never partially masked.

  ## Compliance alignment

  - **PCI DSS 3.4.1** — supports masking of PAN when displayed: the agent
    channel shows at most BIN+last4, with full-PAN visibility limited to a
    defined role (`pci-full-pan`).
  - **PCI DSS 3.4.2** — supports preventing copy/relocation of PAN via
    remote-access technologies: an agent that only ever receives the masked
    form cannot re-post the full PAN into tickets, other chats, or files.
  - **PCI DSS 12.5.2 / 12.10.7** — supports PCI scope control and
    PAN-where-not-expected incident procedures: support chat is a classic
    not-expected location for cardholder data, and the gateway's
    decision/transform audit events for this policy give the incident process
    a concrete trigger to work from.
  - **CCPA/CPRA §1798.150** — supports reducing nonredacted-PI breach
    exposure: card numbers surfaced to agents from customer conversations are
    masked by default.
  - **SOC 2 CC6.7** — supports restricting the transmission, movement, and
    removal of confidential information: masking cardholder data in the
    agent-visible copy of conversation reads keeps the full PAN from leaving the
    gateway toward the agent.
  - Also maps to **ISO 27001 A.8.11** (data masking) on the MCP path, if you
    track that framework.

  ## Response shape

  Egress tool output arrives as content blocks in `input.payload.text` (an
  array; entries are typically strings of plain text, markdown, or serialized
  JSON). The policy scans each string block, replaces every Luhn-valid match
  with its own BIN+last4 form, and emits `transform.transformed_payload` with
  the original payload's `text` replaced by the masked blocks. Non-string
  blocks pass through unmodified. Because matching is string-level, PANs are
  masked wherever they appear in a block — part `body` text, search snippets,
  serialized-JSON conversation objects — without parsing Intercom's specific
  conversation schema.

  ## Examples

  ### Transformed (masked)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "intercom-mcp-get_conversation", "type": "tool" },
      "payload": {
        "name": "intercom-mcp-get_conversation",
        "text": ["{\"conversation_parts\":[{\"body\":\"my card is 4111 1111 1111 1111\"}]}"]
      },
      "subject": { "sub": "google-apps|casey@acme.com", "claims": { "groups": ["support"] } }
    }
  }
  ```

  `allow = true`; the agent sees
  `{"conversation_parts":[{"body":"my card is 411111******1111"}]}`.

  ### Allowed unmasked (exempt group)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "intercom-mcp-get_conversation", "type": "tool" },
      "payload": {
        "name": "intercom-mcp-get_conversation",
        "text": ["{\"conversation_parts\":[{\"body\":\"my card is 4111 1111 1111 1111\"}]}"]
      },
      "subject": { "sub": "google-apps|fraud-analyst@acme.com", "claims": { "groups": ["pci-full-pan"] } }
    }
  }
  ```

  `allow = true`, no transform — the caller is in the `pci-full-pan` group.

  ### Passthrough (no PAN / not a conversation)

  A Luhn-invalid digit run (a ticket ID, an order number) produces no
  transform. A `search`/`fetch` response with no conversation marker (a
  contact or company result) is out of scope and passes through
  byte-identical.

  ## Composition

  One policy, one job. Useful companions:

  - A **PII redaction** egress policy (PF-02 `redact-pii-egress`) for SSNs,
    national IDs, emails, phones, and credentials in conversation and contact
    responses — broader PII is a separate concern from cardholder data, with a
    different exemption group.
  - `apps/intercom/cap-bulk-export` (PF-08) for volume control on
    `search_contacts` / `search_conversations` — masking does not stop mass
    harvesting of masked content.
  - An ingress role-gate (PF-04/PF-12 style) on `get_contact` /
    `search_contacts` / `fetch` with `contact_`/`company_`-prefixed IDs, so
    analytics users get conversations but not full customer profiles.

  ## Known limitations

  - **Luhn-valid non-card numbers are masked too.** The Luhn check eliminates
    most timestamps and IDs, but some non-card identifiers (certain IMEIs and
    other checksummed numbers) are Luhn-valid and will be masked. The masked
    form keeps first-six/last-four, so such false positives usually stay
    recognizable.
  - **A PAN split across conversation parts is missed.** `get_conversation`
    returns each part as its own body, and the gateway delivers them as
    separate content blocks. A single card number typed across two parts
    (e.g. `4111 1111` in one message and `1111 1111` in the next) leaves no
    block with 13+ contiguous card digits, so neither block matches and the
    PAN is not masked. Matching is per-block by design (cross-block
    concatenation would produce spurious matches from unrelated adjacent
    numbers). A test case pins this residual.
  - **Obfuscated PANs are missed.** Card numbers separated by characters other
    than a single space or dash (dots, unicode spaces, non-digit filler such as
    `4111.1111.1111.1111` or `4111x1111x1111x1111`), split across lines,
    spelled out in words, or base64-encoded do not match. Card numbers typed
    with non-ASCII digits (e.g. Unicode fullwidth `４１１１ …`) also do not
    match: the RE2 `\d` class is ASCII-only. Grouped formats other than 4-4-4-4
    and Amex 4-6-5 (e.g. 19-digit 4-4-4-4-3 print format) match only in their
    unseparated form.
  - **A PAN glued directly to a word character is missed.** Every pattern is
    `\b`-anchored, and the underscore counts as a word character in RE2, so a
    digit run immediately preceded or followed by a letter, digit, or
    underscore with no separator (e.g. `conversation_4111111111111111` inside a
    serialized-JSON token value) has no word boundary and is not masked. This
    is the deliberate cost of the same `\b` anchoring that stops a 20+-digit
    identifier from being partially masked. Punctuation- or whitespace-
    delimited PANs (the normal human-typed case) are unaffected.
  - **Generic `search`/`fetch` scoping depends on a conversation marker in the
    response.** Because egress cannot see the request's `object_type` / fetch
    ID, `*search` and `*fetch` are masked only when the response contains a
    `conversation_`-prefixed ID or a `"type":"conversation"` object. The typed
    `*get_conversation` and `*search_conversations` tools are masked
    unconditionally, so this affects only the generic aliases: if a server's
    conversation `search`/`fetch` response omits both markers, those responses
    are not masked. Verify your server's response shape with the dump-input
    technique.
  - **Structured (non-string) content blocks and non-array `text` are not
    masked — fail-open.** The policy scans and rewrites only string entries of
    `input.payload.text`, and only when `text` is a JSON array. A PAN carried
    inside a content block delivered as a JSON *object* (an MCP typed
    `{"type":"text","text":"…"}` block), or a `payload.text` delivered as a
    bare string, passes through unmasked. In the DTwo egress shape observed to
    date tool output arrives as an array of *string* blocks, and serialized
    JSON inside a string block **is** scanned and masked; only native object
    shapes and non-array `text` evade it. Confirm with the dump-input technique
    that your gateway/server delivers string blocks before relying on this
    policy against servers that emit typed content objects.
  - **Only surveyed servers' conversation/ticket reads are in scope.** Scope is
    the union of the official, fabian1710, and raoulbia read tools that return
    conversation or ticket bodies. A conversation-returning tool from another
    (or future) community server whose suffix is not in the list — e.g.
    evolsb/fast-intercom-mcp's `sync_conversations`, or any renamed upstream
    tool — is not masked. Add its suffix to `typed_conversation_suffixes` (or,
    for a generic `search`/`fetch` alias, rely on the response conversation
    marker). Confirm your gateway's actual tool names with the dump-input
    technique.
  - **MCP path only.** The full card number still exists in Intercom and in
    Intercom's own inbox/web UI; this policy controls what the *agent* sees on
    the MCP path. Reads made outside MCP (the Intercom inbox, REST API scripts,
    Fin's own actions) are out of the gateway's reach.
  - **Group names are placeholders** — replace `pci-full-pan` with your IdP's
    group name at import time. The exemption reads `input.subject.claims.groups`
    and requires it to be an **array** of strings; every other shape (string,
    object, number, null, or missing) fails closed to masked output. Confirm
    your IdP emits a `groups` claim as a string array for your tenant before
    relying on the exemption.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - intercom
industries: []
bundles:
  - soc2
  - pci-dss
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package intercom.egress.mask_pan

# Transform-only policy — never denies, only masks Luhn-valid card numbers
# in Intercom conversation responses to BIN+last4.
default allow := true

# -----------------------------------------------------------------------------
# Tool matching — conversation-content read tools across the Intercom MCP
# server vocabularies in real use. The gateway prefixes tool names with the
# configured server name, so we match on the suffix to stay portable. The
# incoming name is normalized `_` -> `-` first so both `search_conversations`
# (official snake_case) and `search-conversations` (fabian1710 kebab) match.
# -----------------------------------------------------------------------------

normalized_name := replace(lower(input.resource.name), "_", "-")

# Typed conversation-returning tools — always in scope. Their responses are
# conversation-part bodies, so no response-content check is needed.
typed_conversation_suffixes := [
    # Official Intercom MCP server — full-thread read (all parts verbatim).
    "get-conversation",
    # Official (search_conversations) and fabian1710 (search-conversations).
    "search-conversations",
    # raoulbia-ai/mcp-server-for-intercom — the most-listed community server.
    # Its conversation and ticket reads return full customer free-text bodies,
    # the same PAN egress surface, so they are in scope unconditionally.
    "list-conversations",
    "search-conversations-by-customer",
    "search-tickets-by-customer",
    "search-tickets-by-status",
]

is_typed_conversation_read if {
    some suffix in typed_conversation_suffixes
    endswith(normalized_name, suffix)
}

# Generic OpenAI/Anthropic-convention aliases that the official server exposes
# alongside the typed tools. `search` (object_type "conversations") and `fetch`
# (a conversation_ ID) both return conversation bodies. An egress policy cannot
# see the request's object_type / fetch-ID argument, so these are scoped by a
# conversation marker in the RESPONSE instead (see response_is_conversation).
is_generic_alias if {
    some suffix in ["search", "fetch"]
    endswith(normalized_name, suffix)
}

# -----------------------------------------------------------------------------
# Response content inspection.
# -----------------------------------------------------------------------------

text_blocks := object.get(input.payload, "text", [])

# True when any string block carries an Intercom conversation marker: a
# `conversation_`-prefixed ID (the fetch/search ID convention) or a
# `"type":"conversation"` object (conversation / conversation_part). This is
# the egress-observable proxy for "this search/fetch was over conversations".
response_is_conversation if {
    some block in text_blocks
    is_string(block)
    regex.match(`(?i)(conversation_|"type"\s*:\s*"conversation)`, block)
}

# A response is in scope if it is a typed conversation read, or a generic
# search/fetch whose response looks like conversation data.
in_scope if is_typed_conversation_read

in_scope if {
    is_generic_alias
    response_is_conversation
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
# ticket IDs, and other digit runs that merely look like PANs are left alone.
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
# groups claim all leave this rule undefined, so masking applies. The is_array
# guard is load-bearing: without it a groups claim shaped as an object (e.g.
# {"role":"pci-full-pan"}) would iterate its *values* and match, granting the
# exemption to a caller who never held the group in an array. Requiring an
# array keeps every non-array shape (string, object, number, null) fail-closed.
# Replace "pci-full-pan" with your IdP's group name at import time.
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

masked_blocks := [out |
    some block in text_blocks
    out := mask_block(block)
]

transform := {
    "transformed_payload": object.union(input.payload, {"text": masked_blocks}),
} if {
    input.mode == "output"
    in_scope
    not caller_may_view_full_pan
    is_array(text_blocks)
    masked_blocks != text_blocks
}
```
