---
name: Deny Agent Email Sends to External Recipients
tags:
  - gmail
  - guard-external-send
  - ingress
  - email
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # gmail / guard-external-send

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `gmail.ingress.guard_external_send`

  ## What it does

  Denies Gmail send-class tool calls when any recipient in `to`, `cc`, or `bcc`
  falls outside a documented corporate-domain allowlist. A denied agent is told
  to create a draft in Gmail instead, so a human reviews and sends the message —
  the same posture the official Google/Claude Gmail connector enforces by
  design (it ships no send tool at all).

  The check is fail-closed: a send whose recipients are missing, empty, or in a
  shape the policy cannot parse is denied. Callers in a documented IdP group
  (placeholder: `mcp-gmail-external-send`) are exempt; a caller with no claims
  is never exempt.

  Sending email is externally visible and unrecallable, so this must be an
  ingress policy — once the call reaches the Gmail MCP server, the message has
  left the organization. Draft creation (`create_draft`, `draft_email`,
  `draft_gmail_message`) passes through untouched as the sanctioned path.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information outside the boundary: agent-driven mail to non-corporate
    domains is stopped before it leaves; **P6.1** — supports limits on personal
    information disclosure to third parties over the agent's email path.
  - **HIPAA §164.530(c)** — supports privacy safeguards by preventing an agent
    from mailing PHI-bearing content to addresses outside the covered entity's
    domains.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing on the
    agent's outbound-mail path; **Arts. 44/46** — supports control over
    agent-visible cross-border transfers by pinning recipients to reviewed
    corporate domains.

  ## Tool name matching

  The policy matches send-class tools case-insensitively by suffix on the
  tool name — read from **both** the PARC `input.resource.name` and the
  still-populated legacy `input.payload.name` alias, so a send is caught if
  either field carries the suffix (they hold the same value on
  `tool_pre_invoke`; checking both means a call with `resource.name` absent
  still fails closed rather than slipping through as a non-send):

  - `*send_email` — GongRzhe/Gmail-MCP-Server ("Gmail AutoAuth MCP")
  - `*send_gmail_message` — taylorwilsdon/google_workspace_mcp

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `gmail-mcp-send_email`), and that prefix is not standardized —
  matching on the suffix keeps the policy portable. Verify the exact name your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  The official Google remote Gmail MCP server (the Claude Gmail connector
  surface) deliberately exposes **no send tool** — drafts must be sent by a
  human from Gmail — so nothing on that server matches this policy, and its
  `create_draft` tool passes untouched. Community draft tools (`draft_email`,
  `draft_gmail_message`) likewise do not match the send suffixes and pass.

  ## Argument shape

  Recipients are read from the `to`, `cc`, and `bcc` argument keys with
  `object.get`, handling both shapes seen in the wild:

  - **arrays of address strings** (GongRzhe `send_email`),
  - **single strings**, including comma- or semicolon-separated lists
    (taylorwilsdon `send_gmail_message`).

  Each entry may be a bare address (`user@example.com`) or a display-name form
  (`Name <user@example.com>`). Parsing is deliberately conservative: an entry
  must contain exactly one `@` to yield a domain — entries with zero or
  multiple `@` signs (including several addresses smuggled into one entry)
  fail to parse and the send is **denied**, not skipped. A recipient field
  that is present but neither a string nor an array also denies the call.

  The domain allowlist ships with **placeholder** values (`example.com`,
  `example.org`) — replace them with your organization's domains at import
  time.

  ## Examples

  ### Allowed — internal recipients only

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-mcp-send_email", "type": "tool" },
      "payload": {
        "name": "gmail-mcp-send_email",
        "args": {
          "to": ["alice@example.com"],
          "cc": ["bob@example.com"],
          "subject": "Q3 draft",
          "body": "..."
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — external recipient in bcc

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-mcp-send_email", "type": "tool" },
      "payload": {
        "name": "gmail-mcp-send_email",
        "args": {
          "to": ["alice@example.com"],
          "bcc": ["competitor@evil.example.net"],
          "subject": "Q3 draft",
          "body": "..."
        }
      }
    }
  }
  ```

  `allow = false`, reason instructs the agent to create a Gmail draft for
  human review instead.

  ## Composition

  This policy is single-purpose. Useful companions:

  - A transform policy that strips `bcc` and the `from_name` / `from_email`
    send-as alias arguments from send and draft tools — no hidden recipients,
    no display-name impersonation.
  - `guard-mailbox-persistence` (PF-17) denying Gmail filter creation — this
    policy stops direct external sends, but a mail filter with an
    auto-forward action is an equivalent exfiltration path that outlives the
    session.
  - A `default-deny-unknown-tools` (PF-28) allowlist policy, so a send tool
    with an unanticipated name cannot slip past suffix matching.
  - An AI-sender disclosure policy (PF-19) for the sends that are allowed.

  ## Known limitations

  - **Send-as spoofing and forwarding are not covered.**
    `send_gmail_message` also accepts `from_name` / `from_email` (send-as
    alias — spoofable display identity) and `forward_message_id` (which pulls
    a prior message's content and attachments into the send). This policy only
    inspects recipient domains; strip/deny those arguments with a companion
    policy (see Composition).
  - **Official-server draft field names are unverified.** Google's published
    reference does not include parameter schemas for `create_draft`; this
    policy does not inspect draft arguments at all, so nothing breaks, but
    companion policies that do inspect drafts must verify field names first.
  - **Placeholders.** The domain allowlist entries (`example.com`,
    `example.org`) and the exemption group name (`mcp-gmail-external-send`)
    are placeholders — replace them with your corporate domains and your
    IdP's group name at import time.
  - **Suffix matching only covers known vocabularies.** A Gmail MCP server
    exposing a differently named send tool (or a raw-API escape hatch) will
    not match; pair with a PF-28 allowlist policy for deny-by-default
    coverage.
  - **Display names containing commas or semicolons cause a false-positive
    deny.** In the string-shaped recipient form the policy splits on `,` and
    `;` to separate addresses, so a legitimate internal recipient written as
    `"Doe, Alice <alice@example.com>"` is split into `"Doe"` and
    `" Alice <alice@example.com>"`; the `"Doe"` fragment has no parseable
    domain, so the send is denied. This is fail-closed (over-deny, never
    over-allow): a comma/semicolon can never hide an external address, because
    any unparseable fragment is itself treated as external. Send such
    recipients as separate array entries, or drop the display name, to avoid
    the false positive. Note the array-shaped form is **not** comma-split — a
    single array entry smuggling two addresses (`"a@example.com,b@evil.com"`)
    parses as two `@` signs and is denied as unverifiable, not silently
    accepted.

  > **Compliance note.** This policy supports alignment with the cited
  > framework controls **on the MCP path only**. No policy or bundle makes an
  > organization compliant with any framework; web-UI, native-API, and in-app
  > access are outside the gateway's reach by design. Validate against your
  > own compliance program before relying on it.
direction: ingress
apps:
  - gmail
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gmail.ingress.guard_external_send

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Corporate email domain allowlist — PLACEHOLDER values. Replace with your
# organization's sending domains at import time.
allowed_domains := {
    "example.com",
    "example.org",
}

# IdP group whose members may send external email through the agent.
# PLACEHOLDER — replace with your IdP's group name at import time.
exempt_group := "mcp-gmail-external-send"

# Recipient argument keys used by the community Gmail MCP servers.
recipient_fields := ["to", "cc", "bcc"]

# Tool arguments, defaulting safely when payload/args are missing entirely.
args := object.get(object.get(input, "payload", {}), "args", {})

# Tool-name candidates: the PARC resource.name plus the (deprecated but still
# populated on tool hooks) payload.name alias. Both are read with object.get and
# a send is matched if EITHER carries a send suffix. Keying only on
# input.resource.name would fail OPEN for a send whose resource.name is absent —
# is_send_tool would be undefined and `allow if not is_send_tool` would permit
# the send. Checking both fields (they carry the same value on tool_pre_invoke)
# closes that gap at zero cost to legitimate traffic.
tool_names contains lower(name) if {
    name := object.get(object.get(input, "resource", {}), "name", "")
    name != ""
}

tool_names contains lower(name) if {
    name := object.get(object.get(input, "payload", {}), "name", "")
    name != ""
}

# Send-class Gmail tools, matched case-insensitively by suffix so the
# gateway's configured server-name prefix doesn't matter:
#   *send_email          — GongRzhe/Gmail-MCP-Server
#   *send_gmail_message  — taylorwilsdon/google_workspace_mcp
# The official Google/Claude Gmail connector has no send tool by design, so
# its create_draft (and the community draft_email / draft_gmail_message)
# pass through untouched as the sanctioned human-review path.
is_send_tool if {
    some name in tool_names
    endswith(name, "send_email")
}

is_send_tool if {
    some name in tool_names
    endswith(name, "send_gmail_message")
}

# Allow anything that is not a Gmail send tool (drafts, reads, labels, ...).
allow if {
    not is_send_tool
}

# Exempt callers in the documented IdP group. Missing subject, claims, or
# groups means no exemption — the grant fails closed.
caller_exempt if {
    subject := object.get(input, "subject", {})
    claims := object.get(subject, "claims", {})
    groups := object.get(claims, "groups", [])
    some group in groups
    group == exempt_group
}

allow if {
    is_send_tool
    caller_exempt
}

# Allow a send only when no recipient field is malformed, at least one
# recipient was parsed, and every recipient resolves to an allowlisted
# domain. Anything less fails closed to deny.
allow if {
    is_send_tool
    not malformed_recipient_field
    count(recipients) > 0
    every recipient in recipients {
        is_internal(recipient)
    }
}

# --- Recipient extraction ---

# Array shape (GongRzhe send_email): to/cc/bcc are arrays of entries.
recipients contains recipient if {
    some field in recipient_fields
    value := object.get(args, field, [])
    is_array(value)
    some recipient in value
}

# String shape (taylorwilsdon send_gmail_message and others): a single
# address or a comma/semicolon-separated list.
recipients contains recipient if {
    some field in recipient_fields
    value := object.get(args, field, "")
    is_string(value)
    some part in regex.split(`[,;]`, value)
    recipient := trim_space(part)
    recipient != ""
}

# A recipient field that is present but neither a string nor an array cannot
# be checked — treat the whole call as unverifiable (fail closed).
malformed_recipient_field if {
    some field in recipient_fields
    value := object.get(args, field, null)
    value != null
    not is_string(value)
    not is_array(value)
}

# Extract the domain of one recipient entry. Deliberately conservative: the
# entry must contain exactly one "@" — entries with zero or multiple "@"
# signs (e.g. several addresses smuggled into one entry) yield no domain,
# so is_internal fails and the send is denied.
recipient_domain(recipient) := domain if {
    is_string(recipient)
    parts := split(lower(trim_space(recipient)), "@")
    count(parts) == 2
    # Strip the closing bracket (and stray spaces) of a "Name <user@domain>" form.
    domain := trim(parts[1], "> ")
}

is_internal(recipient) if {
    allowed_domains[recipient_domain(recipient)]
}

has_external_recipient if {
    some recipient in recipients
    not is_internal(recipient)
}

recipients_unverifiable if {
    count(recipients) == 0
}

recipients_unverifiable if {
    malformed_recipient_field
}

reasons contains "One or more recipients (to, cc, or bcc) are outside the corporate email domain allowlist or could not be parsed. Do not send this email; create a Gmail draft instead so a human can review and send it. If every recipient should be internal, ask your InfoSec team to add the domain to the allowlist." if {
    is_send_tool
    not caller_exempt
    has_external_recipient
}

reasons contains "This send call has no recipients the policy can verify: to, cc, and bcc are missing, empty, or in an unrecognized format. Create a Gmail draft instead so a human can review and send it. If this is a false positive, contact your InfoSec team." if {
    is_send_tool
    not caller_exempt
    recipients_unverifiable
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
