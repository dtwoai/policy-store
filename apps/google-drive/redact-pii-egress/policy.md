---
name: "Google Drive: Redact PII from File Content"
tags:
  - google-drive
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
  # google-drive / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `google_drive.egress.redact_pii`

  ## What it does

  Scans the responses of the content-returning Google Drive tools — file
  reads, downloads, and Docs/Sheets/Slides content fetches — and rewrites
  personally identifiable information to fixed redaction tokens before the
  response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | Email address | conservative `mailbox@domain.tld` shape | `[REDACTED-EMAIL]` |
  | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | National ID | UK National Insurance number (`AB123456C` shape) | `[REDACTED-NATIONAL-ID]` |
  | US phone number | separator-formatted (e.g. `206-555-0100`, `(206) 555-0100`, `(206)555-0100`) | `[REDACTED-PHONE]` |

  Matches are replaced in place, leaving the surrounding document structure
  intact so the file content remains usable. The policy is transform-only: it
  never denies a call, and responses with no matches (and all out-of-scope
  tools) pass through unchanged. Every response field is read via
  `object.get`, so missing or oddly-shaped payloads are never an error — they
  simply pass through.

  Drive is a de-facto dumping ground for PII, PHI, payroll exports, contracts,
  and board material — files shared in error included — and MCP file-content
  responses bypass classic DLP entirely. This policy is the primary
  minimum-necessary control on the Drive MCP read path.

  ### Group exemption

  Callers whose IdP `groups` claim contains `privacy-reviewers` (a placeholder
  name — see Known limitations) receive **unredacted** content. The check
  reads `input.subject.claims.groups` via `object.get` chains: a missing
  subject, missing claims, or missing `groups` claim means the caller is *not*
  exempt and redaction applies — the grant fails closed. This failure mode is
  safe: a caller whose claims fail to arrive gets over-redaction, never
  disclosure.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in Drive file
    content as it leaves the gateway toward the agent.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information on the read path; **P4.1** — supports limiting personal
    information use to identified purposes; **P6.1** — supports controls over
    personal-information disclosure by keeping raw identifiers out of agent
    context that doesn't need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits: only placeholder `privacy-reviewers` group members see
    raw identifiers; everyone else gets working content with identifiers
    masked. Drive folders routinely hold PHI-bearing spreadsheets and intake
    forms.
  - **HIPAA §164.514(a)–(b)** — supports de-identification practice by
    stripping Safe-Harbor identifier classes (SSN, email, phone) from
    responses; **§164.530(c)** — supports privacy safeguards on the agent
    channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR content in Drive files;
    **Art. 5(1)(f) / Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, national ID numbers) on the agent
    channel; **§1798.150** — reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in Drive — there is nothing to block at ingress, and
  denying file reads outright would make the agent useless for everyday
  document work. The leak happens when file content is returned to the MCP
  client, so the response path is the only place to catch it while keeping the
  content useful. (For folders that should never be read at all, pair with an
  ingress fence — see Composition.)

  ## Tool name matching

  Applies on the output path (`input.mode == "output"`) to tools matched
  case-insensitively **by suffix** on `lower(input.resource.name)` (with a
  leading hyphen, so generic verb suffixes cannot accidentally match unrelated
  tools), with `input.tool_metadata.name` as a fallback. Suffix matching keeps
  the policy portable across gateway server-name prefixes (the DTwo gateway
  prefixes tool names with the configured MCP server name, e.g.
  `gdrive-read_file_content`).

  The suffix set covers the content-returning tools of all three live Drive
  MCP server families:

  - **Google official Drive MCP server / Anthropic-hosted Claude connector:**
    `-read_file_content`, `-download_file_content`
  - **isaacphi/mcp-gdrive:** `-gdrive_read_file`, `-gsheets_read`
  - **piotr-agier/google-drive-mcp** (camelCase names, lowercased by the
    match): `-downloadfile`, `-readgoogledoc`, `-readgoogledocpaginated`,
    `-getgooglesheetcontent`, `-getgoogleslidescontent`

  Verify the exact names your gateway emits with the dump-input debug
  technique before relying on this in production, and extend
  `pii_read_suffixes` for any other content-returning tools your deployment
  exposes (see Known limitations for the adjacent read surfaces deliberately
  not matched here).

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each string block
  (including string blocks containing serialized JSON or exported
  Docs/Sheets text, since the regexes run over the serialized text).
  Non-string blocks pass through unmodified. When at least one block changes,
  the policy emits `transform.transformed_payload` containing the original
  payload with the rewritten `text` array (all other payload keys preserved).
  When nothing changes, no transform is emitted and the response passes
  through byte-identical.

  If a gateway or tool emits `payload.text` as a **bare string** rather than a
  content-block array, that shape is redacted too (string in, string out — the
  rewrite is shape-preserving); it does not fall through unredacted. Only a
  `text` value that is neither a string nor an array (or a payload with no
  `text` at all) is passed through untouched.

  ## Examples

  ### Redacted (in-scope tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "gdrive-read_file_content", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "gdrive-read_file_content",
        "text": ["Payroll: SSN 123-45-6789, contact jane.doe@example.com"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["Payroll: SSN [REDACTED-SSN], contact [REDACTED-EMAIL]"]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "gdrive-read_file_content", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["privacy-reviewers"] } },
      "payload": {
        "name": "gdrive-read_file_content",
        "text": ["Payroll: SSN 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `privacy-reviewers` group receives raw
  content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes
  cleanly with deny policies on the same pipeline. Recommended companions for
  `apps/google-drive`:

  - **`cap-bulk-export`** (ingress) — clamps `pageSize`/pagination on
    `search_files` / `gdrive_search` / `search`, throttling the mass
    enumeration that turns a single redaction miss into a bulk leak.
  - **`fence-restricted-folders`** (ingress) — blocks reads of HR/M&A/board
    folders outright; redaction is the wrong tool for files no agent should
    open at all.
  - A `guard-external-send`-style policy on the mail path so content redacted
    on read is not simply exfiltrated through another app instead.

  ## Known limitations

  - **Official Google server response shapes are unverified.** Google's MCP
    reference does not publish per-tool parameter or response schemas (it
    defers to `tools/list` at the live endpoint). This policy assumes the
    standard MCP string content-block shape in `input.payload.text`; verify
    against a live `tools/list` pull and the dump-input technique before
    production. The Claude-connector suffixes are likewise reported by
    third-party write-ups, not official Anthropic docs.
  - **Base64 and binary downloads cannot be regex-scanned.**
    `download_file_content` / `downloadFile` may return base64-encoded or
    binary bytes (PDFs, Office files, images); PII inside them passes through
    any pattern-based egress policy untouched. For regulated folders, pair
    with an ingress fence or group-gate on the download tools rather than
    relying on redaction.
  - **Legacy Claude built-in tools are not matched.** The older claude.ai
    Drive integration reportedly exposed `google_drive_search` /
    `google_drive_fetch` (unverified from published system prompts);
    `-google_drive_fetch` is not in the suffix set. Add it if you still see
    that traffic.
  - **Adjacent read surfaces are not matched.** Search results
    (`search_files`, `gdrive_search`, `search`), file metadata
    (`get_file_metadata`), ACL reads (`get_file_permissions` — enumerates
    collaborator emails), and comments (`listComments`) can all carry PII in
    filenames, snippets, and principal lists but are not content-returning
    tools in this set. Extend `pii_read_suffixes` to taste.
  - **Pattern-based detection is best-effort.** Conservative by design: SSNs
    are matched in hyphenated form only (bare 9-digit runs collide with Drive
    file IDs); phones only in separator-formatted US shapes; the national-ID
    class ships with the UK National Insurance shape only (uppercase) — add
    your jurisdictions' formats; the email pattern will also match
    `user@host` substrings inside URLs and connection strings (a documented
    false-positive cost). Obfuscated, split-across-blocks, spelled-out, or
    image-embedded values are not caught. Treat this as a high-signal
    minimum-necessary layer, not a complete DLP solution.
  - **Non-string content blocks pass through unmodified — including MCP
    `TextContent` objects.** Redaction applies to string entries of
    `input.payload.text` (including serialized-JSON strings, e.g.
    `gsheets_read` tabular output serialized as text). The DTwo egress schema
    documents `payload.text` as an array of strings, but if your gateway
    instead emits the raw MCP content-block shape — objects such as
    `{"type":"text","text":"…"}` — the object is *not* a string, so its inner
    `.text` field is **not scanned and PII inside it leaks through untouched**
    (see the object-block test case). This is a deliberate residual, not a
    parser: verify your gateway's actual block shape with the dump-input
    technique, and if it emits structured blocks, flatten them upstream or add
    an object-aware redaction step before relying on this policy.
  - **Suffix matching assumes the hyphen server-name prefix.** The suffix set
    is anchored with a leading hyphen (`-read_file_content`), matching the
    documented gateway naming `<server-name>-<tool-name>`. A deployment that
    joins the prefix with a different separator (e.g. `gdrive_read_file_content`)
    or exposes an unprefixed bare tool name will *not* match and the response
    will pass through unredacted. Confirm the exact emitted names with the
    dump-input technique and adjust `pii_read_suffixes` if your gateway differs.
  - **Group names are placeholders — replace `privacy-reviewers` with your
    IdP's group name at import time.** The exemption expects the `groups`
    claim as an array of strings (a single bare string is also handled); if
    your IdP emits roles under a namespaced claim, adjust `caller_groups`.
    Missing claims always mean redaction applies — the failure mode is
    over-redaction, not disclosure.
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - google-drive
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
package google_drive.egress.redact_pii

# Transform-only egress policy: rewrites PII in Google Drive content-returning
# tool responses to fixed redaction tokens before the response reaches the
# agent. Never denies. Callers in the placeholder `privacy-reviewers` IdP
# group receive unredacted responses; the group check fails closed, so a
# caller with missing claims gets over-redaction, never disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Scope: the content-returning tools of the three live Drive MCP server
# families (Google official / Claude connector, isaacphi/mcp-gdrive,
# piotr-agier/google-drive-mcp). The gateway prefixes tool names with the
# configured MCP server name (e.g. `gdrive-read_file_content`), so we match by
# suffix; the leading hyphen keeps generic verbs from matching unrelated
# tools once the prefix is stripped.
# -----------------------------------------------------------------------------

pii_read_suffixes := {
    # Google official Drive MCP server + Anthropic-hosted Claude connector
    "-read_file_content",
    "-download_file_content",
    # isaacphi/mcp-gdrive
    "-gdrive_read_file",
    "-gsheets_read",
    # piotr-agier/google-drive-mcp (camelCase tool names, lowercased here)
    "-downloadfile",
    "-readgoogledoc",
    "-readgoogledocpaginated",
    "-getgooglesheetcontent",
    "-getgoogleslidescontent",
}

is_pii_read_tool if {
    input.mode == "output"
    some suffix in pii_read_suffixes
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), suffix)
}

