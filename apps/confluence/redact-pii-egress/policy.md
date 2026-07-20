---
name: "Confluence: Redact PII from Page & Comment Responses"
tags:
  - confluence
  - atlassian
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
  # confluence / redact-pii-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `confluence.egress.redact_pii`

  ## What it does

  Scans the responses of Confluence page, comment, and search read tools and
  rewrites personally identifiable information to fixed redaction tokens before
  the response reaches the agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Email address | standard `local@domain.tld` shape | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted (e.g. `206-555-0100`, `(206) 555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |

  Each class is matched independently — a lone email, a lone phone number, or a
  lone SSN is redacted on its own. Matches are replaced in place, so the
  surrounding wiki markup, comment threading, and search snippets stay usable
  and the agent keeps working context. The policy is transform-only: it never
  denies a call, and responses with no matches (and all out-of-scope tools)
  pass through byte-identical. Every response field is read via `object.get`,
  so missing or oddly-shaped payloads are never an error — they simply pass
  through.

  Confluence page bodies and comment threads routinely carry identifiers that
  users paste into wiki pages — onboarding SSNs, contact emails, support phone
  numbers — so this is the primary minimum-necessary control on the Confluence
  MCP read path. It is **defense-in-depth behind the ingress space fence**
  (`fence-sensitive-spaces` / CQL-scoping policies): even a reader who is
  authorized for a space should not stream raw identifiers into model context
  unless they hold a documented full-PII group claim.

  ### Group exemption

  Callers whose IdP `groups` claim contains `pii-full` (a placeholder name —
  see Known limitations) receive **unredacted** responses. The check reads the
  claims via `object.get(input.subject, "claims", {})` and then
  `object.get(..., "groups", [])`: a missing subject, missing claims, missing
  `groups` claim, or a `groups` claim that is not a clean array/string of group
  names means the caller is *not* exempt and redaction applies — the grant
  fails closed. This failure mode is safe: a caller whose claims fail to arrive
  gets over-redaction, never disclosure.

  ## Compliance alignment

  Instantiates egress PII redaction (family PF-02) for Confluence and supports
  alignment with:

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in Confluence content
    as it leaves the gateway toward the agent; **C1.1** — supports
    identification and protection of confidential information on the read path;
    **P4.1** — supports limiting personal-information use to identified
    purposes; **P6.1** — supports controls over personal-information disclosure
    by keeping raw identifiers out of agent context that doesn't need them.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary,
    role-based limits: only placeholder `pii-full` group members see raw
    identifiers; everyone else gets working page/comment content with
    identifiers masked. **§164.514(a)–(b)** — supports de-identification
    practice by stripping Safe-Harbor identifier classes (SSN, email, phone)
    from responses; **§164.530(c)** — supports privacy safeguards on the agent
    channel.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR content in pages and comment threads;
    **Art. 5(1)(f) / Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN) on the agent channel; **§1798.150** —
    reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in Confluence — there is nothing to block at ingress,
  and denying page/comment/search reads outright would make the agent useless
  for everyday knowledge work. The leak happens when page-derived text is
  returned to the MCP client, so the response path is the only place to catch it
  while keeping the content useful. This complements — not replaces — an ingress
  space fence: the fence decides *which* spaces a caller may read; this policy
  strips direct identifiers out of whatever content they are allowed to read.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a
  gateway build that populates only one of the two (keying on `mode` alone would
  fail open if it were unset). Tools are matched case-insensitively **by
  suffix**, so the policy stays portable across the MCP server-name prefix the
  gateway adds (observed live as `atlassian-`). The tool name is read from all
  three egress surfaces — `input.resource.name`, `input.tool_metadata.name`, and
  `input.payload.name` — and a suffix hit on **any** of them puts the call in
  scope, so a gateway that populates a different surface can't slip content past
  the scanner.

  Official Atlassian Rovo / Claude connector Confluence read + comment tools
  (camelCase canonical names, all verified in the Atlassian landscape research;
  the connector lowercases them). The suffixes are matched **bare** (no leading
  separator) so a hit lands regardless of which separator the gateway inserts
  between the server-name prefix and the tool — `atlassian-getconfluencepage`,
  `atlassian_getconfluencepage`, and a prefix-less `getconfluencepage` all
  match. (An earlier revision required a leading hyphen; that gave no
  over-match protection and instead failed open — leaking responses — on any
  gateway whose separator was not `-`.) The canonical names are distinctive
  enough that a bare `endswith` never collides with a sibling read/write tool,
  verified against the full Atlassian inventory: `getpagesinconfluencespace`
  ends in `...space`, and `createConfluencePage`/`updateConfluencePage` end in
  `...ateconfluencepage` — none end in `getconfluencepage`:

  - `getconfluencepage`
  - `getconfluencepagedescendants`
  - `searchconfluenceusingcql`
  - `getconfluencepagefootercomments`
  - `getconfluencepageinlinecomments`
  - `getconfluencecommentchildren`

  Community `sooperset/mcp-atlassian` equivalents (snake_case, verified from the
  repo tools reference) that surface the same page/comment/search body content:

  - `confluence_get_page`
  - `confluence_get_page_children`
  - `confluence_get_space_page_tree`
  - `confluence_get_comments`
  - `confluence_search`

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and extend `pii_read_suffixes` for any
  other content-returning Confluence tools your deployment exposes (see Known
  limitations for read surfaces deliberately not matched).

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the
  gateway populates on `tool_post_invoke` — and rewrites each block. It handles
  the two content-block shapes a gateway realistically emits:

  - **Plain-string blocks** (`"text": ["...page body..."]`) are redacted
    directly, including string blocks that carry serialized JSON, since the
    regexes run over the serialized text.
  - **MCP-standard structured text blocks** (`{"type":"text","text":"..."}`)
    have their inner `text` string redacted while every other key (`type`,
    `annotations`, …) is preserved. This branch is deliberate: without it, page
    and comment body delivered as content-block *objects* — the canonical MCP
    wire shape — would slip past a string-only redactor untouched.

  Any other block (an object with no string `text` field, or a non-string /
  non-object value) passes through unmodified — the policy makes no claim over
  arbitrary structured data whose PII sits under other keys. When at least one
  block changes, the policy emits `transform.transformed_payload` containing the
  original payload with the rewritten `text` array (all other payload keys,
  including `name`, preserved). When nothing changes, no transform is emitted and
  the response passes through byte-identical. Note the `text` field must be an
  **array**: a gateway that returns a bare scalar string under `payload.text`
  (off the documented shape) is not rewritten — see Known limitations.

  ## Examples

  ### Redacted (in-scope tool, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "atlassian-getconfluencepage", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["marketing"] } },
      "payload": {
        "name": "atlassian-getconfluencepage",
        "text": ["Onboarding SSN 123-45-6789, contact jane@acme.com or 206-555-0100"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["Onboarding SSN [REDACTED-SSN], contact [REDACTED-EMAIL] or [REDACTED-PHONE]"]`.

  ### Passed through (exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "atlassian-getconfluencepage", "type": "tool" },
      "subject": { "sub": "auth0|u2", "claims": { "groups": ["pii-full"] } },
      "payload": {
        "name": "atlassian-getconfluencepage",
        "text": ["Onboarding SSN 123-45-6789"]
      }
    }
  }
  ```

  `allow = true`, no `transform` — the `pii-full` group receives raw content.

  ## Composition

  Single-purpose transform policy (`default allow := true`); it composes cleanly
  with deny/transform policies on the same egress pipeline. Recommended
  companions in `apps/confluence`:

  - An **ingress space fence** (CQL-scoping / space-allowlist on
    `*-searchconfluenceusingcql` and `*-getconfluencepage`) so the agent only
    reads spaces it is entitled to. This egress redactor is defense-in-depth
    behind that fence, not a substitute for it.
  - The Atlassian **block-secrets** ingress policy so credentials aren't written
    into pages/comments in the first place.
  - The Jira `redact-sensitive-info` egress policy for the sibling Atlassian
    product. See the [`bundles/atlassian`](../../../bundles/atlassian/README.md)
    bundle for the curated Atlassian set.

  ## Known limitations

  - **Pattern-based detection is best-effort.** Conservative by design so it
    does not fire on version strings and page IDs: SSNs are matched in
    hyphenated `XXX-XX-XXXX` form only (bare 9-digit runs collide with
    Confluence numeric page IDs), and phone numbers only in separator-formatted
    US shapes (a contiguous digit run like a page ID `123456789`, or a version
    string like `1.2.3`, does not match). Obfuscated, spelled-out,
    split-across-blocks, base64-encoded, or image-embedded values are not
    caught. **Non-ASCII digit forms also escape** — the regex `\d` class in the
    gateway's RE2 engine matches ASCII `0`–`9` only, so a full-width or other
    Unicode-digit rendering of an SSN/phone (e.g. `１２３-４５-６７８９`) is not
    redacted even though a model reads it as digits. **Word-adjacent
    identifiers also escape:** the SSN and phone patterns are `\b`-anchored
    (deliberately, so they never fire on Confluence numeric page IDs), so an
    identifier that abuts a *word character* — a letter, digit, or underscore —
    on either side is not matched. A run-on like `id123-45-6789`, a trailing
    `206-555-0100x`, and — most realistically — an SSN wrapped in Markdown/wiki
    **italics underscores** (`_123-45-6789_`, which many wiki renderers show as
    italic text) all stream through **unredacted** (confirmed by red-team).
    Space-, colon-, comma-, or parenthesis-delimited identifiers — the common
    presentation — match normally; loosening the anchor to catch the
    word-adjacent cases would re-introduce page-ID false positives, so this is
    left as a documented residual. Treat this as a high-signal
    minimum-necessary layer, not a complete DLP solution.
  - **Phone detection needs a separator after the area code.** Separator-
    formatted US shapes match (`206-555-0100`, `(206) 555-0100`,
    `+1 206.555.0100`), but `(206)555-0100` with no space after the closing
    parenthesis, and bare 10-digit runs, are not matched (documented residual).
  - **Email regex is standard-shape.** It matches `local@domain.tld` and will
    also match an email embedded in a `user:pass@host` connection string; it
    will not match addresses split across markup or obfuscated as
    `jane [at] acme [dot] com`.
  - **Block coverage and the `text`-array assumption.** Redaction applies to
    plain-string entries of `input.payload.text` (including serialized-JSON
    strings) **and** to MCP-standard structured text blocks shaped as
    `{"type":"text","text":"..."}` (the inner `text` is redacted, other keys
    preserved). Blocks that are objects with **no string `text` field** pass
    through unmodified — the policy does not chase PII under arbitrary keys.
    This deliberately includes several **standard MCP content-block shapes**,
    not just custom ones: an embedded-resource block
    (`{"type":"resource","resource":{"text":"…","uri":"…"}}`) carries its text
    under the nested `resource.text` key, an image/audio block carries no text
    at all, and a block that is itself a **nested array** of sub-blocks is
    neither a string nor an object — all three fall to the passthrough branch
    and stream any embedded identifiers **verbatim, unredacted** (confirmed by
    red-team). A custom `{"field":"ssn","value":"…"}` shape leaks the same way.
    If your gateway build emits page/comment bodies as embedded-resource or
    nested-array blocks under `payload.text` (the documented contract is a flat
    array of strings — confirm yours with the dump-input technique), extend
    `block_text`/`redact_block` to descend into `resource.text` and nested
    arrays, or fence those tools at ingress.
    Separately, the `text` field is assumed to be an **array**: a gateway that
    returns a bare scalar string under `payload.text` fails the `is_array`
    transform guard and the response is **not rewritten** (a fail-open residual
    on an off-spec shape — the documented gateway contract always emits an
    array; confirm yours with the dump-input technique before relying on this).
  - **Adjacent and cross-product read surfaces are not matched.** Only the
    Confluence-specific page/comment/search tools in `pii_read_suffixes` are in
    scope. Content-returning tools **outside** that set stream page/comment body
    verbatim, unredacted:
    - the cross-product retrieval tools **`atlassian-fetch` / `atlassian-search`**
      and the beta **`fetchAtlassian` / `searchAtlassian`** tools, which return
      Confluence page and search content under generic names not tied to
      Confluence (verified present on the live connector; their Confluence
      response shape is beta/unverified, so they are deliberately *not* added to
      the suffix set here — add them, after confirming their response shape, if
      your deployment exposes them);
    - attachment-download and page-history/diff tools (community
      `confluence_download_attachment`, `confluence_get_page_history`,
      `confluence_get_page_diff`), which return content under different tool
      names / response shapes.
    Add the tools your deployment exposes to `pii_read_suffixes`, or fence them
    at ingress. This egress redactor is defense-in-depth, not a complete
    egress-channel inventory.
  - **Group names are placeholders — replace `pii-full` with your IdP's group
    name at import time.** The exemption is granted **only** for a `groups`
    claim shaped as an array of strings (a single bare string is also handled).
    Any other shape fails closed → redaction applies: a missing
    subject/claims/`groups`, an object/map (e.g. a namespaced or metadata claim
    like `{"department": "pii-full"}` — the `is_array` guard stops its *values*
    from being read as group names), and nested/non-string array elements are
    all treated as *not exempt*. If your IdP emits roles under a namespaced
    claim, adjust `caller_groups` to point at the array before matching. Missing
    claims always mean redaction applies — the failure mode is over-redaction,
    not disclosure. Note the placeholder group names are illustrative only and
    are not the ContextForge-internal `is_admin`/`teams`/`user` claims (which
    are stripped before reaching a policy and must never be used for gating).
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input
    technique before production, and mind attachment order if other egress
    transforms run on the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - confluence
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
  - atlassian
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package confluence.egress.redact_pii

# Transform-only egress policy: rewrites PII in Confluence page/comment/search
# tool responses to fixed redaction tokens before the response reaches the
# agent. Never denies. Callers in the placeholder full-PII IdP group receive
# unredacted responses; the group check fails closed, so a caller with missing
# or oddly-shaped claims gets over-redaction, never disclosure.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Confluence read tools whose responses carry page-body, comment, or
# search-snippet content. Suffix matching keeps the policy portable across the
# gateway server-name prefix (observed live as `atlassian-`, but ANY separator
# — or a prefix-less emission — is covered). It matches both the official
# Rovo/Claude connector (camelCase, lowercased) and the community sooperset
# server (snake_case). Suffixes are matched BARE (no leading separator): the
# official canonical names are distinctive enough that a bare endswith never
# collides with a sibling tool (verified against the full Atlassian inventory —
# `getpagesinconfluencespace` ends in `...space`, `create/updateConfluencePage`
# end in `...ateconfluencepage`, none in `getconfluencepage`). Requiring a
# leading hyphen (as an earlier revision did) provided NO over-match protection
# and instead FAILED OPEN — leaking every response — on any gateway whose
# prefix separator was not `-` (e.g. `atlassian_getconfluencepage`) or that
# emitted the tool name prefix-less.
# -----------------------------------------------------------------------------

pii_read_suffixes := {
    # Official Rovo / Claude connector Confluence read + comment tools
    "getconfluencepage",
    "getconfluencepagedescendants",
    "searchconfluenceusingcql",
    "getconfluencepagefootercomments",
    "getconfluencepageinlinecomments",
    "getconfluencecommentchildren",
    # Community sooperset/mcp-atlassian equivalents (same body content)
    "confluence_get_page",
    "confluence_get_page_children",
    "confluence_get_space_page_tree",
    "confluence_get_comments",
    "confluence_search",
}

# Egress scope: match the post-invoke/output path on either mode or action. If
# we keyed on input.mode alone and a gateway build left it unset, is_pii_read_tool
# would silently fail and redaction would no-op (fail open, leaking content).
# Ingress (tool_pre_invoke / mode "input") satisfies neither branch, so it stays
# out of scope.
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The tool name is exposed on egress under resource.name (PARC), tool_metadata.name
# (legacy), and payload.name (tool-hook canonical). Collect all three and match if
# ANY carries a read-tool suffix — matching only a subset would let a gateway that
# populates a different surface slip page content past the scanner.
candidate_names contains lower(object.get(object.get(input, "resource", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "tool_metadata", {}), "name", ""))

candidate_names contains lower(object.get(object.get(input, "payload", {}), "name", ""))

is_pii_read_tool if {
    is_egress
    some suffix in pii_read_suffixes
    some n in candidate_names
    endswith(n, suffix)
}

# -----------------------------------------------------------------------------
# Group exemption — placeholder IdP group whose members receive unredacted
# responses. Replace "pii-full" with your IdP's group name at import time.
# Claims are read via object.get(input.subject, "claims", {}); the object.get
# chains mean a missing subject/claims/groups claim is never exempt: the grant
# fails closed and redaction applies.
# -----------------------------------------------------------------------------

exempt_groups := {"pii-full"}

caller_claims := object.get(object.get(input, "subject", {}), "claims", {})

caller_groups := object.get(caller_claims, "groups", [])

is_exempt if {
    # Only an array of group strings grants the exemption. The is_array guard is
    # load-bearing: `some g in caller_groups` over an OBJECT iterates its values,
    # so a namespaced/metadata claim like {"department": "pii-full"} would else
    # wrongly exempt the caller. is_string(g) keeps nested/non-string elements
    # from matching. Anything but a clean array of strings fails closed -> redact.
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    lower(g) in exempt_groups
}

is_exempt if {
    # Some IdPs emit a single group as a bare string rather than an array.
    is_string(caller_groups)
    lower(caller_groups) in exempt_groups
}

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives on
# version strings and page IDs.
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# Confluence numeric page IDs, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Standard email address shape: local part, @, domain, 2+ letter TLD. Word-
# boundary anchored so it never fires inside longer alphanumeric runs.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (e.g. 206-555-0100, (206) 555-0100,
# +1 206.555.0100). A separator after the area code is required, so contiguous
# digit runs (page IDs) and dotted version strings are not matched.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)|\b\d{3})[-. ]\d{3}[-. ]\d{4}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely.
# -----------------------------------------------------------------------------

redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

# All three classes in one pass over a string. Order: SSN first (3-2-4 hyphen
# groups, disjoint from the 3-3-4 phone shape), then emails, then separator-
# formatted phones. Each class is matched independently — no pairing required.
redact_text(t) := redact_phone(redact_email(redact_ssn(t)))

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
# redact the inner `text` string and preserve every other key (type,
# annotations). Without this branch, page/comment body delivered as content-block
# OBJECTS (the canonical MCP wire shape) would slip past a string-only redactor
# untouched — the exact PII this policy targets, leaked verbatim.
redact_block(b) := object.union(b, {"text": redact_text(bt)}) if {
    not is_string(b)
    bt := block_text(b)
}

# Any other block — an object with no string `text` field, or a non-string /
# non-object value — passes through unmodified. The policy makes no claim over
# arbitrary structured data whose PII lives under other keys.
redact_block(b) := b if {
    not is_string(b)
    not block_text(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in scope, the caller is not exempt, and at least
# one block actually changed. Otherwise the rule is undefined and the aggregator
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
    is_pii_read_tool
    not is_exempt
    is_array(text_blocks)
    redacted_blocks != text_blocks
}
```
