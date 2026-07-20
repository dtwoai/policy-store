---
name: Salesforce Redact PII
tags:
  - salesforce
  - pii
  - dlp
  - redaction
  - egress
  - soc2
  - hipaa
  - gdpr-ccpa
  - iso27001-nist
publishedAt: 2026-07-12
description: |
  # salesforce / redact-pii

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `salesforce.egress.pii_redaction`

  ## What it does

  Redacts personal contact information from Salesforce tool responses before they
  reach the caller. It is transform-only — it never denies a call, it only
  rewrites matching content to `[REDACTED]`. Any non-Salesforce tool, and any
  request that isn't on the output path, passes through untouched.

  `Name` and `Account` are intentionally left intact so records stay usable —
  extend `redact_fields` (e.g. add `Name`, `FirstName`, `LastName`) if full-PII
  redaction is required.

  ## Compliance alignment

  - **SOC 2 CC6.7** — restricts the movement of personal contact information out of Salesforce over the agent channel by masking it in responses.
  - **SOC 2 C1.1** — supports identification and protection of confidential information (contact PII fields) on the read path.
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary access: agents get working records without direct contact identifiers.
  - **HIPAA §164.514(a)–(b)** — supports de-identification practice by stripping Safe-Harbor identifier classes (phone, email, address, birthdate) from responses.
  - **PCI DSS 3.4.1** — the 16-digit card-number pattern masks PANs that leak into Salesforce text fields when displayed to the caller.
  - **GDPR Art. 5(1)(c) / Art. 5(1)(f)** — data minimisation and security of processing on agent reads of personal data.
  - **CCPA/CPRA §1798.121 / §1798.150** — supports limiting sensitive PI exposure and reduces nonredacted-PI breach surface on the MCP path.
  - **ISO 27001 A.8.11 / A.8.12** — data masking and data-leakage prevention applied at the gateway.

  ## Why egress

  The risk is *reading* PII that lives in Salesforce records (emails, phone
  numbers, mailing address, birthdate). Those values exist regardless of this
  gateway, so there is nothing to block at ingress — the leak happens when the
  content is returned to an MCP client. Masking on the egress (response) path is
  the only place to catch it.

  ## Scope / tool matching

  Applies to any tool whose (lowercased) name starts with `salesforce-`, on the
  output path (`input.mode == "output"`). If your Salesforce MCP server is
  registered under a different prefix, adjust the `startswith` check. Confirm the
  exact tool names with the dump-input debug technique before deploying.

  ## What gets redacted

  **By field name** — `Email`, `Phone`, `MobilePhone`, `HomePhone`, `OtherPhone`,
  `AssistantPhone`, `Fax`, `MailingStreet`, `MailingCity`, `MailingState`,
  `MailingPostalCode`, `MailingAddress`, `Birthdate` (matched case-insensitively).
  And **by pattern** in any string value: email addresses, US phone numbers
  (formatted and raw 10-digit), US SSNs, and 16-digit credit-card numbers.
  Matches are replaced with `[REDACTED]`.

  ## Examples

  ### Redacted (Salesforce tool response)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "salesforce-soqlquery", "type": "tool" }
    }
  }
  ```

  `allow = true`, with a `transform` supplying the redaction patterns, field
  names, and `replacement = "[REDACTED]"` for the gateway to apply to the
  response body.

  ### Passed through (non-Salesforce tool, or not output path)

  A response from a non-`salesforce-` tool, or any request not on the output
  path, returns `allow = true` with no `transform` — unchanged.

  ## Known limitations

  - **Regex over text.** Detection is pattern-based, so novel formats may be
    missed and benign strings that look like a phone/email/card may be
    over-redacted. Treat this as a high-signal layer, not a complete DLP solution.
  - **Name/Account preserved by design.** These are not redacted so records stay
    identifiable; extend `redact_fields` if you need them masked.
  - **Prefix-scoped.** Scoping is `startswith("salesforce-")`. A server under a
    different prefix won't be covered until the check is adjusted.
  - **No identity-based exemptions.** All callers get the same redaction. Add an
    `input.subject.claims`-gated branch if a break-glass role needs raw values.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - salesforce
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
package salesforce.egress.pii_redaction

# Transform-only egress policy — never blocks, redacts PII from Salesforce responses.
default allow := true

transform := {
    "redact_patterns": [
        # Email addresses
        "[\\w.+\\-]+@[\\w.\\-]+\\.[a-zA-Z]{2,}",
        # US phone numbers (formatted, requires separators between digit groups)
        "\\+?\\d{0,3}[\\s.\\-]?\\(?\\d{3}\\)?[\\s.\\-]\\d{3}[\\s.\\-]\\d{4}",
        # Raw 10-digit phone numbers (word-bounded to avoid matching longer IDs)
        "\\b\\d{10}\\b",
        # Social Security Numbers (XXX-XX-XXXX)
        "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        # Credit card numbers (16 digits, optional separators)
        "\\b\\d{4}[\\s\\-]?\\d{4}[\\s\\-]?\\d{4}[\\s\\-]?\\d{4}\\b"
    ],
    "redact_fields": [
        "Email",
        "Phone",
        "MobilePhone",
        "HomePhone",
        "OtherPhone",
        "AssistantPhone",
        "Fax",
        "MailingStreet",
        "MailingCity",
        "MailingState",
        "MailingPostalCode",
        "MailingAddress",
        "Birthdate"
    ],
    "replacement": "[REDACTED]"
} if {
    input.mode == "output"
    startswith(lower(input.resource.name), "salesforce-")
}
```