is_pii_read_tool if {
    # Egress hooks also expose the tool name under tool_metadata.name — check
    # both so we match regardless of which surface the gateway populates.
    input.mode == "output"
    some suffix in pii_read_suffixes
    meta := object.get(input, "tool_metadata", {})
    endswith(lower(object.get(meta, "name", "")), suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP group whose members receive unredacted
# responses. Replace "privacy-reviewers" with your IdP's group name at import
# time. object.get chains mean a missing subject/claims/groups claim is never
# exempt: the grant fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"privacy-reviewers"}

caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    [],
)

is_exempt if {
    some g in caller_groups
    lower(g) in exempt_groups
}

is_exempt if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) in exempt_groups
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives.
# -----------------------------------------------------------------------------

# Email addresses in the conservative mailbox@domain.tld shape. Also matches
# user@host substrings inside URLs and connection strings — a documented
# false-positive cost of regex over arbitrary file content.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide
# with Drive file IDs and raw phone digits, so they are deliberately not
# matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# National-ID class: UK National Insurance number — two prefix letters
# (excluding D, F, I, Q, U, V), six digits, suffix letter A-D. Uppercase only;
# add your jurisdictions' national-ID shapes alongside this one.
nino_pattern := `\b[A-CEGHJ-PR-TW-Z]{2}[0-9]{6}[A-D]\b`

