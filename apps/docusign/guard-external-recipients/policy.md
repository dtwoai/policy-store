---
name: Guard Docusign External Recipients
tags:
  - docusign
  - guard-external-send
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # docusign / guard-external-recipients

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `docusign.ingress.guard_external_recipients`

  ## What it does

  Blocks Docusign envelope-creation and recipient-update tool calls when any
  recipient email address has a domain outside the configured counterparty
  allowlist. The denial reason names each offending address so the caller can
  correct the routing.

  This stops two failure modes at once:

  - **Accidental mis-sends** — an agent routing a contract to the wrong party
    (typo'd domain, hallucinated address, stale contact).
  - **Recipient-injection exfiltration** — the "add my personal address as a
    signer" pattern, where a compromised or prompt-injected agent adds an
    attacker-controlled recipient to an envelope. Every Docusign recipient
    (signer, carbon copy, agent, editor) receives the envelope contents, so an
    added recipient is a full copy of the documents.

  Docusign envelopes are PII by construction (names, emails, addresses,
  signatures) and frequently carry financial terms or PHI, so restricting who
  can be routed a copy is a transmission-boundary control. The check runs at
  ingress, before the call reaches the Docusign MCP server, so a blocked
  envelope is never created or re-routed and no email ever goes out.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    confidential information by confining envelope routing to approved
    counterparty domains on the agent channel; **P6.1** — supports limiting
    personal-information disclosure to authorized third parties.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing:
    contract PII cannot be routed to unapproved recipients over the agent
    path; **Arts. 44/46** — supports cross-border-transfer duties by making
    the recipient-domain allowlist an explicit, auditable transfer boundary
    for agent-visible flows.
  - **HIPAA §164.530(c)** — supports privacy safeguards on the agent path for
    envelopes that carry PHI (healthcare consent forms, HR/benefits
    paperwork).

  ## Why ingress and not egress

  Creating or re-routing an envelope is a write with external side effects —
  `createEnvelope` with `status: "sent"` emails real recipients a signature
  request in Docusign's name, and `updateEnvelopeRecipients` can hand a
  pending envelope to a new party. Egress inspection would run after the
  damage is done. Ingress denial is the only placement that actually prevents
  the disclosure.

  ## Tool name matching

  The policy matches, case-insensitively and by substring (the DTwo gateway
  prefixes tool names with the configured MCP server name, e.g.
  `docusign-createEnvelope`, and that prefix is not standardized):

  - `*createEnvelope*` — official Docusign MCP server (verified in the
    official tool catalog)
  - `*updateEnvelopeRecipients*` — official Docusign MCP server (verified)
  - `*create_envelope_from_*` — community luthersystems server:
    `create_envelope_from_template` and `create_envelope_from_documents`
    (verified from source)

  Verify the exact names your gateway sends using the dump-input debug
  technique before relying on this in production, and add extra
  `is_recipient_write_tool` rules if your Docusign MCP server exposes
  different names.

  ## Argument shape

  Recipient emails are collected from every shape the known servers use:

  1. `recipients.<anyRecipientType>[].email` — official `createEnvelope`
     (mirrors eSignature Envelopes:create). The policy iterates **every**
     array under `recipients`, so `signers`, `carbonCopies`, `agents`,
     `editors`, `certifiedDeliveries`, etc. are all checked — a CC is a full
     copy of the envelope.
  2. `compositeTemplates[].inlineTemplates[].recipients.<anyType>[].email` —
     official `createEnvelope` composite path. Same per-array sweep as (1),
     applied inside each inline template, so an external signer/CC cannot be
     smuggled in through a composite template.
  3. **Every array at the top level of `args`** — this is how
     `updateEnvelopeRecipients` ships recipients (EnvelopeRecipients:update
     places `signers`, `carbonCopies`, `agents`, `editors`,
     `certifiedDeliveries`, ... directly in the body, *not* under a
     `recipients` wrapper), so all recipient types on the reroute path are
     checked — not just signers. This generic sweep also subsumes official
     `templateRoles[]`, community `role_assignments[]`, and the flat
     `signers[]` net for community `create_envelope_from_documents` (schema
     unverified). Only recipient objects carry an `email` field, so
     document/tab arrays are skipped harmlessly.

  An email that does not parse as `local@domain` (missing or repeated `@`)
  fails closed and is reported as offending. Domain comparison is
  case-insensitive and exact — subdomains must be listed explicitly.

  A matched tool call with **no** recipient emails at all (e.g. a draft
  created with documents only) is allowed: with no recipients there is no
  transmission to guard.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "docusign-createEnvelope", "type": "tool" },
      "payload": {
        "name": "docusign-createEnvelope",
        "args": {
          "emailSubject": "MSA for signature",
          "status": "sent",
          "recipients": {
            "signers": [{ "email": "legal@approved-counterparty.com", "name": "Ada", "routingOrder": "1" }]
          }
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "docusign-updateEnvelopeRecipients", "type": "tool" },
      "payload": {
        "name": "docusign-updateEnvelopeRecipients",
        "args": {
          "envelopeId": "0aa1b2c3",
          "signers": [{ "email": "me.personal@gmail.com", "name": "Me", "recipientId": "2" }]
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Docusign recipient 'me.personal@gmail.com' has a domain outside the approved counterparty allowlist. (...)"`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - `apps/docusign/force-draft-envelopes` — an ingress transform that rewrites
    `status: "sent"` to `"created"` so agents can prepare envelopes but only
    authorized humans dispatch them; together the two policies mean an agent
    can neither send nor mis-route.
  - An ingress deny on `updateEnvelope` voiding (irreversible) and an egress
    redaction policy on `listRecipients` / `getAgreementDetails` tab values
    for the read path.

  ## Known limitations

  - **The counterparty domain allowlist is a placeholder.** Replace
    `yourcompany.com` / `approved-counterparty.com` in `counterparty_domains`
    with your own corporate domain(s) plus your approved counterparty domains
    at import time. An empty or stale list will deny every envelope with
    recipients.
  - **Exact domain match.** `mail.yourcompany.com` does not match
    `yourcompany.com` — list every subdomain you route to.
  - **Official-server argument shapes are documented REST body shapes, not an
    MCP schema dump.** The landscape research notes Docusign does not publish
    per-tool JSON schemas; verify against a live `tools/list` before relying
    on exact field names.
  - **Community `create_envelope_from_documents` recipient shape is
    unverified.** It is covered best-effort via the flat `signers[]` path; if
    that server nests recipients differently, extend `recipient_emails`.
  - **Recipient extraction is shape-bound (fail-open on unknown nesting).**
    Emails are read from only three places: `args.recipients.<type>[].email`,
    `args.compositeTemplates[].inlineTemplates[].recipients.<type>[].email`,
    and arrays at the **top level** of `args`. Two shapes therefore slip
    through and are **allowed**: (a) a server that wraps the envelope
    definition one level deeper (e.g. `args.envelopeDefinition.recipients` or
    `args.body.signers[]`), and (b) a recipient expressed as a bare string
    rather than an object carrying an `email` field (e.g.
    `signers: ["x@evil.com"]`). This matches the verified official and
    luthersystems shapes, which place recipients where the sweeps look and use
    objects with an `email` field; the extraction is deliberately not a
    recursive deep-walk so it cannot over-deny non-recipient arrays or reach
    the intentionally-excluded `emailSettings.bccEmailAddresses` residual
    above. If your gateway's `tools/list` shows a wrapped body or a
    string-array recipient shape, extend `args_obj` / `recipient_emails` to
    reach it.
  - **Recipients only.** Emails embedded elsewhere — `emailBlurb` text,
    workflow `triggerWorkflow` inputs, tab values — are not inspected here;
    keep this policy focused and add companions for those surfaces. One
    recipient-adjacent residual is **not** covered: `emailSettings.bccEmailAddresses[].email`
    (a silent BCC-archive copy on `createEnvelope`) is nested under an object
    rather than an array under `args`/`recipients`, so the sweeps above do not
    reach it. If your account uses BCC email archiving over the agent path,
    add a dedicated extraction rule for it once you have verified the field
    against a live `tools/list`.
  - **No identity-based exemptions.** All callers are subject to the same
    allowlist. If you need a contract-ops break-glass group, add a separate
    `allow if` branch gated on `input.subject.claims.groups`.
  - Docusign's web UI, PowerForms, and native API are outside the gateway's
    reach; this control applies to the MCP path only.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - docusign
industries: []
bundles:
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package docusign.ingress.guard_external_recipients

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# PLACEHOLDER — replace at import time with your own corporate domain(s) plus
# the counterparty domains approved for e-signature routing. Comparison is
# case-insensitive and exact (subdomains must be listed explicitly).
counterparty_domains := {
    "yourcompany.com",
    "approved-counterparty.com",
}

# --- Tool matching ------------------------------------------------------------
# The gateway prefixes tool names with the configured MCP server name
# (e.g. `docusign-createEnvelope`), and community servers use snake_case, so
# match case-insensitively by substring to stay portable. Verify the exact
# names on your gateway with the dump-input debug technique before relying on
# this in production.

# Official Docusign MCP server: createEnvelope
is_recipient_write_tool if {
    contains(lower(input.resource.name), "createenvelope")
}

# Community (luthersystems): create_envelope_from_template / create_envelope_from_documents
is_recipient_write_tool if {
    contains(lower(input.resource.name), "create_envelope_from_")
}

# Official Docusign MCP server: updateEnvelopeRecipients
is_recipient_write_tool if {
    contains(lower(input.resource.name), "updateenveloperecipients")
}

# --- Recipient email extraction -------------------------------------------------

args_obj := object.get(input, ["payload", "args"], {})

# 1. Official createEnvelope: every array under the `recipients` object — signers,
# carbonCopies, agents, editors, certifiedDeliveries, ... Every recipient type
# receives the envelope contents, so all of them are transmission boundaries.
recipient_emails contains email if {
    recipients := object.get(args_obj, "recipients", {})
    some entry_list in recipients
    is_array(entry_list)
    some entry in entry_list
    email := object.get(entry, "email", "")
    email != ""
}

# 2. Composite/inline template path (official Envelopes:create composite shape):
# compositeTemplates[].inlineTemplates[].recipients.<anyType>[].email. Without this
# rule an agent can smuggle an external signer/CC through the composite path and
# bypass the top-level `recipients` check entirely.
recipient_emails contains email if {
    some composite in object.get(args_obj, "compositeTemplates", [])
    some inline in object.get(composite, "inlineTemplates", [])
    recipients := object.get(inline, "recipients", {})
    some entry_list in recipients
    is_array(entry_list)
    some entry in entry_list
    email := object.get(entry, "email", "")
    email != ""
}

# 3. Flat recipient-type arrays at the TOP LEVEL of args. The EnvelopeRecipients:update
# body (updateEnvelopeRecipients) places signers, carbonCopies, agents, editors,
# certifiedDeliveries, ... directly in the request body — not nested under `recipients` —
# so a CC/agent/editor added there is a full copy of the envelope just like a signer.
# This generic sweep also covers official `templateRoles[]`, community
# `role_assignments[]`, and the flat `signers[]` net for community
# create_envelope_from_documents (its exact schema is unverified). Only recipient
# objects carry an `email` field, so document/tab arrays are skipped harmlessly.
recipient_emails contains email if {
    some entry_list in args_obj
    is_array(entry_list)
    some entry in entry_list
    email := object.get(entry, "email", "")
    email != ""
}

# --- Domain allowlist check -----------------------------------------------------

# An address passes only when it parses as exactly local@domain and the domain
# is on the allowlist. Anything else (no @, repeated @, unknown domain) fails
# closed and is reported as an offending address.
email_domain_allowed(email) if {
    parts := split(lower(trim_space(email)), "@")
    count(parts) == 2
    counterparty_domains[parts[1]]
}

offending_emails contains email if {
    some email in recipient_emails
    not email_domain_allowed(email)
}

# --- Decision -------------------------------------------------------------------

# Any tool other than the Docusign recipient-writing tools passes through.
allow if {
    not is_recipient_write_tool
}

# Recipient-writing calls are allowed only when every recipient email is on an
# approved counterparty domain. A call carrying no recipient emails at all
# (e.g. a documents-only draft) has nothing to transmit and is allowed.
allow if {
    is_recipient_write_tool
    count(offending_emails) == 0
}

reasons contains msg if {
    is_recipient_write_tool
    some email in offending_emails
    msg := sprintf("Docusign recipient '%s' has a domain outside the approved counterparty allowlist. Remove this recipient or use an address at an approved counterparty domain. If this is a legitimate counterparty, ask your compliance team to add its domain to the allowlist.", [email])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
