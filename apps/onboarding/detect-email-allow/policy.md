---
name: Email Address Alert
tags:
  - onboarding
  - pii
  - email
  - observability
  - ingress
publishedAt: 2026-07-23
description: |
  # Detect email addresses (allow, with a note)

  A watch-only starter policy. It looks for email addresses in what your agents
  send, and whenever it spots one it lets the request through but tags the
  decision with the note `Email Detected`. It never blocks anything.

  This is a great first policy to turn on. You don't have to write any code to get
  value from it — attach it to a gateway and you'll start seeing real policy
  activity in your dashboard, so you can watch how often email addresses come up
  before deciding whether you want to do anything stricter.

  ## What it does

  Each time an agent calls a tool, this policy checks the request for anything
  that looks like an email address. If it finds one, the request still goes
  through, but the decision is labelled `Email Detected` so it stands out in your
  policy activity. If there's no email address, the request passes with no note.

  Because it only watches and never blocks, it's safe to run from day one. When
  you're ready to actually act on email addresses, pair it with the companion
  policies that [block](../deny-email/policy.md) them or
  [hide](../redact-email/policy.md) them.

  ## When to use it

  Turn this on when you want visibility — to see whether, and how often, email
  addresses show up in your agents' activity — without changing what your agents
  are allowed to do.

  ## Example

  An agent tries to post the message "ping jane@example.com about the invoice".
  The request is allowed to continue, and the decision is tagged `Email Detected`
  so you can find it in your dashboard. A message with no email address is allowed
  with no note.
direction: ingress
apps:
  - onboarding
industries: []
bundles: []
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package onboarding.ingress.detect_email_allow

# Passive observability policy — always allows, but attaches an "Email Detected"
# reason when an email address appears anywhere in the request arguments.
default allow := true

# Matches an email address embedded anywhere in a string value.
email_pattern := `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`

# True when any (possibly nested) string value in the request args contains an email.
email_detected if {
    input.mode == "input"
    walk(object.get(input.payload, "args", {}), [_, value])
    is_string(value)
    regex.match(email_pattern, value)
}

# Allow-with-reason: the call is permitted, but the decision carries this reason
# so the detection is visible in the policy observability views.
reason := "Email Detected" if {
    email_detected
}
```
