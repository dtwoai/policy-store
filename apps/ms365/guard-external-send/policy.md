---
name: Block Agent Email to External Recipients
tags:
  - ms365
  - guard-external-send
  - ingress
  - email
  - dlp
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # ms365 / guard-external-send

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `ms365.ingress.guard_external_send`

  ## What it does

  Blocks agent-initiated Microsoft 365 email sends when any recipient address falls
  outside a corporate-domain allowlist. On the send-class mail tools (send, reply,
  reply-all, forward, send-draft, shared-mailbox send), the policy extracts every
  recipient it can see in the tool arguments and denies if any address is outside
  the `allowed_domains` set. Callers in the `external-comms` identity group are
  exempt. All non-send tools pass through unchanged.

  The posture on matched tools is strictly fail-closed: if a send-class call carries
  no recipients in its arguments (e.g. `send-draft-message`, or a reply whose
  recipients live server-side on the thread), or a recipient entry has no readable
  `emailAddress.address`, the check cannot run and the call is **denied**, not waved
  through. Malformed addresses (no `@`, multiple `@`, unknown subdomains) are treated
  as external.

  The check runs at ingress, before the call reaches the MCP server — a blocked
  email never leaves the tenant, which matters because sent mail is instantly
  external and unrecallable.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information outside the organization's boundary by stopping agent email to
    non-corporate recipients on the MCP path; **P6.1** — supports limiting personal
    information disclosure to third parties over the agent's email channel.
  - **HIPAA §164.530(c)** — supports privacy safeguards by preventing an agent from
    mailing mailbox content (which routinely contains PHI) to addresses outside the
    covered entity's domains.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing by containing
    agent-driven personal-data egress to approved domains; **Arts. 44/46** — supports
    cross-border transfer discipline for agent-visible flows: an agent cannot mail
    data to arbitrary external (potentially third-country) recipients.

  ## Why ingress and not egress

  Sending email is a write with irreversible external side effects — once Graph
  accepts the `sendMail` action, the message has left the tenant. Egress policies
  could only mask the API response, not the delivery. Ingress denial is the only
  placement that actually prevents the disclosure.

  ## Tool name matching

  The policy matches the softeria `ms-365-mcp-server` send-class mail tools by
  suffix (names verified from a live gateway deployment):

  - `*-send-mail`
  - `*-reply-mail-message`
  - `*-reply-all-mail-message`
  - `*-forward-mail-message`
  - `*-send-draft-message`
  - `*-send-shared-mailbox-mail`

  The DTwo gateway prefixes tool names with the configured MCP server name
  (observed live as `ms365-`), and that prefix is not standardized — matching on
  the suffix keeps the policy portable. Verify the exact names your gateway sends
  with the dump-input debug technique before relying on this in production.

  Draft-creation tools (`*-create-draft-email`, `*-create-reply-draft`,
  `*-create-forward-draft`, `*-create-shared-mailbox-draft`) are deliberately not
  matched: a draft does not leave the tenant until something sends it, and drafts
  are the recommended fallback workflow when this policy denies.

  ## Argument shape

  Two documented recipient shapes are read (both from the live softeria schemas),
  and every hop is read with `object.get` so a missing field can never crash a rule
  open:

  1. `send-mail` (and shared-mailbox send) nest the message under a `Message`
     wrapper, per the Graph `sendMail` action:
     `body.Message.toRecipients[].emailAddress.address` — same shape for
     `ccRecipients` and `bccRecipients`. All three lists are checked.
  2. `forward-mail-message` uses a **top-level** field instead:
     `body.ToRecipients[].emailAddress.address`.

  **Casing is not trusted.** Microsoft Graph binds OData property names
  case-insensitively, so an agent can send `body.Message.BccRecipients` (capital
  B), a lowercase `message` wrapper, or a top-level lowercase `toRecipients` and
  Graph will still deliver the mail. The policy therefore lowercases every wrapper
  key (`message`) and every recipient-list key (`toRecipients` / `ccRecipients` /
  `bccRecipients`) before matching, and gathers recipient lists from **both** the
  top level of `body` and any `message`-style wrapper. This closes the casing trap
  the landscape note warns about: a hidden capital-cased BCC can no longer ride
  alongside a visible internal recipient.

  Both shapes are extracted on every matched tool, so a forward that carries a full
  `body.Message` is also covered. Addresses are compared lowercase against
  `allowed_domains`; the domain match is exact, so subdomains you use must be
  listed explicitly.

  ## Examples

  ### Allowed — all recipients on corporate domains

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-send-mail", "type": "tool" },
      "payload": {
        "name": "ms365-send-mail",
        "args": {
          "body": {
            "Message": {
              "subject": "Q3 numbers",
              "toRecipients": [
                { "emailAddress": { "address": "cfo@example.com" } }
              ]
            }
          }
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
      "resource": { "name": "ms365-send-mail", "type": "tool" },
      "payload": {
        "name": "ms365-send-mail",
        "args": {
          "body": {
            "Message": {
              "toRecipients": [
                { "emailAddress": { "address": "cfo@example.com" } }
              ],
              "bccRecipients": [
                { "emailAddress": { "address": "partner@outside.io" } }
              ]
            }
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "This message addresses recipients outside the approved corporate domains: partner@outside.io. (...)"`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - A `graph-batch` deny policy — `*-graph-batch` can invoke the Graph `sendMail`
    endpoint directly and bypasses every per-tool rule, including this one.
  - `guard-share-links` (PF-05) — email is only one egress lane; anonymous OneDrive/
    SharePoint share links are the other.
  - A mail-rule persistence block on `*-create-mail-rule` / `*-update-mail-rule` —
    a forwarding rule is the classic way to leak mail without ever calling a send
    tool.

  ## Known limitations

  - **Placeholders — replace at import time.** The `allowed_domains` set ships with
    `example.com` / `example.org`; replace it with your organization's real email
    domains (including any subdomains you use — matching is exact). The exemption
    group name `external-comms` is a placeholder — replace it with your IdP's group
    name. The policy reads `input.subject.claims.groups`; a caller with no groups
    claim is simply not exempt (fails closed).
  - **Server-side recipients are invisible.** `send-draft-message` sends by
    `messageId` only, and the reply tools can inherit recipients from the thread —
    in both cases Graph resolves the audience server-side and the gateway never
    sees it. A draft addressed to an external party in the Outlook web UI is not
    visible here. The residual is partly handled with a deny-when-args-absent
    posture: a covered call with **no** argument-visible recipient is denied
    outright, so these tools cannot be used as a *silent* (recipient-free) blind
    external channel, and comment-only replies plus all draft sends are denied for
    non-exempt callers (route those through the `external-comms` group or the
    create-draft + human-send workflow).
  - **Reply / reply-all can still leak to thread externals (accepted residual).**
    The deny-when-args-absent posture does **not** fully close the reply channel.
    Graph's `reply` / `replyAll` actions **add** any argument-supplied recipients
    to the thread's existing audience rather than replacing it, so a non-exempt
    caller who supplies a single *internal* recipient in the `Message` wrapper
    satisfies the check (one visible recipient, none external) and is **allowed** —
    while Graph still delivers the reply to every server-side thread participant,
    including external ones the gateway never sees (see the reply-all decoy test in
    `tests.yaml`). In other words, `reply-mail-message` / `reply-all-mail-message`
    can egress to thread externals even when this policy allows the call; a decoy
    internal recipient is enough. `forward-mail-message` and `send-mail` build a
    fresh message with an argument-visible audience and are fully checked — this
    residual is specific to the two thread-reply tools. Where reply-to-external-
    threads is unacceptable, pair this policy with a human-in-the-loop control on
    reply/reply-all, or deny those two tools outright for non-exempt callers.
  - **Teams egress is out of scope.** `send-chat-message` has no recipient-domain
    argument (audience is a `chatId`), so chat egress to federated tenants cannot
    be checked by this policy. Treat Teams as a separate control surface.
  - **`graph-batch` bypass.** See Composition — pair this policy with a batch deny.
  - **Shared-mailbox send shape assumed.** `send-shared-mailbox-mail` is matched by
    suffix and its arguments are assumed to follow the same capital-M
    `body.Message` shape as `send-mail`; if a deployment nests them differently the
    policy fails closed (no recipients visible → deny) rather than open.
  - **Recipient-key casing is normalized, but wholly undocumented keys are not.**
    The policy matches wrapper and recipient-list keys case-insensitively
    (`message`, `to/cc/bccRecipients`), so capitalization tricks no longer hide a
    recipient. The residual: a recipient list carried under an entirely different
    key that Graph still honours (not one of the `*Recipients` names, not inside a
    `message` wrapper) would be invisible. If such a list is the *only* recipient
    source the call fails closed (no visible recipients → deny); the unclosed edge
    is a hidden list riding alongside a separately-visible internal recipient under
    a truly novel key. The reply / reply-all / shared-mailbox recipient shapes are
    assumed to follow the documented `Message`-wrapper convention (only `send-mail`
    and `forward-mail-message` shapes are landscape-verified).
  - **Name-based matching only.** Generic passthrough servers (e.g. Lokka's single
    `Lokka-Microsoft` tool) do not expose per-action tool names and are not covered.

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are outside
  > the gateway's reach by design. Validate against your own compliance program
  > before relying on it.
direction: ingress
apps:
  - ms365
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package ms365.ingress.guard_external_send

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Configuration ------------------------------------------------------------

# Corporate domains recipients may belong to. PLACEHOLDERS — replace with your
# organization's real email domains at import time. Matching is exact and
# lowercase; subdomains you use must be listed explicitly.
allowed_domains := {
    "example.com",
    "example.org",
}

# IdP group whose members may email external recipients. PLACEHOLDER — replace
# with your IdP's group name at import time.
exempt_group := "external-comms"

# --- Tool matching --------------------------------------------------------------

# Send-class mail tools (softeria ms-365-mcp-server names, verified from a live
# gateway deployment). The gateway prefixes tool names with the configured MCP
# server name (e.g. `ms365-`), so match by suffix to stay portable.
send_tool_suffixes := [
    "-send-mail",
    "-reply-mail-message",
    "-reply-all-mail-message",
    "-forward-mail-message",
    "-send-draft-message",
    "-send-shared-mailbox-mail",
]

is_send_tool if {
    some suffix in send_tool_suffixes
    endswith(lower(input.resource.name), suffix)
}

# --- Recipient extraction --------------------------------------------------------

# Every hop uses object.get so a missing field yields an empty default instead of
# silently killing an allow rule — missing data must end in deny, not crash-open.
request_args := object.get(object.get(input, "payload", {}), "args", {})

# request_body must be an object; anything else (string, array, missing) collapses
# to {} so the key iteration below never crashes and simply surfaces no recipients
# — which fails closed on a send-class tool.
request_body := body if {
    body := object.get(request_args, "body", {})
    is_object(body)
}

request_body := {} if {
    not is_object(object.get(request_args, "body", {}))
}

# Recipient-list field names, compared lowercase. Microsoft Graph binds OData
# property names case-insensitively, so we must NOT trust the exact casing an
# agent sends: `body.Message.BccRecipients` (capital B) still delivers a BCC even
# though the documented shape is `bccRecipients`. The landscape note flags this
# Message/ToRecipients-vs-toRecipients casing trap explicitly — Rego must handle
# every casing, not just the two documented spellings.
recipient_field_names := {"torecipients", "ccrecipients", "bccrecipients"}

# Recipient lists appear either at the top level of `body` (forward-mail-message's
# `ToRecipients`) or nested inside a `Message`/`message` wrapper (send-mail, reply,
# reply-all, shared-mailbox send — the Graph sendMail/reply action shapes). Both
# the wrapper key and the field keys are matched case-insensitively so a
# capitalization trick (`BccRecipients`, a lowercase `message` wrapper, a
# top-level `toRecipients`, etc.) cannot smuggle a hidden external recipient past
# the check while a visible internal recipient keeps the send allowed.
top_level_entries := [entry |
    some key, val in request_body
    lower(key) in recipient_field_names
    is_array(val)
    some entry in val
]

message_wrappers := [val |
    some key, val in request_body
    lower(key) == "message"
    is_object(val)
]

nested_entries := [entry |
    some wrapper in message_wrappers
    some key, val in wrapper
    lower(key) in recipient_field_names
    is_array(val)
    some entry in val
]

recipient_entries := array.concat(top_level_entries, nested_entries)

# A recipient entry is readable only when emailAddress.address is a non-empty
# string; anything else (missing key, wrong type) makes the entry unreadable and
# the request denied below.
readable_address(entry) := addr if {
    is_object(entry)
    addr := lower(object.get(object.get(entry, "emailAddress", {}), "address", ""))
    addr != ""
}

recipient_addresses := {addr |
    some entry in recipient_entries
    addr := readable_address(entry)
}

some_recipient_unreadable if {
    some entry in recipient_entries
    not readable_address(entry)
}

# The domain must match an allowlisted domain exactly. Malformed addresses (no
# `@`, more than one `@`, empty domain) never satisfy this and count as external.
domain_allowed(addr) if {
    parts := split(addr, "@")
    count(parts) == 2
    parts[1] in allowed_domains
}

external_recipients := {addr |
    some addr in recipient_addresses
    not domain_allowed(addr)
}

# --- Identity exemption --------------------------------------------------------

# Missing subject / claims / groups all fail closed: no groups claim, not exempt.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

exempt_caller if {
    some group in caller_groups
    lower(group) == exempt_group
}

# --- Allow rules ----------------------------------------------------------------

# Any tool that is not a send-class mail tool passes through unchanged.
allow if {
    not is_send_tool
}

# Members of the exemption group may email anyone.
allow if {
    is_send_tool
    exempt_caller
}

# Send-class calls are allowed only when at least one recipient is visible in the
# arguments, every recipient entry is readable, and none is external.
allow if {
    is_send_tool
    count(recipient_entries) > 0
    not some_recipient_unreadable
    count(external_recipients) == 0
}

# --- Deny reasons ----------------------------------------------------------------

reasons contains msg if {
    is_send_tool
    not exempt_caller
    count(external_recipients) > 0
    msg := sprintf(
        "This message addresses recipients outside the approved corporate domains: %s. Remove the external addresses or save a draft for a human to review and send. Contact your InfoSec team if an external domain should be approved.",
        [concat(", ", sort([addr | some addr in external_recipients]))],
    )
}

reasons contains "No recipient addresses are visible in this request, so the corporate-domain check cannot run and the send is blocked. Include explicit recipients in the call, or create a draft and let a human send it from Outlook. Contact your InfoSec team if this blocks a legitimate workflow." if {
    is_send_tool
    not exempt_caller
    count(recipient_entries) == 0
}

reasons contains "A recipient in this request is missing a readable email address, so the corporate-domain check cannot run and the send is blocked. Provide every recipient as emailAddress.address, or create a draft for human review. Contact your InfoSec team if this was a false positive." if {
    is_send_tool
    not exempt_caller
    some_recipient_unreadable
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
