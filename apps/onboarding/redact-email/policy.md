---
name: Email Address Redaction
tags:
  - onboarding
  - pii
  - email
  - dlp
  - redaction
  - egress
publishedAt: 2026-07-23
description: |
  # Hide email addresses in tool responses

  This policy automatically masks email addresses in what a tool sends back,
  replacing each one with `[REDACTED]` before your agent ever sees it. It doesn't
  block anything — the response still comes through, just with the email addresses
  hidden.

  It's the response-side companion to the
  [detect-email-allow](../detect-email-allow/policy.md) and
  [deny-email](../deny-email/policy.md) starters. Use it when the concern is email
  addresses coming *back* from a tool — a customer record, a search result, a chat
  history — and you want your agents to keep working with that data without seeing
  the actual addresses.

  ## What it does

  When a tool returns a response, this policy finds anything that looks like an
  email address anywhere in it and swaps it for `[REDACTED]`. Everything else in
  the response is left exactly as it was, and the response is never blocked.

  ## When to use it

  Turn this on when your tools return data that may contain email addresses and
  you'd like to keep those hidden from your agents while still letting them use
  the rest of the response.

  ## Example

  A tool returns a customer record that includes jane@example.com. Your agent
  receives the same record with the address shown as `[REDACTED]`.
direction: egress
apps:
  - onboarding
industries: []
bundles: []
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package onboarding.egress.redact_email

# Transform-only egress policy — never blocks, redacts email addresses from
# tool responses on the output path.
default allow := true

transform := {
    "redact_patterns": [
        # Email addresses
        "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"
    ],
    "replacement": "[REDACTED]"
} if {
    input.mode == "output"
}
```
