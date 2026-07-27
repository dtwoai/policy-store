---
name: "Intercom: Redact PII from Conversation & Contact Reads"
tags:
  - intercom
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # intercom / redact-conversation-pii

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `intercom.egress.redact_conversation_pii`

  ## What it does

  Scans the free-text returned by Intercom's conversation- and contact-read
  MCP tools and rewrites high-confidence personal identifiers and
  credential shapes to fixed redaction tokens before the response reaches the
  agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | canonical hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Government / national ID | label-anchored (`ssn`, `national id`, `passport`, `nino`, `tax id`, `tin`) followed by an identifier run | `[REDACTED-ID]` |
  | Email address | RFC-shaped `local@domain.tld`, word-boundary anchored | `[REDACTED-EMAIL]` |
  | Phone number | separator-formatted US shapes (`206-555-0100`, `(206) 555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |
  | Credential | `key: value` secrets (`password`/`token`/`api_key`/…), AWS/GitHub/Slack/Stripe/Google/OpenAI token prefixes, JWTs (`eyJ…`, incl. `Authorization: Bearer eyJ…`), PEM private-key headers | `[REDACTED-CREDENTIAL]` |

  Conversations are **raw customer free-text**: customers routinely paste
  government IDs, health details, and login credentials into support chats,
  and `get_conversation` / `search` / `fetch` return the full thread including
  every conversation-part `body`. Contact profiles add structured PII (email,
  phone) and custom attributes. This is the primary regulated-data egress on
  the Intercom surface, so the policy masks those shapes in the response while
  leaving the surrounding structure (IDs, timestamps, thread metadata) intact
  and usable.

  The policy is transform-only (`default allow := true`): it never denies a
  call, so a legitimate conversation or contact lookup still succeeds — it
  just comes back with identifiers and secrets masked. Responses with no
  matches, and all out-of-scope tools, pass through byte-identical. Every
  field (the payload, the content-block array, the parts/body/custom-attribute
  text) is read via `object.get` chains, so a missing or reshaped response body
  is never an error — it simply passes through unredacted (fail-open for
  observability only; see Known limitations).

  ### Uniform redaction (no group exemption)

  Unlike the group-gated redaction policies elsewhere in the catalog, this
  policy applies redaction **uniformly to every caller**. The dominant Intercom
  community servers authenticate with a single **workspace-wide access token**
  and expose no per-user identity to the gateway, so there is no reliable IdP
  claim to gate on for those deployments. Rather than ship a group exemption
  that silently never matches (and would fail open toward disclosure on the
  official OAuth server if misconfigured), redaction here is uniform. If your
  deployment uses the official OAuth server and needs a `pii-cleared`-style
  exemption, add a `subject.claims.groups` check as a separate `transform`
  guard — see the `snowflake/redact-pii-egress` policy for the placeholder-group
  pattern.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in conversation and
    contact reads as they leave the gateway toward the agent. **C1.1** —
    supports identification and protection of confidential information on the
    support read path; **P4.1** — supports limiting personal-information use to
    identified purposes (agents triage threads without the raw identifiers they
    don't need); **P6.1** — supports controls over personal-information
    disclosure by keeping raw identifiers out of agent context.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits: the agent sees a working thread with identifiers masked,
    not the raw regulated data customers pasted into chat. **§164.514(a)–(b)** —
    supports de-identification practice by stripping Safe-Harbor identifier
    classes (SSN, national ID, email, phone) from responses; **§164.530(c)** —
    supports privacy safeguards on the agent channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of customer
    personal data; **Art. 9** — reduces special-category exposure on the MCP
    path where health details co-occur with identifiers in free-text chat;
    **Art. 5(1)(f) / Art. 32** — supports security of processing on the agent
    channel.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, government ID) on the agent channel;
    **§1798.150** — reduces nonredacted-PI breach exposure if agent context or
    downstream logs are later compromised.

  ## Why egress (transform, default allow)

  The sensitive data already lives inside Intercom — there is nothing to block
  at ingress, and denying conversation or contact reads outright would make the
  agent useless for everyday support triage. The only reachable control is
  masking what the agent is allowed to *see*, and that leak happens when the
  thread or profile is returned to the MCP client. So the response path is the
  only place to catch it while keeping the result useful. Gating *which* tools
  can be called at all, and capping bulk enumeration, are separate concerns for
  companion ingress policies.

  ## Tool name matching

  Applies on the output path to Intercom's conversation- and contact-read
  channels. The gateway prefixes tool names with the configured MCP server name
  (not standardised), so matching is case-insensitive and **by suffix**, checked
  across `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — a match on **any** of the three puts the response in
  scope, so a gateway build that populates only one surface can't slip data past
  the scanner.

  **Always in scope (typed conversation/contact reads):**

  - `*get_conversation` — full thread incl. all conversation parts (official)
  - `*search_conversations` — filtered conversation search (official, snake_case)
  - `*search-conversations` — the same tool on the community `fabian1710`
    server, which uses **kebab-case**; the suffix set tolerates both separators
  - `*get_contact` — full contact PII profile (official)
  - `*search_contacts` — contact search (official)
  - `*list_conversations`, `*search_conversations_by_customer`,
    `*search_tickets_by_customer`, `*search_tickets_by_status` — the community
    `raoulbia-ai/mcp-server-for-intercom` server's date-windowed conversation
    and ticket reads. It authenticates with a workspace-wide token and returns
    the same raw customer free-text, so its reads are always in scope too. Its
    names end in `_by_customer` / `_by_status` (not the `search_conversations`
    suffix), so they are matched explicitly rather than by the generic branch.
  - `*sync_conversations` — the community `evolsb/fast-intercom-mcp` caching
    layer's cache-sync reader. Its other tools (`search_conversations` /
    `get_conversation`) already match the suffixes above; `sync_conversations`
    is named explicitly so this negligible-adoption server's conversation-read
    surface is fully covered rather than leaving one reader unredacted.

  **Conditionally in scope (the generic connector aliases):**

  The official server also exposes the generic `search` / `fetch` pair
  (OpenAI/Anthropic connector convention) that alias the typed tools. A policy
  that matched only the typed tools would be trivially bypassed by calling
  `search` with `object_type: "conversations"` or `fetch` on a `conversation_`
  ID. Those are covered two ways, so the coverage holds regardless of what the
  egress hook carries:

  1. **Request-arg gating** — a `*search` whose request `object_type ==
     "conversations"`, or a `*fetch` whose request `id` starts with
     `conversation_`, read from `input.payload.args` via `object.get`. This is
     the literal request-side scope, available when the gateway mirrors request
     args onto the egress hook.
  2. **Response-content fallback** — a `*search` / `*fetch` whose returned
     payload carries an Intercom conversation marker (`"conversation_parts"` or
     a `"type": "conversation"` object). This is purely response-driven, so it
     fires on the egress hook even on gateway builds that do **not** mirror
     request args.

  All official tool names are verified against Intercom's developer docs and the
  Speakeasy governance catalog (which agree; the vendor GitHub README is stale).
  The kebab `search-conversations` is verified from the `fabian1710/mcp-intercom`
  README; the `raoulbia-ai` conversation/ticket read names are verified from
  that repo's README. Verify the exact names your gateway emits with the
  dump-input debug technique before relying on this in production.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each **string** block
  (including string blocks containing serialized JSON, since the regexes run
  over the serialized text — conversation-part `body`, contact fields, and
  `custom_attributes` are all covered wherever they appear in the text).
  Non-string blocks pass through unmodified. When at least one block changes,
  the policy emits `transform.transformed_payload` containing the original
  payload with the rewritten `text` array (all other payload keys preserved).
  When nothing changes, no transform is emitted and the response passes through
  byte-identical.

  ## Examples

  ### Redacted (typed tool, SSN in a conversation-part body)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "intercom-get_conversation", "type": "tool" },
      "payload": {
        "name": "intercom-get_conversation",
        "text": ["{\"type\":\"conversation\",\"conversation_parts\":[{\"body\":\"<p>my ssn is 123-45-6789</p>\"}]}"]
      }
    }
  }
  ```

  `allow = true`, with the SSN rewritten to `[REDACTED-SSN]` in
  `transform.transformed_payload.text`.

  ### Passed through (out-of-scope tool)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "intercom-get_article", "type": "tool" },
      "payload": {
        "name": "intercom-get_article",
        "text": ["Contact support at help@acme.com"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — Help Center article bodies are public
  content and out of scope.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny/transform policies on the same egress pipeline. Recommended
  companions for `apps/intercom`:

  - **`mask-pan-egress` (PF-01)** — cardholder PAN masking (Luhn-validated, mask
    to BIN+last4) is intentionally **left to that companion policy** and is not
    handled here, so this policy stays focused on identifier and credential
    shapes. Attach both for cardholder-data environments — customers paste card
    numbers into support chats too.
  - A **`cap-bulk-export`-style ingress guard** (PF-08) clamping `limit` /
    `per_page` on `search_contacts` / `list_*` calls, bounding the blast radius
    of any redaction miss and the contact-base enumeration surface.
  - A **`role-gate`-style ingress policy** (PF-12) that keeps non-support groups
    off the contact PII surface (`get_contact` / `search_contacts` / `fetch` of
    `contact_` IDs) in the first place.

  ## Known limitations

  - **Only the MCP read path is covered.** DTwo governs the gateway only: the
    Intercom inbox/web UI, the REST API, and Fin's own actions are out of reach
    by design, and PII read through those paths will not be masked or appear in
    the DTwo audit pipeline.
  - **Redaction is uniform, not group-scoped.** The dominant community servers
    use a workspace-wide access token and expose no per-user identity, so there
    is no reliable IdP claim to exempt a cleared reviewer. Every caller gets the
    masked view. If you run the official OAuth server and need an exemption, add
    a `subject.claims.groups` guard as described under "Uniform redaction".
    Never rely on stripped ContextForge-internal claims (`is_admin`, `teams`,
    `user`) for such an exemption.
  - **Contacts reached through the *generic* `search`/`fetch` are not covered
    here.** By design the generic-alias gating fires only for **conversation**
    scope (`object_type == "conversations"` / a `conversation_` ID / a
    conversation marker in the response). A `search` with
    `object_type: "contacts"` or a `fetch` of a `contact_` ID whose response
    carries no conversation marker passes through unredacted. The **typed**
    `get_contact` / `search_contacts` tools *are* always in scope; layer the
    companion ingress role-gate to fence the generic contact path.
  - **On egress the generic `search`/`fetch` request-arg gating depends on the
    gateway mirroring request args.** When args are absent, that branch does not
    fire — the response-content fallback still catches conversation-shaped
    payloads, but a conversation `search`/`fetch` whose response omits the
    `conversation_parts` / `"type": "conversation"` markers passes through
    unredacted (fail-open for observability). The always-in-scope typed tools
    (`get_conversation` etc.) are unaffected. Verify with the dump-input
    technique.
  - **Pattern-based detection is best-effort and conservative by design.** SSNs
    are matched only in the canonical hyphenated form (bare 9-digit runs collide
    with ticket/row IDs); phones only in separator-formatted US shapes (bare
    10-digit runs, `(206)555-0100` with no space after the parenthesis, and
    non-US formats are not matched); emails only when word-boundary anchored;
    national IDs only when a recognised label precedes the value. Obfuscated,
    split-across-parts, spelled-out, full-width/unicode-digit, or unlabeled
    non-US identifiers are not caught. Characters glued directly to a value
    defeat the `\b` anchors (`123-45-67890`, `id00123-45-6789` pass through).
    Treat this as a high-signal minimum-necessary layer, not a complete DLP
    solution.
  - **Company reads are out of scope.** The `get_company` / `list_companies`
    tools are not matched — the policy targets the conversation and contact
    surfaces, where raw customer free-text and direct identifiers live. A
    company record's custom fields can incidentally carry an identifier (e.g. a
    billing-contact email); those pass through here. Layer the companion
    role-gate/attribute-strip policies if company custom fields are sensitive in
    your workspace.
  - **Cardholder PAN is out of scope.** PAN detection/masking is deliberately
    delegated to the companion `mask-pan-egress` (PF-01) policy; this policy
    does not attempt Luhn validation or card masking, and a card number in a
    thread passes through untouched here.
  - **Opaque bearer tokens (non-JWT) are not caught.** The credential set masks
    JWTs by their `eyJ…`-header three-segment shape (so `Authorization: Bearer
    eyJ…`, a bare `Bearer eyJ…`, and a raw JWT are all redacted), and masks
    `key: value` secrets and the enumerated provider prefixes. But a bearer
    scheme carrying an *opaque* random token (`Bearer a1b2c3…`, not a JWT and not
    a recognised provider prefix) has no high-signal shape to anchor on and
    passes through — matching it would require a low-signal `Bearer\s+\S+`
    catch-all that over-redacts ordinary prose. Treat this as part of the
    best-effort credential posture; layer an ingress `block-secrets`-style guard
    if opaque tokens are routinely pasted into your support chats.
  - **The email pattern can over-match inside connection strings.** A
    `user:password@host.example.com` substring matches the email shape and is
    redacted. On egress this is over-redaction (safe), not disclosure. The
    label-anchored national-ID pattern can likewise over-fire on a labelled word
    that follows the label keyword — again safe over-redaction.
  - **Non-string content blocks pass through unmodified.** Redaction applies to
    string entries of `input.payload.text` (including serialized-JSON strings).
    If your gateway emits structured non-string blocks for Intercom results,
    verify their shape with the dump-input technique.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms (e.g. `mask-pan-egress`) run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - intercom
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
package intercom.egress.redact_conversation_pii

# Transform-only egress policy: rewrites high-confidence PII (SSN, national/
# government ID, email, phone) and credential shapes in the responses of
# Intercom's conversation- and contact-read MCP tools to fixed redaction tokens
# before the response reaches the agent. Conversations are raw customer
# free-text (customers paste government IDs, health details, and credentials
# into support chats), so this is the primary regulated-data egress on the
# Intercom surface. Never denies — a legitimate lookup still succeeds, just with
# identifiers and secrets masked. Redaction is UNIFORM (no group exemption):
# the dominant community servers use a workspace-wide token with no per-user
# identity to gate on. Cardholder PAN masking is left to the companion
# mask-pan-egress (PF-01) policy, so this policy stays focused on identifier and
# credential shapes.
default allow := true

# -----------------------------------------------------------------------------
# Egress scope. Match the post-invoke/output path on either mode or action. If
# we keyed on input.mode alone and a gateway build left it unset, the scope
# check would silently fail and redaction would no-op (fail open). Ingress
# (tool_pre_invoke / mode "input") satisfies neither branch.
# -----------------------------------------------------------------------------

is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC),
# tool_metadata.name (legacy), and payload.name (tool-hook canonical). Collect
# all three and match if ANY carries an in-scope name — matching only a subset
# would let a gateway that populates a different surface slip data past the
# scanner. Every read is object.get with an "" default so a missing surface is
# never an error.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

# -----------------------------------------------------------------------------
# Typed conversation/contact read tools — always in scope. Suffix match keeps
# the policy portable across the gateway server-name prefix. All names are
# verified against Intercom's developer docs / Speakeasy catalog; the kebab
# `search-conversations` is the community fabian1710 server. See Known
# limitations for portability caveats.
# -----------------------------------------------------------------------------

typed_suffixes := {
    "get_conversation",
    "search_conversations",
    "search-conversations",
    "get_contact",
    "search_contacts",
    # Community raoulbia-ai/mcp-server-for-intercom (workspace-wide token, no
    # per-user identity). Its reads return the same raw conversation/ticket
    # free-text — the identical regulated-data egress — but its names end in
    # `_by_customer`/`_by_status`/`list_conversations`, so they match neither
    # the snake `search_conversations` suffix nor the generic search/fetch
    # branch. Named explicitly. Verified from that repo's README.
    "list_conversations",
    "search_conversations_by_customer",
    "search_tickets_by_customer",
    "search_tickets_by_status",
    # Community evolsb/fast-intercom-mcp caching layer. Its `search_conversations`
    # / `get_conversation` readers already match the suffixes above, but its
    # `sync_conversations` tool (a cache-sync reader that can surface thread
    # bodies) ends in neither `search_conversations` nor `get_conversation`, so
    # it is named explicitly to keep the conversation-read surface fully covered.
    "sync_conversations",
}

matches_typed if {
    some name in candidate_names
    some suffix in typed_suffixes
    endswith(name, suffix)
}

# -----------------------------------------------------------------------------
# Generic connector aliases (`search` / `fetch`) that alias the typed tools.
# Matching only the typed tools would be trivially bypassed via `search` with
# object_type "conversations" or `fetch` on a conversation_ ID, so the generic
# pair is covered too — scoped to CONVERSATIONS only (contacts via the generic
# path are a documented gap; the typed contact tools are always in scope).
# -----------------------------------------------------------------------------

is_generic_search if {
    some name in candidate_names
    endswith(name, "search")
}

is_generic_fetch if {
    some name in candidate_names
    endswith(name, "fetch")
}

# Request args, read defensively: present on ingress, and on egress only when
# the gateway mirrors them. A missing args object => "" default => branch skips.
req_args := object.get(object.get(input, "payload", {}), "args", {})

# (1) Request-arg gating — the literal request-side conversation scope.
generic_in_scope if {
    is_generic_search
    lower(object.get(req_args, "object_type", "")) == "conversations"
}

generic_in_scope if {
    is_generic_fetch
    startswith(lower(object.get(req_args, "id", "")), "conversation_")
}

# (2) Response-content fallback — works on the egress hook regardless of whether
# request args are mirrored. Fires when the returned payload carries an Intercom
# conversation marker.
generic_in_scope if {
    is_generic_search
    response_has_conversation_marker
}

generic_in_scope if {
    is_generic_fetch
    response_has_conversation_marker
}

serialized_text := concat("\n", [t |
    some t in text_blocks
    is_string(t)
])

response_has_conversation_marker if {
    contains(serialized_text, "\"conversation_parts\"")
}

response_has_conversation_marker if {
    contains(replace(lower(serialized_text), " ", ""), "\"type\":\"conversation\"")
}

# In scope when we are on the egress path AND either a typed tool matched or a
# generic alias resolved to conversation scope.
in_scope if {
    is_egress
    matches_typed
}

in_scope if {
    is_egress
    generic_in_scope
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives on
# free-text chat content. Cardholder PAN is intentionally absent (companion
# mask-pan-egress / PF-01).
# -----------------------------------------------------------------------------

# Credential shapes: key:value secrets, provider-specific token prefixes, JWTs
# (the `eyJ<hdr>.<payload>.<sig>` three-segment shape — catches `Authorization:
# Bearer eyJ…`, a bare `Bearer eyJ…`, and a raw JWT alike, since the token
# itself is matched regardless of the label in front of it), and PEM private-key
# headers. Combined into one alternation so a single pass masks any of them.
# (?i) makes the whole set case-insensitive (harmless over-match on the
# fixed-prefix shapes). Extends the slack/block-secrets pattern set.
credential_pattern := `(?i)(?:(?:password|passwd|secret|token|api[_-]?key|secret[_-]?key|access[_-]?key|client[_-]?secret|bearer)\s*[:=]\s*\S+|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_\-]{35}|sk-[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----)`

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# ticket/row IDs, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Government / national identifier, label-anchored so it stays high-confidence
# across formats (passport, UK NINO, tax id, unformatted SSN) without firing on
# random digit runs. The label and the value that follows are matched together.
national_id_pattern := `(?i)\b(?:ssn|social[ -]?security(?:[ -]?(?:no|number))?|national[ -]?id(?:entity)?(?:[ -]?(?:no|number|card))?|nino|passport(?:[ -]?(?:no|number))?|tax[ -]?id(?:entification)?(?:[ -]?(?:no|number))?|tin)\b\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9-]{4,19}`

