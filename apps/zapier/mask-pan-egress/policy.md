---
name: "Zapier: Mask Card Numbers in Read Responses"
tags:
  - zapier
  - mask-pan-egress
  - egress
  - cardholder-data
  - dlp
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # zapier / mask-pan-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `zapier.egress.mask_pan`

  ## What it does

  Masks payment-card numbers (PANs) in Zapier MCP read responses before they
  reach the agent. Zapier is an aggregator: one connector proxies reads
  across 9,000+ apps, including finance-adjacent ones (QuickBooks, Stripe,
  NetSuite) whose records routinely carry card numbers — and the aggregator
  applies **no source-app DLP**, so an `execute_zapier_read_action` response
  or a classic-mode `*_find_*` / `*_get_*` response can deliver a full PAN
  straight into the agent's context.

  This policy Luhn-validates every 13–19-digit card-shaped sequence in the
  response text and rewrites each match to **BIN-plus-last4**: the first six
  digits (the issuer BIN) and last four are kept, and every digit in between
  becomes `*`, e.g. `4111 1111 1111 1111` → `411111******1111`. BIN+last4 is
  the maximum display format PCI DSS permits for personnel without a
  business need to see full PAN. All other response content is left intact.

  The policy never blocks a call. When at least one PAN is found, the
  response content blocks are rewritten via `transformed_payload`; when
  nothing matches, the transform rule is undefined and the response passes
  through byte-identical — non-matching reads are unaffected.

  Callers whose `input.subject.claims.groups` contains the documented
  placeholder group `pci-full-pan` receive unmasked responses. The exemption
  is fail-closed: a caller with no subject, no claims, no `groups` claim, or
  a malformed `groups` claim is never exempt and always gets masked output.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information: card numbers are reduced to BIN+last4 before the response
    leaves the gateway, so full PAN never moves into the agent's context or
    onward to any of the 9,000 apps the same Zapier connector can write to.
  - **PCI DSS 3.4.1** — supports masking of PAN when displayed: the Zapier
    agent channel shows at most BIN+last4, with full-PAN visibility limited
    to a defined role (`pci-full-pan`).
  - **PCI DSS 3.4.2** — supports preventing copy/relocation of PAN via
    remote-access technologies: an agent that only ever receives the masked
    form cannot re-post the full PAN into chat, tickets, files, or any of
    the 9,000 apps the same Zapier connector can write to.
  - **PCI DSS 12.5.2** — supports scope documentation/confirmation as a
    scope-creep backstop: the aggregator's read funnel is a classic path by
    which cardholder data silently expands PCI scope into agent context;
    masking at the gateway keeps that path out of scope by default.
  - **PCI DSS 12.10.7** — supports PAN-where-not-expected incident
    procedures: agent context fed by a general-purpose aggregator is a
    not-expected location, and the gateway's decision/transform audit events
    for this policy give the incident process a concrete trigger.
  - **CCPA/CPRA §1798.150** — supports reducing nonredacted-PI breach
    exposure: card numbers surfaced to agents through the Zapier funnel are
    masked by default.

  ## Tool name matching

  Zapier MCP runs in one of two mutually exclusive modes per server, with
  disjoint tool namespaces. This policy covers the read path of both,
  matching case-insensitively on `input.resource.name` after normalizing
  `_` to `-` so underscore (as Zapier publishes them) and hyphenated
  deliveries both match:

  - **Agentic mode (default):** the single read funnel
    `execute_zapier_read_action` (verified name), matched by suffix. Every
    enabled read action across every connected app returns through this one
    tool.
  - **Classic (manual-configuration) mode:** per-action tools named
    `<app>_<action>` where read actions use `find_` / `get_` verbs (e.g.
    `quickbooks_online_find_customer`, a verified example). Matched by the
    normalized name containing `-find-` or `-get-`.

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `zapier-mcp-execute_zapier_read_action`), and that prefix is not
  standardized — suffix/substring matching keeps the policy portable. Verify
  the exact names your gateway sends with the dump-input debug technique
  before relying on this in production.

  Two agentic-mode meta-tools, `get_configuration_url` and
  `get_zapier_skill`, incidentally match the `-get-` rule. That is harmless
  by construction: the policy is transform-only, and a Luhn-valid PAN inside
  stored skill text would be worth masking anyway.

  ## Patterns matched

  Conservative, anchored PAN shapes only — each pattern is commented in the
  Rego, and every candidate must also pass the Luhn check before it is
  masked, which keeps false positives (order IDs, phone numbers, invoice
  numbers, long identifiers) low:

  - 16-digit PANs grouped 4-4-4-4 with space or dash separators
    (Visa/Mastercard/Discover print format).
  - 15-digit American Express PANs grouped 4-6-5, constrained to the 34/37
    IIN range.
  - Unseparated 13–19-digit runs (the ISO/IEC 7812 PAN length range). Runs
    of 20+ digits never match: there is no word boundary inside a digit
    run, so a longer identifier is never partially masked.

  ## Response shape

  Egress tool output arrives as content blocks in `input.payload.text` (an
  array; entries are typically strings of plain text or serialized JSON —
  Zapier read results are usually JSON records from the source app). The
  policy scans each string block, replaces every Luhn-valid match with its
  own BIN+last4 form, and emits `transform.transformed_payload` with the
  original payload's `text` replaced by the masked blocks. Because matching
  is string-level, PANs are masked wherever they appear in the serialized
  record — field values, nested objects, free-text notes — without parsing
  each source app's specific JSON shape. Non-string blocks pass through
  unmodified.

  ## Examples

  ### Transformed (masked)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "zapier-mcp-execute_zapier_read_action", "type": "tool" },
      "payload": {
        "name": "zapier-mcp-execute_zapier_read_action",
        "text": ["{\"customer\":\"Acme\",\"card_on_file\":\"4111 1111 1111 1111\"}"]
      },
      "subject": { "sub": "auth0|casey@acme.com", "claims": { "groups": ["support"] } }
    }
  }
  ```

  `allow = true`; the agent sees
  `{"customer":"Acme","card_on_file":"411111******1111"}`.

  ### Allowed unmasked (exempt group)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "zapier-mcp-quickbooks_online_find_customer", "type": "tool" },
      "payload": {
        "name": "zapier-mcp-quickbooks_online_find_customer",
        "text": ["card on file: 4111 1111 1111 1111"]
      },
      "subject": { "sub": "auth0|pci-analyst@acme.com", "claims": { "groups": ["pci-full-pan"] } }
    }
  }
  ```

  `allow = true`, no transform — the caller is in the `pci-full-pan` group.

  ### Passthrough (no PAN)

  A Luhn-invalid digit run (an order number, a tracking ID, an epoch
  timestamp) produces no transform; the response is returned byte-identical.

  ## Composition

  One policy, one job — this masks card numbers on the read path only.
  Useful companions for the Zapier connector:

  - [`freeze-toolset`](../freeze-toolset/policy.md) (ingress) stops the
    agent from enabling new Zapier actions mid-session — without it, the
    read surface this policy covers can silently grow.
  - An ingress app-blocklist policy on the `execute_zapier_*_action` funnel
    (PF-14 style) that denies finance apps outright for non-finance groups —
    this policy masks card data in the reads you do allow.
  - A PF-02-style PII redaction egress policy for SSNs, emails, and phone
    numbers — separate concern, separate exemption group.

  ## Known limitations

  - **Write-funnel responses are not scanned.** `execute_zapier_write_action`
    (and classic `*_send_*`/`*_create_*`/`*_update_*` tools) can echo the
    written record — including card fields — back in the response, and this
    policy does not cover them. Coverage is deliberately the read path per
    the family spec; if your enabled write actions echo cardholder data,
    attach a widened copy that also matches the write funnel.
  - **Classic-mode read tools without `find`/`get` verbs are missed.** The
    `find_`/`get_` verb convention comes from the landscape research and the
    verified example `quickbooks_online_find_customer`; classic-mode names
    are per-account, and most were **not verifiable from public docs**. If
    your server exposes read actions with other verbs (`search_`, `list_`,
    `lookup_`), add those shapes to the tool-matching rules.
  - **Zapier's own cloud logs are outside the gateway's reach.** The raw,
    unmasked response transits and is logged in Zapier's cloud (per-app
    OAuth happens Zapier-side); this policy controls only what reaches the
    agent on the MCP path. The full card number also still exists in the
    source app (QuickBooks, Stripe, NetSuite) itself.
  - **Luhn-valid non-card numbers are masked too.** The Luhn check
    eliminates most order IDs and timestamps, but some non-card identifiers
    (certain IMEIs and other checksummed numbers) are Luhn-valid and will be
    masked. The masked form keeps first-six/last-four, so such false
    positives usually stay recognizable.
  - **Obfuscated PANs are missed.** Card numbers with separators other than
    space/dash (dots, unicode spaces), split across lines or content blocks,
    spelled out in words, or base64-encoded do not match. Card numbers typed
    with non-ASCII digits (e.g. Unicode fullwidth
    `４１１１ １１１１ １１１１ １１１１`) also do not match: the RE2 `\d`
    class is ASCII-only. Grouped formats other than 4-4-4-4 and Amex 4-6-5
    match only in their unseparated form.
  - **A PAN glued directly to a word character is missed.** Every pattern is
    `\b`-anchored, and the underscore counts as a word character in RE2, so
    a digit run immediately preceded or followed by a letter, digit, or
    underscore with no separator (e.g. `acct_4111111111111111` inside a
    serialized-JSON token value) has no word boundary and is not masked.
    This is the deliberate cost of the same `\b` anchoring that stops a
    20+-digit identifier from being partially masked. Quote-, punctuation-,
    or whitespace-delimited PANs (the normal JSON field-value case) are
    unaffected.
  - **Structured (non-string) content blocks and non-array `text` are not
    masked — fail-open.** The policy scans and rewrites only string entries
    of `input.payload.text`, and only when `text` is a JSON array. A PAN
    carried inside a content block delivered as a JSON *object* (an MCP
    typed block `{"type":"text","text":"…"}`), or in a `payload.text`
    delivered as a bare string, passes through unmasked. In the DTwo egress
    shape observed to date tool output arrives as an array of *string*
    blocks, and serialized JSON inside a string block **is** scanned and
    masked. Confirm with the dump-input technique before relying on this
    against servers that emit typed content objects.
  - **Agentic read meta-tools other than the two `-get-` ones are not
    scanned.** Only `execute_zapier_read_action` (by suffix) and the incidental
    `-get-` matches `get_zapier_skill` / `get_configuration_url` are covered in
    agentic mode. The other agentic read tools — `list_zapier_skills`,
    `list_enabled_zapier_actions`, and `discover_zapier_actions` — contain
    neither `-find-` nor `-get-`, so they are **not** matched. A PAN embedded in
    stored skill text is masked when fetched via `get_zapier_skill` but **not**
    when the same text is returned by `list_zapier_skills`; likewise a PAN in an
    action catalog from `discover_zapier_actions`/`list_enabled_zapier_actions`
    passes through unmasked. These are action/skill-management surfaces, not the
    finance read funnel this policy targets, so the gap is by design — add those
    suffixes to the tool-matching rules if you need skill/catalog text masked
    too (weigh the over-masking of numeric action keys first).
  - **Tool names are partially unverified.** `execute_zapier_read_action`
    and the other agentic meta-tool names are verified from Zapier's docs;
    `quickbooks_online_find_customer` is a verified classic-mode example.
    All other classic-mode names — and the exact response envelope of the
    agentic funnel — are **unverified**; confirm against a live capture
    through the gateway before relying on this in production.
  - **Group names are placeholders** — replace `pci-full-pan` with your
    IdP's group name at import time. The exemption reads
    `input.subject.claims.groups` and requires it to be an **array** of
    strings; every other shape (string, object, number, null, or missing)
    fails closed to masked output. Confirm your IdP emits a `groups` claim
    as a string array for your tenant before relying on the exemption.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - zapier
