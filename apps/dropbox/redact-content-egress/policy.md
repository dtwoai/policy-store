---
name: "Dropbox: Redact PII, PANs, and Secrets in File Content"
tags:
  - dropbox
  - redact-content
  - redact-pii
  - mask-pan
  - secrets
  - pii
  - dlp
  - egress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # dropbox / redact-content-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `dropbox.egress.redact_content`

  ## What it does

  Scans the responses of the Dropbox file-content read tools and sanitises the
  returned text before it reaches the agent. Dropbox is a generic bucket, so one
  `path` can return PII, PHI, a financial statement, or a credentials file — this
  policy is the primary DLP layer on the MCP read path. It never blocks the read;
  it only rewrites the body:

  | Class | Detection | Result |
  |---|---|---|
  | Payment card (PAN) | 13-19-digit runs and 4×4 / Amex 4-6-5 grouped forms, **Luhn-validated** in Rego | masked to **BIN + last-four** (`4111 1111 1111 1111` → `411111******1111`) |
  | US national ID (SSN / ITIN) | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Email address | standard shape | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted 3-3-4 | `[REDACTED-PHONE]` |
  | Secret | `AKIA…` access-key IDs, PEM `-----BEGIN … PRIVATE KEY-----` blocks, provider token prefixes (`ghp_`, `github_pat_`, `xox[baprs]-`, `sk_live_`, `AIza…`, `sk-…`) | `[REDACTED-SECRET]` |

  Matches are rewritten in place, so the surrounding document structure, citations,
  and extraction fields stay usable. The policy is transform-only: it never denies
  a call, and responses with no matches (and all non-content tools) pass through
  byte-identical.

  ### Full-PAN carve-out

  Callers whose IdP `groups` claim contains the placeholder group `pci-fullpan`
  (fraud / chargeback staff who genuinely need the complete number) receive the
  **unmasked** PAN. The carve-out is read via `object.get(input.subject, "claims",
  {})`: a missing subject, missing claims, missing `groups`, or a malformed
  `groups` claim all leave the caller **not exempt**, so PAN masking applies — the
  grant fails closed. The carve-out is **PAN-only**: even an exempt caller still
  gets SSNs, emails, phones, and secrets redacted, because there is no role that
  needs raw credentials or Social Security numbers in agent context.

  ## Compliance alignment

  - **PCI DSS 3.4.1** — supports masking of PAN on display: the agent channel
    shows at most BIN+last4, with full-PAN visibility limited to the defined
    `pci-fullpan` role. **PCI DSS 3.4.2** — supports preventing PAN copy/relocation
    via remote-access technologies: an agent that only ever receives the masked
    form cannot re-post the full PAN into another file, share, or chat. **PCI DSS
    12.10.7** — the gateway's transform/decision audit events give the
    "PAN-where-not-expected" incident process a concrete trigger, since a Dropbox
    document is a classic not-expected location for cardholder data.
  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking/redacting direct identifiers in Dropbox
    content as it leaves the gateway toward the agent. **SOC 2 C1.1 / P4.1** —
    supports identifying and protecting confidential information and limiting
    personal-information use to identified purposes on the read path.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary, role-based
    access: identifiers are stripped for everyone; only the `pci-fullpan` role sees
    raw card numbers. **HIPAA §164.514(a)–(b)** — supports de-identification
    practice by stripping Safe-Harbor identifier classes (SSN, email, phone) from
    responses. **HIPAA §164.530(c)** — administrative safeguard on the agent read
    path.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data.
    **GDPR Art. 9** — reduces special-category exposure where identifiers co-occur
    with health/financial content. **CCPA/CPRA §1798.121** — supports limiting the
    use and disclosure of sensitive personal information (SSN, financial account
    numbers) on the agent channel; **§1798.150** — reduces nonredacted-PI breach
    exposure.

  ## Why egress

  The PII, PANs, and secrets already live in Dropbox — there is nothing to block
  at ingress, and denying reads outright would make the documents unusable. The
  leak happens when file-derived text is returned to the MCP client, so the
  response path is the only place to catch it while keeping the content useful.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a gateway
  build that populates only one of the two (keying on `mode` alone would fail open
  if it were unset). Tools are matched case-insensitively **by suffix**, so it
  works regardless of the MCP server-name prefix the gateway adds
  (`dropbox-mcp-…`, `dbx-…`, etc.). The tool name is read from all three egress
  surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a suffix hit on **any** of them puts the call in
  scope, so a gateway that populates a different surface can't slip content past
  the scanner.

  Content-read tools matched (from the Dropbox landscape research):

  - **`*GetFileContent`** — official remote server (mcp.dropbox.com; PascalCase),
    extracts text from PDF/Word/text up to 5 MB. The main egress surface.
  - **`*get_file_content`**, **`*download_file`** — `amgadabdelhafez/dbx-mcp-server`
    (community, snake_case).
  - **`*dropbox_download`** — `ngs/dropbox-mcp-server` (community, `dropbox_` prefix).

  Metadata / search tools (`GetFileMetadata`, `ListFolder`, `Search`) are
  deliberately out of scope — this policy sanitises returned **file content**, not
  filenames or listings. The externally-visible URL minter `DownloadLink` (official)
  returns a *URL*, not content, so it is intentionally **not** matched (it never
  ends in a content suffix) — pair it with `apps/dropbox/guard-share-links-external`
  on ingress.

  Tool names are verified against Dropbox's help docs and the community READMEs,
  but the official server's **argument/response JSON schemas are unverified** (the
  landscape note flags that Dropbox does not publish them, and the help page lists
  "21 tools" while enumerating 23). Verify the exact tool names and the response
  content-block shape your gateway emits with the dump-input debug technique before
  relying on this in production, and add suffixes for any other content-returning
  tools your deployment exposes.

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each string block. Non-string
  blocks pass through unmodified. When at least one block changes, the policy emits
  `transform.transformed_payload` containing the original payload with the
  rewritten `text` array (all other payload keys preserved).

  ## Examples

  ### Transformed (content tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "dropbox-mcp-GetFileContent", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["support"] } },
      "payload": {
        "name": "dropbox-mcp-GetFileContent",
        "text": ["SSN 123-45-6789, card 4111 1111 1111 1111, key AKIA1234567890ABCDEF"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["SSN [REDACTED-SSN], card 411111******1111, key [REDACTED-SECRET]"]`.

  ### Transformed (exempt caller — PAN kept, SSN still redacted)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "dropbox-mcp-GetFileContent", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["pci-fullpan"] } },
      "payload": {
        "name": "dropbox-mcp-GetFileContent",
        "text": ["SSN 123-45-6789, card 4111 1111 1111 1111"]
      }
    }
  }
  ```

  `allow = true`, `transform.transformed_payload.text` =
  `["SSN [REDACTED-SSN], card 4111 1111 1111 1111"]` — the `pci-fullpan` group
  keeps the raw card number but the SSN is still redacted.

  ### Passed through (no sensitive data / out-of-scope tool)

  A content block with no PII/PAN/secret produces no transform. A metadata or
  listing tool (`GetFileMetadata`, `ListFolder`) is out of scope and passes through
  byte-identical even when its output contains a match.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny policies on the same egress pipeline. Recommended companions in
  `apps/dropbox`:

  - **fence-sensitive-paths** (ingress) — keeps agents out of protected folder
    trees entirely, covering formats this policy cannot text-scan.
  - **guard-share-links-external** (ingress) — so redacted-on-read content isn't
    simply shared out through `CreateSharedLink` / `DownloadLink` /
    `CreateFileRequest` instead.

  ## Known limitations

  - **Conservative regex over extracted text — high-signal, not complete DLP.**
    Detection runs only over the text the server extracts. Custom-format
    identifiers, values inside binary or office formats the server does not
    text-extract, obfuscated/spelled-out/base64-encoded values, and anything split
    across content blocks are **not** caught. Treat this as a high-signal layer,
    not a guarantee. The PAN, SSN, email, and phone patterns are `\b`-anchored, so a
    sensitive value glued **directly** to an adjacent word character with no
    separating space/punctuation (e.g. an email whose TLD abuts a card number,
    `jane@acme.com4111111111111111`) can defeat the word boundary and pass through
    — a contrived shape, but a real edge of boundary-anchored matching.
  - **National-ID coverage is US-shaped only.** The SSN pattern matches the
    hyphenated US SSN/ITIN form (`XXX-XX-XXXX`). Bare 9-digit runs are left alone
    (they collide with Dropbox file IDs and countless document numbers), and
    non-US national-ID formats (which are country-specific) are not matched — add
    their shapes to the Rego if your corpus contains them.
  - **Email and phone are redacted stand-alone.** Every email address and every
    separator-formatted US phone number in a matched response is redacted, so
    document footers and "contact us" lines lose their contact details. If that is
    too aggressive for your corpus, pair-gate them (see `apps/box/redact-pii-egress`
    for the co-occurrence heuristic) or narrow the patterns.
  - **Luhn-valid non-card numbers are masked too.** The Luhn check eliminates most
    IDs and timestamps, but some checksummed non-card numbers (certain IMEIs, etc.)
    are Luhn-valid and will be masked; the masked form keeps BIN+last4, so such
    false positives usually stay recognisable. A card split across content blocks
    (no single block with 13+ contiguous card digits) is not masked.
  - **Secret detection is prefix/shape-based.** Only `AKIA…`, PEM private-key
    **blocks** (BEGIN…END in one content block; a header without its END marker, or
    a key split across blocks, is missed), and the listed provider token prefixes
    are caught. Generic `key: value` credential pairs, custom-format or short-lived
    tokens, and any provider not in the list are not matched — extend
    `secret_patterns` for your environment. `sk-[A-Za-z0-9]{20,}` (OpenAI) is a
    broad shape and can over-match unrelated `sk-`-prefixed strings.
  - **Structured (non-string) content blocks and non-array `text` are not scanned
    — fail-open.** The policy rewrites only string entries of `input.payload.text`,
    and only when `text` is a JSON array. A value carried inside a content block
    delivered as a JSON *object* (a typed `{"type":"text","text":"…"}` block), or a
    `payload.text` delivered as a bare string, passes through unredacted. Serialized
    JSON *inside* a string block **is** scanned. Confirm your gateway/server
    delivers string blocks with the dump-input technique.
  - **Group names are placeholders — replace `pci-fullpan` with your IdP's group
    name at import time.** The carve-out honours a `groups` claim shaped as an
    array of strings (a single bare string is also handled). Any other shape — a
    missing subject/claims/`groups`, an object/map (e.g. `{"role": "pci-fullpan"}`),
    a number, null, or nested/non-string array elements — fails closed → PAN masked.
    If your IdP emits roles under a namespaced claim, point `caller_groups` at the
    array before matching.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input technique
    before production, and mind attachment order if other egress transforms run on
    the same pipeline.
  - **MCP path only.** The raw content still exists in Dropbox and in Dropbox's
    own web/desktop/API surfaces; this policy controls only what the *agent* sees
    over MCP.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - dropbox
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package dropbox.egress.redact_content

# Transform-only egress policy: masks Luhn-valid PANs to BIN+last4 and redacts
# US SSNs/ITINs, emails, phones, and secret-shaped strings in the responses of
# Dropbox file-content read tools before they reach the agent. Never denies.
# The PAN mask is skipped for callers in the placeholder `pci-fullpan` group;
# SSN/email/phone/secret redaction always applies.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Dropbox tools whose responses carry file-derived content. Suffix
# matching keeps the policy portable across gateway server-name prefixes and
# covers the official remote server (PascalCase) plus the two community servers.
# Metadata/listing/search tools and the URL-minting DownloadLink are NOT matched.
# -----------------------------------------------------------------------------

content_tool_suffixes := {
    # Official remote server (mcp.dropbox.com) — extracts text from PDF/Word/text.
    "getfilecontent",
    # amgadabdelhafez/dbx-mcp-server (community, snake_case).
    "get_file_content",
    "download_file",
    # ngs/dropbox-mcp-server (community, dropbox_ prefix).
    "dropbox_download",
}

# Egress scope: match the post-invoke/output path on either mode or action. If we
# keyed on input.mode alone and a gateway build left it unset, is_content_tool
# would silently fail and redaction would no-op (fail open, leaking content).
# Ingress (tool_pre_invoke / mode "input") satisfies neither branch.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a content-tool suffix — matching only a subset would let a gateway
# that populates a different surface slip file content past the scanner.
candidate_names contains lower(object.get(input.resource, "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

is_content_tool if {
    is_egress
    some suffix in content_tool_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Full-PAN carve-out — placeholder IdP group whose members receive the unmasked
# PAN. Read via object.get(input.subject, "claims", {}); a missing
# subject/claims/groups or a malformed groups claim leaves this rule undefined,
# so PAN masking applies (fail closed). Replace "pci-fullpan" at import time.
# The is_array guard is load-bearing: `some g in caller_groups` over an OBJECT
# iterates its values, so an object-shaped claim like {"role":"pci-fullpan"}
# would else wrongly exempt the caller.
# -----------------------------------------------------------------------------

exempt_group := "pci-fullpan"

caller_groups := object.get(object.get(input.subject, "claims", {}), "groups", [])

caller_may_view_full_pan if {
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    lower(g) == exempt_group
}

caller_may_view_full_pan if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) == exempt_group
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives.
# -----------------------------------------------------------------------------

# US SSN / ITIN in the canonical hyphenated form only. Bare 9-digit runs are too
# collision-prone with Dropbox file IDs and document numbers to redact safely.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Email address, standard shape.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone number (3-3-4), optional +1 and area-code parens.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b`

# Secret-shaped strings: AWS access-key IDs, PEM private-key blocks, and common
# provider token prefixes. Case-sensitive (the prefixes are case-specific). The
# PEM alternative matches the whole BEGIN…END block, including newlines.
secret_pattern := concat("|", [
    # AWS access key ID.
    `AKIA[0-9A-Z]{16}`,
    # PEM private key block (RSA/EC/DSA/OPENSSH/plain), header through footer.
    `-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----`,
    # GitHub classic and fine-grained personal access tokens.
    `ghp_[A-Za-z0-9]{36}`,
    `github_pat_[A-Za-z0-9_]{82}`,
    # Slack bot/user/app/refresh tokens.
    `xox[baprs]-[A-Za-z0-9-]{10,}`,
    # Stripe live secret keys.
    `sk_live_[A-Za-z0-9]{24,}`,
    # Google API keys.
    `AIza[0-9A-Za-z\-_]{35}`,
    # OpenAI-style secret keys (broad shape — see Known limitations).
    `sk-[A-Za-z0-9]{20,}`,
])

# -----------------------------------------------------------------------------
# PAN candidate shapes + Luhn check — anchored with \b so digit runs inside
# longer identifiers are never partially matched. Every candidate must pass the
# Luhn check before it is masked.
# -----------------------------------------------------------------------------

pan_pattern := concat("|", [
    # 16-digit PANs grouped 4-4-4-4 with a space, dash, or dot separator.
    `\b\d{4}[-. ]\d{4}[-. ]\d{4}[-. ]\d{4}\b`,
    # 15-digit American Express PANs grouped 4-6-5, constrained to the 34/37 IIN.
    `\b3[47]\d{2}[-. ]\d{6}[-. ]\d{5}\b`,
    # Unseparated 13-19 digit runs — the ISO/IEC 7812 PAN length range. Runs of
    # 20+ digits never match: there is no word boundary inside a digit run.
    `\b\d{13,19}\b`,
])

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

# Mask a single PAN to BIN+last4: first six digits and last four kept, every
# digit between masked with `*`. Separators are dropped in the masked form.
mask_pan(c) := masked if {
    d := digits_only(c)
    n := count(d)
    masked := concat("", [
        substring(d, 0, 6),
        # RE2 has no repeat builtin, so mask the middle substring char-by-char.
        regex.replace(substring(d, 6, n - 10), `\d`, "*"),
        substring(d, n - 4, 4),
    ])
}

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_secrets(t) := regex.replace(t, secret_pattern, "[REDACTED-SECRET]")

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

# Mask PANs unless the caller is in the full-PAN group.
mask_pans(t) := out if {
    replacements := {c: mask_pan(c) | some c in pan_candidates(t)}
    count(replacements) > 0
    out := strings.replace_n(replacements, t)
}

mask_pans(t) := t if { count(pan_candidates(t)) == 0 }

mask_pans_maybe(t) := mask_pans(t) if { not caller_may_view_full_pan }

mask_pans_maybe(t) := t if { caller_may_view_full_pan }

# Order: secrets first (so a token can't be nibbled by later patterns), then
# SSN, email, phone (fixed-token redactions), then Luhn-checked PAN masking.
redact_block(b) := out if {
    is_string(b)
    out := mask_pans_maybe(redact_phone(redact_email(redact_ssn(redact_secrets(b)))))
}

# Non-string content blocks (structured/JSON blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, `text` is an array, and at least one
# block actually changed. Otherwise the rule is undefined and the aggregator
# skips this policy, returning the response byte-identical. Note the carve-out
# does NOT gate the transform: an exempt caller still gets SSN/secret redaction.
# -----------------------------------------------------------------------------

text_blocks := object.get(input.payload, "text", [])

redacted_blocks := [out |
    some block in text_blocks
    out := redact_block(block)
]

transform := {
    "transformed_payload": object.union(input.payload, {"text": redacted_blocks}),
} if {
    is_content_tool
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