# Email addresses, word-boundary anchored: local part, "@", domain, TLD of at
# least two letters.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (206-555-0100, (206) 555-0100,
# +1 206.555.0100). Bare 10-digit runs are deliberately not matched. The 3-3-4
# grouping is disjoint from the SSN 3-2-4 grouping, so the two never collide.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely. The emitted tokens
# contain no "@", no digit-with-separator runs, and no key:value delimiters, so
# no step can re-match a token produced by an earlier step.
# -----------------------------------------------------------------------------

redact_credentials(t) := regex.replace(t, credential_pattern, "[REDACTED-CREDENTIAL]")

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_national_id(t) := regex.replace(t, national_id_pattern, "[REDACTED-ID]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

# Order: credentials first (their key:value form would otherwise swallow an
# email value), then SSN (fixed 3-2-4), then the label-anchored national ID,
# then phones (3-3-4), then the generic email sweep.
redact_block(b) := redact_email(redact_phone(redact_national_id(redact_ssn(redact_credentials(b))))) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if {
    not is_string(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope and at least one block actually
# changed. Otherwise the rule is undefined and the aggregator skips this policy,
# returning the response byte-identical. Reading text via object.get + is_array
# means a missing/reshaped payload never errors and never emits a malformed
# payload (fail-open for observability).
# -----------------------------------------------------------------------------

response_payload := object.get(input, "payload", {})

text_blocks := object.get(response_payload, "text", [])

redacted_blocks := [out |
    some block in text_blocks
    out := redact_block(block)
]

transform := {
    "transformed_payload": object.union(response_payload, {"text": redacted_blocks}),
} if {
    in_scope
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