industries: []
bundles:
  - soc2
  - pci-dss
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package zapier.egress.mask_pan

# Transform-only policy — never denies, only masks Luhn-valid card numbers
# in Zapier MCP read responses to BIN+last4.
default allow := true

# -----------------------------------------------------------------------------
# Tool matching — the Zapier read path across both server modes. The gateway
# prefixes tool names with the configured MCP server name, so we match on
# suffix/substring to stay portable. The incoming name is normalized `_` -> `-`
# first so both `execute_zapier_read_action` (as Zapier publishes it) and a
# hyphenated delivery match.
# -----------------------------------------------------------------------------

normalized_name := replace(lower(input.resource.name), "_", "-")

# Agentic mode (default): the single read funnel every enabled read action
# returns through. Verified name from Zapier's MCP docs.
is_zapier_read_tool if {
    endswith(normalized_name, "execute-zapier-read-action")
}

# Classic (manual-configuration) mode: per-action tools named <app>_<action>
# where read actions use find_/get_ verbs (verified example:
# quickbooks_online_find_customer). Matched as a substring because the app
# prefix is per-account. Also incidentally matches the get_configuration_url /
# get_zapier_skill meta-tools — harmless, since the policy is transform-only.
is_zapier_read_tool if {
    contains(normalized_name, "-find-")
}

is_zapier_read_tool if {
    contains(normalized_name, "-get-")
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
# Luhn check — filters card-shaped candidates so order numbers, timestamps,
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
    is_zapier_read_tool
    not caller_may_view_full_pan
    is_array(text_blocks)
    masked_blocks != text_blocks
}
```
