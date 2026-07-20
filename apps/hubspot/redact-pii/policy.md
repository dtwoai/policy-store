---
name: HubSpot Redact PII
tags:
  - hubspot
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-06-16
description: |
  # hubspot / redact-pii

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `hubspot.egress.redact_pii`

  ## What it does

  Redacts sensitive contact information from HubSpot tool responses before they
  reach the caller. It is transform-only — it never denies a call, it only
  rewrites matching content to `[REDACTED]`. Any non-HubSpot tool, and any
  request that isn't on the output path, passes through untouched.

  ## Compliance alignment

  - **SOC 2 CC6.7** — restricts transmission and movement of information:
    contact PII is masked before responses leave the gateway.
  - **HIPAA §164.502(b) / §164.514(d)** — minimum necessary: callers see CRM
    records without direct identifiers they don't need; **§164.514(a)–(b)** —
    supports de-identification by masking Safe-Harbor identifier classes
    (phone numbers, email addresses, SSNs) in responses.
  - **GDPR Art. 5(1)(c)** — data minimisation on the agent channel; **CPRA
    §1798.121** — supports limiting use of sensitive personal information
    (SSNs are masked); **§1798.150** — reduces nonredacted-PI exposure if agent
    context is later compromised.
  - **ISO 27001 A.8.11; A.8.12** — data masking and data-leakage prevention
    applied at the egress control point.

  ## Why egress

  The risk is *reading* PII that lives in HubSpot CRM records (phone numbers,
  emails, etc.). Those values exist regardless of this gateway, so there is
  nothing to block at ingress — the leak happens when the content is returned to
  an MCP client. Masking on the egress (response) path is the only place to catch
  it.

  ## Scope / tool matching

  Applies to any tool whose (lowercased) name starts with `hubspot-`, on the
  output path (`input.mode == "output"`). Confirm the exact tool names and the
  server-name prefix your gateway emits with the dump-input debug technique
  before relying on this in production; if your HubSpot MCP server is registered
  under a different prefix, adjust the `startswith` check.

  ## What gets redacted

  Redaction works two ways. **By field name** — the structured fields `phone`,
  `mobilephone`, `fax`, `email`, and `hs_email_domain`. And **by pattern** in any
  string value:

  - Formatted phone numbers (with separators, e.g. `555-666-7777`, `(555) 666.7777`, `+1-555-666-7777`)
  - Raw 10-digit phone numbers (`\b\d{10}\b`, bounded so it won't match inside longer HubSpot IDs)
  - Email addresses
  - US SSNs (`XXX-XX-XXXX`)

  Matches are replaced with `[REDACTED]`.

  ## Examples

  ### Redacted (HubSpot tool response)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "hubspot-list-objects", "type": "tool" }
    }
  }
  ```

  `allow = true`, with a `transform` supplying the redaction patterns, field
  names, and `replacement = "[REDACTED]"` for the gateway to apply to the
  response body.

  ### Passed through (non-HubSpot tool, or not output path)

  A response from a non-`hubspot-` tool, or any request not on the output path,
  returns `allow = true` with no `transform` — unchanged.

  ## Known limitations

  - **Regex over text.** Detection is pattern-based, so novel formats and
    non-standard shapes may be missed, and benign strings that look like a phone
    or email may be over-redacted. Treat this as a high-signal layer, not a
    complete DLP solution.
  - **Prefix-scoped.** Scoping is `startswith("hubspot-")`. A HubSpot MCP server
    registered under a different prefix won't be covered until the check is
    adjusted.
  - **No identity-based exemptions.** All callers get the same redaction. Add an
    `input.subject.claims`-gated branch if a break-glass role needs raw values.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - hubspot
industries: []
bundles:
  - crm
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package hubspot.egress.redact_pii

# Transform-only policy — never blocks, only redacts sensitive fields from HubSpot responses
default allow := true

transform := {
    "redact_patterns": [
        # Formatted phone numbers — requires at least one separator between digit groups
        # Matches: 555-666-7777, (555) 666.7777, +1-555-666-7777
        # Does NOT match raw digit strings like 5556667777 (handled below)
        "\\+?1?[\\s.\\-]?\\(?\\d{3}\\)?[\\s.\\-]\\d{3}[\\s.\\-]\\d{4}",
        # Raw 10-digit phone numbers (exactly 10 consecutive digits)
        # \b ensures it won't match inside longer numbers like 12-digit HubSpot IDs
        "\\b\\d{10}\\b",
        # Email addresses
        "[\\w.+\\-]+@[\\w.\\-]+\\.[a-zA-Z]{2,}",
        # SSNs (XXX-XX-XXXX)
        "\\b\\d{3}-\\d{2}-\\d{4}\\b"
    ],
    "redact_fields": ["phone", "mobilephone", "fax", "email", "hs_email_domain"],
    "replacement": "[REDACTED]"
} if {
    input.mode == "output"
    startswith(lower(input.resource.name), "hubspot-")
}
```
