---
name: "Asana: Redact PII in Task & Comment Reads"
tags:
  - asana
  - redact-pii
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # asana / redact-task-pii

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — redacts PII on read responses; never denies)
  **Package:** `asana.egress.redact_task_pii`

  ## What it does

  On the Asana MCP read path, this transform scans the free-text business fields
  that ride back in task, comment/story, and status-update responses — `notes`,
  `html_notes`, comment/story `text`, and status-update bodies — and rewrites
  direct identifiers to fixed redaction tokens before the payload reaches the
  agent:

  | Class | Detection | Token |
  |---|---|---|
  | US SSN | hyphenated `XXX-XX-XXXX` form | `[REDACTED-SSN]` |
  | Email address | standard `local@domain.tld` shape | `[REDACTED-EMAIL]` |
  | US phone number | separator-formatted (`206-555-0100`, `(206) 555-0100`, `(206)555-0100`, `+1 206.555.0100`) | `[REDACTED-PHONE]` |
  | IBAN | electronic-format `CC kk BBAN` (2 letters + 2 check digits + 11–30 alphanumerics) | `[REDACTED-IBAN]` |

  Each class is matched independently — a lone email, phone, SSN, or IBAN is
  redacted on its own. Matches are replaced in place, so structural fields (task
  GIDs, project/section structure, non-PII field values) stay intact and the
  agent can still reason over the rest of the task. This is a transform: it never
  denies a read, and responses with no match (and all out-of-scope tools) pass
  through byte-identical.

  Asana is routinely used for HR (hiring, performance, offboarding), legal, M&A,
  and incident projects, so task bodies, comments, and status updates carry PII
  and confidential material as plain free text. Because `search_tasks` /
  `search_objects` span everything the connecting OAuth user can see, egress of
  these read tools is the primary leak-reduction surface named in the Asana
  landscape note — sensitivity is a property of the task/project, not the tool,
  so regulated data rides back in a *generic* read regardless of which task
  produced it. This makes egress redaction the primary minimum-necessary control
  on the Asana read path, defense-in-depth behind any ingress project fence.

  ### Redaction exemption group

  Callers whose IdP `groups` claim contains `privacy-officer` (a placeholder name
  — see Known limitations) receive **unredacted** read responses, so authorized
  reviewers still see raw values. The check reads claims via
  `object.get(input.subject, "claims", {})` then `object.get(..., "groups", [])`:
  a missing subject, missing claims, missing `groups`, or a `groups` claim that
  is not a clean array/string of names means the caller is *not* exempt and
  redaction applies — the grant fails closed. The failure mode is over-redaction,
  never disclosure.

  ## Compliance alignment

  Instantiates egress PII redaction (family PF-02) for Asana and supports
  alignment with:

  - **SOC 2 CC6.7** — supports restricting the transmission/movement of
    confidential information by masking direct identifiers in task/comment/status
    content as it leaves the gateway toward the agent; **C1.1** — supports
    identification and protection of confidential information on the read path;
    **P4.1** — supports limiting personal-information use to identified purposes;
    **P6.1** — supports controls over personal-information disclosure to parties
    (here, the agent) that do not need raw identifiers.
  - **GDPR Art. 5(1)(c)** — data minimisation on agent reads of personal data;
    **Art. 9** — reduces special-category exposure on the MCP path where
    identifiers co-occur with health/HR content in task bodies and comments;
    **Art. 5(1)(f) / Art. 32** — supports security of processing.
  - **CCPA/CPRA §1798.121** — supports limiting the use and disclosure of
    sensitive personal information (SSN, financial account identifiers) on the
    agent channel; **§1798.150** — reduces nonredacted-PI breach exposure.

  ## Why egress

  The PII already lives in Asana — there is nothing to block at ingress on a
  generic task or search read, and denying reads outright would make the agent
  useless for everyday work-management tasks. The leak happens when task,
  comment, and status text is returned to the MCP client, so the response path is
  the only place to catch it while keeping the content useful. This complements —
  not replaces — an ingress project fence.

  ## Tool name matching

  Applies on the output path — scoped when either `input.mode == "output"` or
  `input.action == "tool_post_invoke"` holds, so redaction still fires on a
  gateway build that populates only one of the two (keying on `mode` alone would
  fail open if it were unset). The tool name is read from `input.resource.name`
  (the PARC egress surface, populated on `tool_post_invoke`) and lower-cased.

  Matching is **suffix-based and separator-anchored**: a scope suffix matches when
  the tool name equals it, or ends with `-<suffix>` or `_<suffix>` (the two
  realistic gateway prefix separators). This is what lets one suffix cover both
  Asana naming styles behind any gateway server prefix — the official V2 server
  dropped the `asana_` prefix and uses bare snake_case verbs (`get_task`), while
  the community `roychri`/`cristip73` servers keep it (`asana_get_task`). The
  bare official name matches by equality or a `-`/`_` gateway separator; the
  community name matches because `asana_get_task` ends with `_get_task`. Unlike a
  plain `endswith`, separator anchoring does **not** over-match a longer word that
  merely ends in the suffix (e.g. a hypothetical `forget_task` is not caught by
  the `get_task` suffix).

  **Redaction scope** (Asana read tools whose responses carry task/comment/status
  free-text):

  - Official V2 server: `get_task`, `get_tasks`, `get_my_tasks`, `search_tasks`,
    `search_objects`, `get_status_overview`, `get_attachments`
  - Community (`roychri`/`cristip73`): `asana_get_task`, `asana_get_my_tasks`,
    `asana_search_tasks`, `asana_get_multiple_tasks_by_gid`,
    `asana_get_task_stories`, `asana_get_subtasks`, `asana_get_tasks_for_project`,
    `asana_get_project_status`, `asana_get_project_statuses`

  `get_my_tasks`, `get_subtasks`, and `get_tasks_for_project` are in scope for the
  same reason as `get_task`/`get_tasks`: they all return task objects whose
  `notes`/`html_notes` free-text carries the same identifiers — an agent must not
  be able to sidestep redaction by reading tasks through a different verb.

  The suffix set uses the community core verbs (e.g. `get_task_stories`,
  `get_multiple_tasks_by_gid`, `get_project_status`, `get_project_statuses`) so
  the same rule matches whether the tool arrives bare, `asana_`-prefixed, or
  behind a gateway server prefix. `get_project_status` and `get_project_statuses`
  are listed separately because separator-anchored matching treats them as
  distinct suffixes (the singular is not a suffix of the plural).

  Verify the exact names your gateway emits with the dump-input debug technique
  before relying on this in production, and extend `pii_read_suffixes` for any
  other content-returning Asana read your deployment exposes (see Known
  limitations).

  ## Response shape

  The policy reads `input.payload.text` — the MCP content-block array the gateway
  populates on `tool_post_invoke` — and rewrites each block. It handles the two
  content-block shapes a gateway realistically emits:

  - **Plain-string blocks** (`"text": ["...task JSON or comment body..."]`) are
    redacted directly. Because Asana task reads serialize `notes` / `html_notes`
    and story `text` into the response text, the regexes run over that serialized
    JSON and catch the values without needing to parse it.
  - **MCP-standard structured text blocks** (`{"type":"text","text":"..."}`) have
    their inner `text` string redacted while every other key is preserved.

  Any other block (an object with no string `text` field, or a non-string /
  non-object value) passes through unmodified — the policy makes no claim over
  arbitrary structured data whose PII sits under other keys. When at least one
  block changes, the policy emits `transform.transformed_payload` with the
  rewritten `text` array (all other payload keys, including `name`, preserved).
  When nothing changes, no transform is emitted and the response passes through
  byte-identical. Note `text` must be an **array**: a gateway that returns a bare
  scalar string under `payload.text` (off the documented shape) is not rewritten
  — see Known limitations.

  ## Argument shape

  This is an egress policy; it inspects `input.payload.text` (response content),
  not request args. Identity is read from `input.subject.claims.groups` via
  `object.get` chains. No request-argument assumptions are made.

  ## Examples

  ### Redacted (in-scope task read, non-exempt caller)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "asana-mcp-get_task", "type": "tool" },
      "subject": { "sub": "auth0|u1", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "asana-mcp-get_task",
        "text": ["{\"notes\":\"Reach jane@acme.com or 206-555-0100; SSN 123-45-6789\"}"]
      }
    }
  }
  ```

  `allow = true`, with `transform.transformed_payload.text` =
  `["{\"notes\":\"Reach [REDACTED-EMAIL] or [REDACTED-PHONE]; SSN [REDACTED-SSN]\"}"]`.

  ### Passed through (exempt caller)

  A caller whose `groups` includes `privacy-officer` receives task content
  unredacted (`allow = true`, no `transform`).

  ### Passed through (out of scope / no match)

  A non-read tool, or an in-scope read whose text contains no matching
  identifier, returns `allow = true` with no `transform` — the response is
  byte-identical.

  ## Composition

  Transform-only (`default allow := true`); it composes cleanly on the Asana
  egress pipeline and never blocks a read. Recommended companions in `apps/asana`:

  - An ingress **project fence** (`fence-sensitive-projects`) so the agent only
    reads projects it is entitled to. This egress redactor is defense-in-depth
    behind that fence — even a reader authorized for a project should not stream
    raw identifiers into model context.
  - **`freeze-destructive-ops`** / **`cap-batch-mutation`** for the ingress
    destructive and mass-mutation surfaces that this read-path policy does not
    touch.

  ## Known limitations

  - **Pattern-based detection is best-effort and conservative by design.** SSNs
    are matched in hyphenated `XXX-XX-XXXX` form only — space- or dot-separated
    forms (`123 45 6789`, `123.45.6789`) and bare 9-digit runs (which collide with
    Asana numeric GIDs) are **not** matched; phone numbers only in
    separator-formatted US shapes (the parenthesized area-code form matches with or
    without a separator before the local number, e.g. `(206)555-0100`);
    IBANs only in compact electronic format (`DE89370400440532013000`) — the
    space-grouped print form (`DE89 3704 0044 0532 0130 00`) is **not** matched,
    and the country code must be uppercase. `\b`-anchored identifiers that abut a
    word character — a run-on like `id123-45-6789`, a Markdown-italic
    `_123-45-6789_` — are **not** matched. Non-ASCII digit forms escape (RE2 `\d`
    is ASCII-only). Obfuscated, spelled-out, split-across-blocks, or base64-encoded
    values are not caught. The IBAN pattern may also over-match an uppercase
    reference code that happens to fit the `CCkk` + long-alphanumeric shape. Treat
    this as a high-signal minimum-necessary layer, not a complete DLP solution.
  - **Regex over rendered text will miss custom-format identifiers, and may not
    reach PII nested inside `custom_fields` values.** Asana custom fields
    frequently hold salary bands, deal values, and customer identifiers; when
    those are returned inside structured blocks or under keys the response
    serializer does not flatten into scanned text, they stream through unredacted.
    This behavior is documented but **not** schema-verified (per-parameter Asana V2
    schemas are only available via a live `tools/list`). Fence sensitive projects
    at ingress where custom-field exposure matters.
  - **Block coverage and the `text`-array assumption.** Redaction applies to
    plain-string entries of `input.payload.text` (including serialized-JSON
    strings) **and** to MCP-standard structured text blocks
    (`{"type":"text","text":"..."}`). Blocks that are objects with **no string
    `text` field** (a custom `{"field":"ssn","value":"…"}` shape, an image/audio
    block, or a nested array of sub-blocks) pass through unmodified and stream any
    embedded identifiers verbatim. A bare scalar string under `payload.text`
    (off-spec) fails the `is_array` transform guard and is **not** rewritten (a
    fail-open residual on an off-spec shape). Confirm your gateway's block shape
    with the dump-input technique.
  - **Redaction covers only the listed read tools.** Other content-returning Asana
    reads (`get_project` / `get_projects`, portfolio readers
    `get_portfolio` / `get_items_for_portfolio`, and the cristip73
    attachment-download surface `asana_download_attachment`) stream body content
    verbatim and are **not** redacted here — the scope is task/comment/status
    free-text, not project- or portfolio-level notes. Add tools your deployment
    exposes to `pii_read_suffixes`, or
    fence them at ingress. Asana's tool set also drifts over time (25 on the docs
    page vs 42–44 in third-party catalogs), so re-verify the read surface
    periodically.
  - **Tool name is read only from `input.resource.name`.** If your gateway build
    populates the egress tool name only under `input.tool_metadata.name` and
    leaves `resource.name` empty, this policy will not match — extend
    `resource_name` to union the other egress surfaces (see the monday/box redact
    policies for that variant).
  - **This is an egress transform, so the upstream read still executes** — only
    the response is rewritten before it reaches the model. The data was read from
    Asana; it is masked on the way to the agent, not prevented from being fetched.
  - **Group names are placeholders — replace `privacy-officer` with your IdP's
    group name at import time.** The check accepts a `groups` claim shaped as an
    array of strings (a single bare string is also handled); any other shape fails
    closed (redaction applies). A missing subject/claims/`groups`, an object/map
    (e.g. a namespaced `{"department":"privacy-officer"}` claim — the `is_array`
    guard stops its *values* being read as group names), and nested/non-string
    array elements are all treated as *not exempt*. This placeholder is **not** the
    ContextForge-internal `is_admin`/`teams`/`user` claims (which are stripped
    before reaching a policy and must never be used for gating).
  - **Egress `transformed_payload` replaces the response payload wholesale.**
    Verify the rewrite against your gateway version with the dump-input technique
    before production, and mind attachment order if other egress transforms run on
    the same pipeline.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - asana
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package asana.egress.redact_task_pii

# Transform-only egress policy: rewrites PII in Asana task/comment/status read
# responses to fixed redaction tokens before the response reaches the agent.
# Never denies. Callers in the placeholder privacy-officer IdP group receive
# unredacted responses.
default allow := true

# -----------------------------------------------------------------------------
# Egress scope. Match the post-invoke/output path on either mode or action: if we
# keyed on input.mode alone and a gateway build left it unset, the scope checks
# would silently fail and redaction would no-op (fail open, leaking content).
# Ingress (tool_pre_invoke / mode "input") satisfies neither branch.
# -----------------------------------------------------------------------------
is_egress if { input.mode == "output" }

is_egress if { input.action == "tool_post_invoke" }

# The egress tool name, from the PARC resource.name surface, lower-cased. Read via
# object.get chains so a missing resource/name yields "" rather than a rule error.
resource_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Separator-anchored suffix match: the tool name equals the suffix, or ends with
# `-<suffix>` or `_<suffix>` (the two realistic gateway prefix separators). This
# covers the bare official verb (`get_task`), the community `asana_`-prefixed name
# (`asana_get_task` ends with `_get_task`), and either behind a gateway server
# prefix. Unlike a bare endswith, it never over-matches a longer word that merely
# ends in the suffix (e.g. `get_task` won't match `forget_task`).
name_has_suffix(n, s) if { n == s }

name_has_suffix(n, s) if { endswith(n, concat("", ["-", s])) }

name_has_suffix(n, s) if { endswith(n, concat("", ["_", s])) }

# -----------------------------------------------------------------------------
# Redaction scope: Asana read tools whose responses carry task/comment/status
# free-text (notes, html_notes, story text, status-update bodies). Suffixes are
# the community core verbs so one entry matches the official bare verb, the
# `asana_`-prefixed community name, and either behind a gateway prefix.
# -----------------------------------------------------------------------------
pii_read_suffixes := {
    # Official V2 server (bare snake_case verbs)
    "get_task",
    "get_tasks",
    "get_my_tasks",
    "search_tasks",
    "search_objects",
    "get_status_overview",
    "get_attachments",
    # Community roychri/cristip73 core verbs (also cover asana_-prefixed forms)
    "get_multiple_tasks_by_gid",
    "get_task_stories",
    "get_subtasks",
    "get_tasks_for_project",
    "get_project_status",
    "get_project_statuses",
}

is_pii_read_tool if {
    is_egress
    some suffix in pii_read_suffixes
    name_has_suffix(resource_name, suffix)
}

# -----------------------------------------------------------------------------
# Identity. Placeholder IdP group name — replace at import time. Claims are read
# via object.get chains so a missing subject/claims/groups is never a grant: the
# redaction exemption fails closed (redaction applies) on any unexpected shape.
# -----------------------------------------------------------------------------
caller_claims := object.get(object.get(input, "subject", {}), "claims", {})

caller_groups := object.get(caller_claims, "groups", [])

# Members receive UNREDACTED read responses.
exempt_groups := {"privacy-officer"}

# group_matches(set): true iff caller_groups (array of strings, or a bare string)
# contains a name in `set`. The is_array guard is load-bearing: `some g in obj`
# iterates an object's VALUES, so a namespaced claim like
# {"department":"privacy-officer"} would else wrongly match. is_string(g) blocks
# nested/non-string elements. Any other shape fails closed.
group_matches(want) if {
    is_array(caller_groups)
    some g in caller_groups
    is_string(g)
    lower(g) in want
}

group_matches(want) if {
    is_string(caller_groups)
    lower(caller_groups) in want
}

is_exempt if { group_matches(exempt_groups) }

# -----------------------------------------------------------------------------
# Detection patterns — anchored and conservative to limit false positives on
# Asana numeric GIDs.
# -----------------------------------------------------------------------------

# US SSN in the canonical hyphenated form only. Bare 9-digit runs collide with
# Asana numeric GIDs, so they are deliberately not matched.
ssn_pattern := `\b\d{3}-\d{2}-\d{4}\b`

# Standard email address shape: local part, @, domain, 2+ letter TLD. Word-boundary
# anchored so it never fires inside longer alphanumeric runs.
email_pattern := `\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b`

# Separator-formatted US phone numbers (206-555-0100, (206) 555-0100,
# (206)555-0100, +1 206.555.0100). A parenthesized area code is itself a strong
# signal, so the separator after `)` is optional; a bare area code still requires
# a following separator, so contiguous digit runs (GIDs) and dotted version
# strings are not matched.
phone_pattern := `(?:\+?1[-. ])?(?:\(\d{3}\)[-. ]?|\b\d{3}[-. ])\d{3}[-. ]\d{4}\b`

# IBAN in compact electronic format: 2-letter uppercase country code, 2 check
# digits, then 11-30 alphanumerics (BBAN). Total 15-34 chars per ISO 13616. The
# space-grouped print form is intentionally not matched (conservative); the
# country code must be uppercase.
iban_pattern := `\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b`

# -----------------------------------------------------------------------------
# Redaction steps — each is total over strings: it returns the input unchanged
# when its class doesn't apply, so the steps chain safely. The classes are
# shape-disjoint (SSN/phone need separators, email needs `@`, IBAN needs a
# leading 2-letter uppercase + 2-digit head), so order is not load-bearing.
# -----------------------------------------------------------------------------
redact_ssn(t) := regex.replace(t, ssn_pattern, "[REDACTED-SSN]")

redact_email(t) := regex.replace(t, email_pattern, "[REDACTED-EMAIL]")

redact_phone(t) := regex.replace(t, phone_pattern, "[REDACTED-PHONE]")

redact_iban(t) := regex.replace(t, iban_pattern, "[REDACTED-IBAN]")

redact_text(t) := redact_iban(redact_phone(redact_email(redact_ssn(t))))

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

# MCP-standard structured text content blocks {"type":"text","text":"..."}: redact
# the inner `text` string and preserve every other key. Without this branch,
# content delivered as content-block OBJECTS (the canonical MCP wire shape) would
# slip past a string-only redactor untouched.
redact_block(b) := object.union(b, {"text": redact_text(bt)}) if {
    not is_string(b)
    bt := block_text(b)
}

# Any other block — an object with no string `text` field, or a non-string /
# non-object value — passes through unmodified.
redact_block(b) := b if {
    not is_string(b)
    not block_text(b)
}

# -----------------------------------------------------------------------------
# Transform — emitted only when in redaction scope, the caller is not exempt, the
# payload text is an array, and at least one block actually changed. Otherwise the
# rule is undefined and the aggregator skips this policy, returning the response
# byte-identical.
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
