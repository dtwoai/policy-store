---
name: Deny Email PII
tags:
  - onboarding
  - pii
  - email
  - dlp
  - ingress
publishedAt: 2026-07-23
description: |
  # Block requests that contain email addresses

  This policy stops a request if it contains an email address. If there's no
  email address, the request goes through as normal.

  It's the stricter sibling of the watch-only
  [detect-email-allow](../detect-email-allow/policy.md) starter. Reach for it when
  you don't just want to know that an email address showed up — you want to make
  sure it never reaches the tool your agent is calling.

  ## What it does

  Before a request reaches the tool, this policy checks it for anything that looks
  like an email address. If it finds one, the request is blocked and the agent is
  told why: `Blocked: an email address (PII) was detected in the request.`
  Requests with no email address are allowed through untouched.

  The block happens before the request reaches any external systems, so the email
  address never reaches the tool and nothing — a message, a ticket, a record — is
  ever created with it.

  ## When to use it

  Turn this on when email addresses simply shouldn't be sent to your tools, and
  you'd rather stop those requests than just watch them.

  ## Example

  An agent tries to send "forward this to jane@example.com". The request is
  blocked and the agent sees the reason above. A request with no email address is
  allowed to continue.
direction: ingress
apps:
  - onboarding
industries: []
bundles: []
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package onboarding.ingress.deny_email

# Deny-on-match policy — blocks any tool call whose arguments contain an email
# address, and allows everything else.
default allow := false

# Matches an email address embedded anywhere in a string value.
email_pattern := `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`

# Allow the call through as long as no email is present in the arguments.
allow if {
    not email_detected
}

# True when any (possibly nested) string value in the request args contains an email.
email_detected if {
    input.mode == "input"
    walk(object.get(input.payload, "args", {}), [_, value])
    is_string(value)
    regex.match(email_pattern, value)
}

reason := "Blocked: an email address (PII) was detected in the request." if {
    email_detected
}
```