# Separator-formatted US phone numbers (e.g. 206-555-0100, (206) 555-0100,
# (206)555-0100, +1 206.555.0100). A parenthesized area code may be followed by
# an optional separator ((206)555-0100 as well as (206) 555-0100); a bare area
# code still requires a separator, so bare 10-digit runs are deliberately not
# matched.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)[-. ]?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings (regex.replace returns the
# input unchanged when its pattern doesn't match), so the steps chain safely.
# -----------------------------------------------------------------------------

redact_emails(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

redact_ssns(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_ninos(t) := regex.replace(t, nino_pattern, "[REDACTED-NATIONAL-ID]")

redact_phones(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

# Order matters: emails first, so the digit patterns can never half-eat a
# digit-bearing local part; then SSNs (tightest digit shape), national IDs
# (alphanumeric, disjoint from the digit patterns), and phones last (loosest).
redact_block(b) := redact_phones(redact_ninos(redact_ssns(redact_emails(b)))) if {
    is_string(b)
}

# Non-string content blocks (structured blocks) pass through unmodified.
redact_block(b) := b if { not is_string(b) }

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not exempt, and at
# least one block actually changed. Otherwise the rule is undefined and the
# aggregator skips this policy, returning the response byte-identical.
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
    is_pii_read_tool
    not is_exempt
    is_array(text_blocks)
    redacted_blocks != text_blocks
}

# Some gateways/tools emit `payload.text` as a bare string rather than a
# content-block array. Redact that shape too (string in, string out — the
# rewrite is shape-preserving) so PII is not leaked on this fail-open path.
# Mutually exclusive with the array rule above (is_string vs is_array), so the
# two complete-value transform rules never both fire.
transform := {
    "transformed_payload": object.union(response_payload, {"text": redacted_text}),
} if {
    is_pii_read_tool
    not is_exempt
    is_string(text_blocks)
    redacted_text := redact_block(text_blocks)
    redacted_text != text_blocks
}
```
