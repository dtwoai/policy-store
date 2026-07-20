---
name: Mask Card Numbers in Email Content Read by Agents
tags:
  - gmail
  - mask-pan-egress
  - egress
  - email
  - cardholder-data
  - dlp
  - soc2
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # gmail / mask-pan-egress

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `gmail.egress.mask_pan`

  ## What it does

  Masks payment-card-number (PAN) shapes in email content returned to agents
  by Gmail mailbox-read tools. When an agent reads a message, thread, or
  search result, any 13–19-digit card-number-shaped string in the response —
  with or without space/dash separators — is replaced with `[PAN REDACTED]`
  before the content reaches the agent.

  The policy never blocks a call. It declares `redact_patterns` that the
  gateway applies over the response text (`input.payload.text`), so mailbox
  reads keep working and only the card numbers are masked.

  Callers in a documented IdP group (placeholder: `pci-full-pan`) skip the
  transform and see unmasked content. The exemption is fail-closed: a caller
  with no claims, no `groups` claim, or a malformed `groups` claim is never
  exempt.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on movement/removal of
    information: masking PANs before mailbox content reaches the agent keeps
    cardholder data from being relayed out of Gmail over the MCP path.
  - **SOC 2 C1.1** — supports identification and protection of confidential
    information: card numbers are treated as confidential and masked on the
    agent channel by default, with full-PAN visibility limited to a defined
    role.
  - **PCI DSS 3.4.1** — supports masking of PAN when displayed: the agent
    channel shows `[PAN REDACTED]` instead of full card numbers, with
    visibility of full PAN limited to a defined role (`pci-full-pan`).
  - **PCI DSS 3.4.2** — supports preventing copy/relocation of PAN via remote
    access: an agent that never receives the full PAN cannot re-post it into
    tickets, chats, or files.
  - **PCI DSS 12.5.2 / 12.10.7** — supports PCI scope control: masking on the
    mailbox-read path is a backstop against cardholder data creeping into
    agent context from email, one of the classic PAN-where-not-expected
    channels.
  - **CCPA/CPRA §1798.150** — supports reducing exposure of nonredacted
    personal information: card numbers surfaced to agents from mailboxes are
    redacted by default.
  - Also maps to **ISO 27001 A.8.11** (data masking) on the MCP path, if you
    track that framework.

  ## Tool name matching

  The policy matches Gmail mailbox-content read tools case-insensitively by
  suffix on `input.resource.name`, covering all three MCP-server vocabularies
  in real use:

  - `*get_thread` — Google official / Claude Gmail connector; its
    `FULL_CONTENT` format returns `plaintextBody` for every message in the
    thread, making this the main egress surface.
  - `*search_threads` — Google official / Claude connector; results include
    ~200-char body snippets.
  - `*read_email`, `*search_emails` — GongRzhe/Gmail-MCP-Server.
  - `*get_gmail_message_content`, `*get_gmail_thread_content`,
    `*get_gmail_messages_content_batch`, `*get_gmail_threads_content_batch`,
    `*search_gmail_messages` — taylorwilsdon/google_workspace_mcp, including
    the batch variants that return dozens of full bodies per call.

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `gmail-mcp-get_thread`), and that prefix is not standardized —
  suffix matching keeps the policy portable. Verify the exact names your
  gateway sends with the dump-input debug technique before relying on this
  in production, and add suffixes if your Gmail MCP server uses different
  read-tool names.

  ## Patterns matched

  Conservative PAN shapes only — each pattern is commented in the Rego:

  - 16-digit PANs grouped 4-4-4-4 with space or dash separators
    (Visa/Mastercard/Discover print format).
  - 15-digit American Express PANs grouped 4-6-5, constrained to the 34/37
    IIN range.
  - Unseparated 13–19-digit runs (the ISO/IEC 7812 PAN length range).

  ## Response shape

  Egress transforms are applied by the gateway over the serialized response
  content blocks (`input.payload.text`). The patterns are byte-level and not
  JSON-aware, so they mask PANs wherever they appear in the response —
  `plaintextBody` fields, snippets, subjects — without the policy needing to
  parse the tool-specific JSON shape.

  ## Examples

  ### Transformed (masked)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "gmail-mcp-get_thread", "type": "tool" },
      "payload": {
        "name": "gmail-mcp-get_thread",
        "text": ["{\"messages\":[{\"plaintextBody\":\"Card: 4111 1111 1111 1111, exp 12/27\"}]}"]
      },
      "subject": { "sub": "google-apps|casey@acme.com", "claims": { "groups": ["support"] } }
    }
  }
  ```

  `allow = true`; `transform` emits the PAN patterns with replacement
  `[PAN REDACTED]`, so the agent sees `Card: [PAN REDACTED], exp 12/27`.

  ### Allowed unmasked (exempt group)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "gmail-mcp-get_thread", "type": "tool" },
      "payload": {
        "name": "gmail-mcp-get_thread",
        "text": ["{\"messages\":[{\"plaintextBody\":\"Card: 4111 1111 1111 1111\"}]}"]
      },
      "subject": { "sub": "google-apps|pci-analyst@acme.com", "claims": { "groups": ["pci-full-pan"] } }
    }
  }
  ```

  `allow = true`, no transform — the caller is in the `pci-full-pan` group.

  ## Composition

  This policy masks card numbers only. Useful companions:

  - A companion Gmail **PII redaction** egress policy (PF-02
    `redact-pii-egress`) for SSNs, national IDs, and credentials/secrets in
    mailbox content — one policy, one job; card data and broader PII are
    separate concerns with separate exemption groups.
  - `apps/gmail/cap-bulk-export` (PF-08) for volume control on the batch
    read tools (`get_gmail_messages_content_batch`,
    `get_gmail_threads_content_batch`, search `maxResults`) — masking does
    not stop mass harvesting of masked content.
  - `apps/gmail/guard-external-send` and `apps/gmail/guard-mailbox-persistence`
    for the outbound and persistence sides of the mailbox.

  ## Known limitations

  - **Regex cannot Luhn-validate.** Rego pattern matching is pure regex, so
    matches are card-number *shapes*, not verified PANs, and fixed-string
    replacement masks the entire match — BIN+last4 preservation (the usual
    PCI display format) is not achievable here; treat `[PAN REDACTED]` as
    the display format on the agent channel.
  - **Byte-level over-matching.** The patterns run over the serialized
    response bytes, so digit runs that merely look like PANs are masked too:
    13-digit Unix millisecond timestamps, 13–19-digit order/tracking/account
    numbers, and digit-only 4-4-4-4 groups inside UUID-like identifiers.
    The grouped patterns require separators and the run pattern stops at 19
    digits to limit this, but false positives are inherent — test against
    representative mailbox data.
  - **Obfuscated PANs are missed.** Card numbers split across content
    blocks, separated by characters other than space/dash (dots, unicode
    spaces), spelled out, inside images, or base64-encoded in MIME parts do
    not match. Runs of 20+ digits also do not match by design. Three regex
    edges are worth calling out explicitly, because a red-team review found
    them and they are inherent to the pattern set, not bugs:
    - **ASCII digits only.** The patterns use `\d`, which matches only
      `[0-9]`. Fullwidth (`４１１１…`) or Arabic-Indic (`٤١١١…`) digit
      variants are not masked.
    - **Only two grouped shapes.** Separated PANs are caught only in the
      4-4-4-4 (16-digit) and 4-6-5 (Amex) print groupings. A PAN typed with
      spaces in some other arrangement (e.g. `41111111 11111111`, an 8+8
      split, or `4111 111111111111`, a 4+12 split) matches neither the
      grouped patterns nor the unseparated-run pattern (the space breaks the
      run into sub-13-digit pieces).
    - **Word-boundary anchoring.** The unseparated-run pattern requires a
      word boundary on both sides, so a digit run glued directly to letters
      (`card4111111111111111x`) is not masked. Real mailbox content almost
      always surrounds numbers with quotes/spaces/punctuation, so this is a
      contrived rather than common evasion — but it is a true residual.
  - **Only mailbox-body read tools are matched — draft/label/filter reads
    are not.** The suffix allowlist deliberately covers message/thread/search
    content tools only. The Google/Claude connector's `list_drafts`, and the
    community servers' label/filter listing reads (`list_email_labels`,
    `list_filters`, `get_filter`, `list_gmail_labels`, `list_gmail_filters`),
    are **not** matched, so a card number sitting in a draft body (e.g. a
    human-composed draft the agent reads back via `list_drafts`) is returned
    unmasked. This is a scoping choice, not a fix: draft/label/filter
    response shapes vary and `list_drafts` may return only metadata on some
    servers. If drafts routinely carry cardholder data in your environment,
    either add `list_drafts` (and your server's draft-read suffix) to
    `mailbox_read_suffixes` after verifying its response shape with the
    dump-input technique, or gate draft reads at ingress with a group-gated
    deny.
  - **Attachment content is not maskable.** `get_gmail_attachment_content`
    (taylorwilsdon) and `download_attachment` (GongRzhe) return
    base64/binary data that byte-level regex cannot reliably mask —
    deliberately out of scope here. Gate those tools at ingress instead
    (e.g. a group-gated deny policy on attachment-content tools).
  - **Egress masking only.** The card number still exists in the mailbox and
    in Gmail's own UI; this policy controls what the *agent* sees on the MCP
    path.
  - **Group names are placeholders** — replace `pci-full-pan` with your
    IdP's group name at import time. The exemption reads
    `input.subject.claims.groups`; confirm your IdP emits a `groups` claim
    (see the DTwo identity-claims documentation).

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - gmail
industries: []
bundles:
  - soc2
  - pci-dss
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gmail.egress.mask_pan

# Transform-only policy — never denies, only masks card-number shapes
# in mailbox content returned to the agent.
default allow := true

# Conservative PAN-shaped patterns. These are applied byte-level over the
# serialized response, so each is anchored with \b word boundaries to limit
# over-matching. Pure regex cannot Luhn-validate — matches are card-number
# shapes, not verified PANs (see Known limitations).
pan_patterns := [
	# 16-digit PANs grouped 4-4-4-4 with space or dash separators
	# (Visa / Mastercard / Discover print format, e.g. 4111 1111 1111 1111).
	# Separators are required here; unseparated PANs are caught by the
	# digit-run pattern below.
	`\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b`,
	# 15-digit American Express PANs grouped 4-6-5 with space or dash
	# separators, constrained to the 34/37 IIN range (e.g. 3782 822463 10005).
	`\b3[47]\d{2}[ -]\d{6}[ -]\d{5}\b`,
	# Unseparated 13-19 digit runs — the ISO/IEC 7812 PAN length range
	# (Visa 13/16, Mastercard 16, Amex 15, Discover 16, JCB 16-19).
	# Runs of 20+ digits never match: there is no word boundary inside a
	# digit run, so this cannot partially mask a longer identifier.
	`\b\d{13,19}\b`,
]

# Gmail mailbox-content read tools across the three MCP-server vocabularies
# in real use (Google official / Claude connector, GongRzhe, taylorwilsdon).
# The gateway prefixes tool names with the configured server name, so we
# match on the suffix to stay portable. Attachment-content tools are
# deliberately absent — base64/binary output is not regex-maskable; gate
# those at ingress instead.
mailbox_read_suffixes := [
	# Google official / Claude connector — FULL_CONTENT returns plaintextBody
	# for every message in the thread (the main egress surface).
	"get_thread",
	# Google official / Claude connector — results carry body snippets.
	"search_threads",
	# GongRzhe/Gmail-MCP-Server.
	"read_email",
	"search_emails",
	# taylorwilsdon/google_workspace_mcp, incl. high-volume batch variants.
	"get_gmail_message_content",
	"get_gmail_messages_content_batch",
	"get_gmail_thread_content",
	"get_gmail_threads_content_batch",
	"search_gmail_messages",
]

is_mailbox_read_tool if {
	name := lower(input.resource.name)
	some suffix in mailbox_read_suffixes
	endswith(name, suffix)
}

# Callers in the placeholder full-PAN group see unmasked content.
# Fail-closed: missing subject, missing claims, missing groups, or a
# malformed groups claim all leave this rule undefined, so the transform
# applies. The is_array guard is load-bearing: without it a groups claim
# shaped as an object (e.g. {"role":"pci-full-pan"}) would iterate its
# *values* and match, granting the exemption to a caller who never held
# the group in an array. Requiring an array keeps every non-array shape
# (string, object, number, null) fail-closed.
# Replace "pci-full-pan" with your IdP's group name at import time.
caller_may_view_full_pan if {
	claims := object.get(object.get(input, "subject", {}), "claims", {})
	groups := object.get(claims, "groups", [])
	is_array(groups)
	some group in groups
	group == "pci-full-pan"
}

# Mask PAN shapes in mailbox-read responses for non-exempt callers.
transform := {
	"redact_patterns": pan_patterns,
	"replacement": "[PAN REDACTED]",
} if {
	input.mode == "output"
	is_mailbox_read_tool
	not caller_may_view_full_pan
}
```
