---
name: "Glean: Redact PII from Read-Tool Responses"
tags:
  - glean
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
  # glean / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `glean.egress.redact_pii`

  ## What it does

  Scans the responses of Glean's content-returning read tools and rewrites
  high-confidence PII to fixed redaction tokens before the response reaches the
  agent's context:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | PAN (payment card) | Luhn-shaped card numbers — 4-4-4-4 grouped, 15-digit Amex 4-6-5, or an unseparated 13–19-digit run | `[REDACTED-PAN]` |
  | Bank account / IBAN | IBAN-shaped strings (2-letter country + 2 check digits + 11–30 alphanumerics) | `[REDACTED-BANK]` |

  Each class is matched independently — a lone SSN, a lone card number, or a
  lone IBAN is redacted on its own. Matches are replaced in place, so the
  surrounding text (search snippets, chat synthesis, document body, mail bodies,
  transcript lines) stays usable and the agent keeps working context over the
  non-sensitive parts. The policy is **transform-only**: it never denies a call,
  and responses with no matches — and all out-of-scope tools — pass through
  byte-identical. Every response field is read via `object.get`, so missing or
  oddly-shaped payloads are never an error; they simply pass through.

  ## Why egress, and why the response is the choke point

  Glean is an aggregation layer: a single Glean call fans out across Drive,
  Confluence, Slack, mail, Gong, HR systems, and everything else the tenant has
  indexed. The **response** is the one place where every source's content
  converges, which makes egress the correct choke point for what the agent can
  actually exfiltrate — distinct from what the *user* is permitted to see.
  Glean enforces source-system permissions on the read, but "what the user may
  see" ≫ "what the agent should stream into model context." The PII already
  lives in the indexed systems, so there is nothing to block at ingress, and
  denying `search`/`chat`/`read_document` outright would make the agent useless
  for everyday work. Catching identifiers on the response path keeps the content
  useful while stripping the direct identifiers out of it.

  This policy is **defense-in-depth** alongside — not a replacement for —
  ingress fences on Glean (datasource fencing, bulk-export caps, transcript
  gating): those decide *which* sources and how much a caller may read; this one
  strips direct identifiers out of whatever content they are allowed to read.

  ## Compliance alignment

  Instantiates egress PII redaction (family PF-02) for Glean and supports
  alignment with:

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in Glean content as
    it leaves the gateway toward the agent; **C1.1** — supports identification
    and protection of confidential information on the read path; **P4.1** —
    supports limiting personal-information use to identified purposes; **P6.1** —
    supports controls over personal-information disclosure by keeping raw
    identifiers out of agent context that does not need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits by masking direct identifiers that co-occur with clinical
    or benefits content surfaced through Glean's cross-source search;
    **§164.514(a)–(b)** — supports de-identification practice by stripping
    Safe-Harbor identifier classes (SSN, account numbers) from responses;
    **§164.530(c)** — supports privacy safeguards on the agent channel.
  - **PCI DSS 3.4.1** — supports masking PAN on display: Luhn-shaped payment-card
    numbers surfaced in Glean read-tool responses are rewritten to
    `[REDACTED-PAN]` before they reach the agent context, so a full PAN is not
    streamed into the model; **3.3.1** — supports keeping sensitive account data
    out of what the agent can move off the card-data path (best-effort,
    shape-matched — see Known limitations).
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR content in indexed sources;
    **Art. 5(1)(f) / Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, financial-account numbers) on the agent
    channel; **§1798.150** — reduces nonredacted-PI breach exposure.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a
  gateway build that populates only one of the two (keying on `mode` alone would
  fail open if it were unset). The tool name is read from all three egress
  surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a suffix hit on **any** of them puts the call in
  scope, so a gateway that populates a different surface can't slip content past
  the scanner. Matching is case-insensitive.

  The remote managed Glean server exposes **bare, generic** tool names
  (`search`, `chat`, `read_document`, `gmail_search`, `outlook_search`,
  `meeting_lookup`); the gateway prefixes each with the configured MCP server
  name (observed as `glean-…`). Because `search` and `chat` are too generic to
  match blindly, the two name classes are handled differently:

  - **Distinctive names** — `read_document`, `gmail_search`, `outlook_search`,
    `meeting_lookup` — match bare, or after **any** server-prefix separator
    (`-`, `_`, `.`, `:`, `/`). None is a suffix of another Glean tool, so this
    is safe.
  - **Generic names** — `search`, `chat` — match only **bare** or after a
    **hyphen-class** separator (`-`, `.`, `:`, `/`), deliberately **excluding
    underscore**. This is what keeps the bare `search` entry from swallowing the
    underscore-joined compound tools Glean also ships but that are **out of
    scope here** — `employee_search` and `code_search` — and from double-firing
    on `gmail_search` / `outlook_search` (which have their own entries). So
    `glean-search` and `glean.chat` match; `glean-employee_search`,
    `glean-code_search`, and `glean-gmail_search` do **not** match the generic
    `search` entry (the last is matched by its distinctive entry instead).

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production. **These names are verified for the
  remote managed server** (Glean landscape note, tool inventory). The deprecated
  local server used different names (`company_search`, `people_profile_search`);
  add those suffixes only if a tenant still runs the archived package.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each block. It handles
  the two content-block shapes a gateway realistically emits:

  - **Plain-string blocks** (`"text": ["…result…"]`) are redacted directly,
    including string blocks that carry serialized JSON, since the regexes run
    over the serialized text.
  - **MCP-standard structured text blocks** (`{"type":"text","text":"…"}`) have
    their inner `text` string redacted while every other key (`type`,
    `annotations`, …) is preserved. Without this branch, body delivered as
    content-block *objects* — the canonical MCP wire shape — would slip past a
    string-only redactor untouched.

  Any other block (an object with no string `text` field, or a non-string /
  non-object value such as a nested array) passes through unmodified — the
  policy makes no claim over arbitrary structured data whose PII sits under
  other keys. When at least one block changes, the policy emits
  `transform.transformed_payload` containing the original payload with the
  rewritten `text` array (all other payload keys, including `name`, preserved).
  When nothing changes, no transform is emitted and the response passes through
  byte-identical. The `text` field must be an **array**: a gateway that returns
  a bare scalar string under `payload.text` (off the documented shape) is not
  rewritten — see Known limitations.

  ## Examples

  ### Redacted (in-scope `search` response)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "glean-search", "type": "tool" },
      "payload": {
        "name": "glean-search",
        "text": ["Vendor record: SSN 123-45-6789, card 4111 1111 1111 1111, IBAN GB82WEST12345698765432"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["Vendor record: SSN [REDACTED-SSN], card [REDACTED-PAN], IBAN [REDACTED-BANK]"]`.

  ### Passed through (out-of-scope tool)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "glean-employee_search", "type": "tool" },
      "payload": {
        "name": "glean-employee_search",
        "text": ["SSN 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — `employee_search` is not in the matched set
  (see Tool name matching), so nothing is rewritten.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny/transform policies on the same egress pipeline. Recommended
  companions in `apps/glean`:

  - An **ingress datasource fence / bulk-export cap** on `*search` so the agent
    only reaches sources it is entitled to and cannot bulk-export. This egress
    redactor is defense-in-depth behind that fence, not a substitute for it.
  - **Default-deny-unknown-tools (PF-28)** on the Glean server — Glean's tool
    inventory is admin-mutable (agents-as-tools, gateway-proxied writes), so an
    allowlist keeps unreviewed tools from appearing.
  - A **transcript-gating** ingress policy on `*meeting_lookup`
    (`extract_transcript` / `peer`).

  ## Known limitations

  - **Pattern-based detection is best-effort — and this is regex over returned
    text.** Obfuscated, spelled-out, split-across-blocks, base64-encoded, or
    image-embedded identifiers are not caught. **Non-ASCII digit forms also
    escape** — RE2's `\d` matches ASCII `0`–`9` only, so a full-width rendering
    of an SSN/PAN (e.g. `１２３-４５-６７８９`) is not redacted even though a model
    reads it as digits. **Word-adjacent identifiers escape** too: the SSN and
    PAN-run patterns are `\b`-anchored (deliberately, so they never fire inside
    longer alphanumeric IDs), so an identifier abutting a word character — a
    letter, digit, or underscore — on either side is not matched. An SSN wrapped
    in Markdown italics underscores (`_123-45-6789_`) or a run-on like
    `id123-45-6789` streams through unredacted. **Tune the pattern set per
    tenant.** Treat this as a high-signal minimum-necessary layer, not a
    complete DLP solution.
  - **PAN is shape-matched, not Luhn-validated.** The card-number patterns match
    the digit lengths and groupings a Luhn-valid PAN uses (13–19-digit ISO/IEC
    7812 range, 4-4-4-4 grouping, 15-digit Amex 4-6-5), but pure regex **cannot
    compute the Luhn checksum** — matches are card-number *shapes*, not verified
    PANs. A conforming-shape non-card number (e.g. a 16-digit order ID or a
    13–19-digit bank account number) is redacted as `[REDACTED-PAN]`, and a card
    number typed in an unusual grouping may be missed. This favors
    over-redaction (safe) over disclosure.
  - **Bank/IBAN detection is IBAN-shaped and contiguous.** It matches the
    canonical compact IBAN shape (country letters + 2 check digits + 11–30
    alphanumerics, all contiguous). **IBANs printed with spaces every four
    characters** (`GB82 WEST 1234 5698 7654 32`) are **not** matched (the groups
    break contiguity), and lowercase IBANs are not matched (country codes are
    conventionally uppercase). Bare domestic account/routing numbers with no
    IBAN structure are only caught if they happen to fall in the 13–19-digit PAN
    run (then tagged `[REDACTED-PAN]`); shorter US routing/account numbers are
    not matched, and a **contiguous run of 20 or more digits** is likewise
    outside the 13–19-digit PAN window (its only word boundaries are the two
    ends, and 20+ exceeds the ceiling) so it passes through unredacted too. Add
    tenant-specific account-number shapes if your result sets carry them.
  - **Block coverage and the `text`-array assumption.** Redaction applies to
    plain-string entries of `input.payload.text` (including serialized-JSON
    strings) **and** to MCP-standard structured text blocks
    (`{"type":"text","text":"…"}`; inner `text` redacted, other keys preserved).
    Blocks that are objects with **no string `text` field** (a custom
    `{"field":"ssn","value":"…"}` shape, a standard embedded-resource block
    carrying its body under nested `resource.text`, or an off-spec block whose
    `text` value is itself a **non-string** — e.g. `{"type":"text","text":["…"]}`
    with an array-valued `text` — which `block_text` rejects via its
    `is_string` guard), and blocks that are
    themselves **nested arrays** of sub-blocks, pass through unmodified and
    stream any embedded identifiers verbatim. If your gateway build emits bodies
    as embedded-resource or nested-array blocks under `payload.text` (the
    documented contract is a flat array of strings — confirm yours with the
    dump-input technique), extend `block_text` / `redact_block` to descend into
    `resource.text` and nested arrays, or fence those tools at ingress.
    Separately, the `text` field is assumed to be an **array**: a gateway that
    returns a bare scalar string under `payload.text` fails the `is_array`
    transform guard and the response is **not rewritten** (a fail-open residual
    on an off-spec shape).
  - **Tool-name coverage is the verified remote-server surface only.** Only the
    six read tools named above are in scope. Glean's other content-returning
    read tools that this policy deliberately does **not** match —
    `employee_search`, `code_search`, `user_activity`, `knowledge_graph_query`,
    and the memory read tool (`memory` / `read_memory` with `action:"read"`,
    whose `ExplicitMemories` category can hold user-entered identifiers) —
    stream their content unredacted; add their suffixes if your deployment
    treats them as PII-bearing. (Memory *writes* are governed separately by the
    deny-memory-writes ingress companion, but that policy does not redact what a
    memory *read* returns — this redactor does not cover it either.) The
    schema/graph introspection tools (`memory_schema`, `knowledge_graph_schema`)
    return structure, not record content, and are intentionally excluded.
    **Gateway-proxied third-party tools and
    agents-as-tools have arbitrary org-specific names** (naming pattern
    undocumented per the Glean landscape note) and are not matched here — govern
    them with the default-deny-unknown-tools companion. Generic `search` / `chat`
    matching anchors on a hyphen-class server prefix; a deployment that joins the
    server name with an **underscore** (`glean_search`) would **not** match the
    generic entries and would fail open — pin the exact prefix per tenant after
    confirming it with the dump-input technique.
  - **No identity-based exemptions.** Every caller's Glean responses are
    redacted uniformly; this policy has no full-PII group carve-out. If you need
    one (e.g. a fraud-investigations group that must see raw PANs), add a
    separate group-gated `allow`/exemption branch keyed on `input.subject.claims`
    — do not rely on the stripped ContextForge-internal `is_admin`/`teams`/`user`
    claims for it.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - glean
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
package glean.egress.redact_pii

# Transform-only egress policy: rewrites high-confidence PII (US SSN,
# Luhn-shaped PAN, IBAN/bank-account-shaped strings) in Glean read-tool
# responses to fixed redaction tokens before the response reaches the agent.
# Never denies. Glean is an aggregation layer, so the response is the single
# point where every indexed source's content converges — the correct egress
# choke point for what the agent can exfiltrate.
default allow := true

# -----------------------------------------------------------------------------
# Egress scope: match the post-invoke/output path on either mode or action. If
# we keyed on input.mode alone and a gateway build left it unset, is_egress
# would fail and redaction would no-op (fail open, leaking content). Ingress
# (tool_pre_invoke / mode "input") satisfies neither branch, so it stays out of
# scope.
# -----------------------------------------------------------------------------
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a read-tool suffix — matching only a subset would let a gateway that
# populates a different surface slip content past the scanner.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

# -----------------------------------------------------------------------------
# Scope: the verified remote-managed Glean read tools whose responses carry
# cross-source body / snippet / synthesis content. The gateway prefixes bare
# tool names with the configured server name (observed as `glean-`), so we match
# by suffix. Two classes, matched differently:
#
#   * Distinctive names — none is a suffix of another Glean tool, so they match
#     after ANY separator (incl. underscore) or bare.
#   * Generic names (`search`, `chat`) — matched only bare or after a
#     hyphen-class separator (NOT underscore), so the bare `search` entry never
#     swallows the underscore-joined compound tools that are out of scope here
#     (`employee_search`, `code_search`) or double-fires on `gmail_search` /
#     `outlook_search` (matched by their own distinctive entries).
# -----------------------------------------------------------------------------

distinctive_suffixes := {"read_document", "gmail_search", "outlook_search", "meeting_lookup"}

generic_names := {"search", "chat"}

# Separators a gateway may insert between the server prefix and the tool name.
word_seps := {"-", "_", ".", ":", "/"}

# Hyphen-class separators only — underscore excluded (see comment above).
hyphen_seps := {"-", ".", ":", "/"}

# name equals the bare tool name, or ends with <sep><name> for some sep in seps.
matches_suffix(n, suf, _) if { n == suf }

matches_suffix(n, suf, seps) if {
	some s in seps
	endswith(n, concat("", [s, suf]))
}

is_glean_read_tool if {
	is_egress
	some n in candidate_names
	some suf in distinctive_suffixes
	matches_suffix(n, suf, word_seps)
}

is_glean_read_tool if {
	is_egress
	some n in candidate_names
	some g in generic_names
	matches_suffix(n, g, hyphen_seps)
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives.
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# ordinary identifiers, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# PAN (payment-card) shapes. Pure regex cannot Luhn-validate; these match the
# lengths/groupings a Luhn-valid card uses (see Known limitations).
# 16-digit PANs grouped 4-4-4-4 with space or dash separators.
pan_grouped_pattern := `\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b`

# 15-digit American Express PANs grouped 4-6-5, constrained to the 34/37 IIN.
pan_amex_pattern := `\b3[47]\d{2}[ -]\d{6}[ -]\d{5}\b`

# Unseparated 13–19 digit runs — the ISO/IEC 7812 PAN length range. There is no
# word boundary inside a longer digit run, so this cannot partially mask a
# longer identifier, and (no leading \b before a letter) it never fires inside
# an IBAN's trailing digits.
pan_run_pattern := `\b\d{13,19}\b`

# IBAN-shaped strings: 2-letter country code + 2 check digits + 11–30 further
# alphanumerics, contiguous (no spaces). Country codes are uppercase.
iban_pattern := `\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely. Order: SSN (3-2-4
# hyphen groups), then PAN shapes, then IBAN. The classes are disjoint on the
# shapes above, so order does not change the result.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_pan(t) := out if {
	g := regex.replace(t, pan_grouped_pattern, "[REDACTED-PAN]")
	a := regex.replace(g, pan_amex_pattern, "[REDACTED-PAN]")
	out := regex.replace(a, pan_run_pattern, "[REDACTED-PAN]")
}

redact_bank(t) := regex.replace(t, iban_pattern, "[REDACTED-BANK]")

redact_text(t) := redact_bank(redact_pan(redact_ssn(t)))

# Helper: the inner `text` string of an MCP structured content block
# ({"type":"text","text":"..."}); undefined for anything else.
block_text(b) := t if {
	is_object(b)
	t := object.get(b, "text", null)
	is_string(t)
}

# Plain-string content blocks: redact in place.
redact_block(b) := redact_text(b) if {
	is_string(b)
}

# MCP-standard structured text content blocks {"type":"text","text":"..."}:
# redact the inner `text` string and preserve every other key. Without this
# branch, body delivered as content-block OBJECTS (the canonical MCP wire shape)
# would slip past a string-only redactor untouched.
redact_block(b) := object.union(b, {"text": redact_text(bt)}) if {
	not is_string(b)
	bt := block_text(b)
}

# Any other block — an object with no string `text` field, or a non-string /
# non-object value (e.g. a nested array) — passes through unmodified. The policy
# makes no claim over arbitrary structured data whose PII lives under other keys.
redact_block(b) := b if {
	not is_string(b)
	not block_text(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, `text` is an array, and at least one
# block actually changed. Otherwise the rule is undefined and the aggregator
# skips this policy, returning the response byte-identical.
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
	is_glean_read_tool
	is_array(text_blocks)
	redacted_blocks != text_blocks
}
```
