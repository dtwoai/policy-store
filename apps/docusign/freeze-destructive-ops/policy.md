---
name: Block Irreversible Docusign Void and Workflow Kills
tags:
  - docusign
  - freeze-destructive-ops
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # docusign / freeze-destructive-ops

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `docusign.ingress.freeze_destructive_ops`

  ## What it does

  Denies the irreversible destructive operations on the Docusign agent path:

  - **`updateEnvelope` void attempts** — any call whose body carries `status: "voided"`, or that carries a `voidedReason` field at all (that field only exists on void requests, so its presence signals void intent even when the `status` key is missing or obfuscated). Voiding a sent envelope permanently invalidates a legally significant signed record. Non-void `updateEnvelope` calls (sending a draft, editing the email subject or blurb) pass through.
  - **`cancelWorkflowInstance`** — kills a running Maestro workflow instance. Denied outright.
  - **`pauseNewWorkflowInstances`** — suspends a workflow for the whole account. The blast radius is far beyond any single agent task. Denied outright.

  Callers whose `input.subject.claims.groups` include `contract-ops` are exempt from all three blocks, so a designated remediation team can still void an erroneous envelope or stop a runaway workflow through the agent path. Everyone else — including callers with no identity claims at all — is denied (the exemption fails closed).

  All other tool calls, on Docusign or any other server behind the same gateway, pass through unchanged.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports integrity of stored records: signed envelopes and running workflow state survive agent error or prompt injection. A voided envelope is a destroyed record of an executed agreement, and a killed or account-wide-paused workflow disrupts the state that keeps those records accurate; blocking agent-initiated voids and workflow kills keeps them intact on the MCP path.

  ## Why ingress and not egress

  Voiding an envelope and killing a workflow instance are irreversible server-side state changes. Once the call reaches Docusign the record is invalidated and counterparties may already have been notified. Egress inspection would only see the confirmation; ingress denial is the only placement that actually prevents the destruction.

  ## Tool name matching

  The policy matches tool names by suffix, case-insensitively, on `input.resource.name`:

  - `*updateenvelope` — the official server's `updateEnvelope` (Envelopes:update). Suffix matching deliberately does **not** catch `updateEnvelopeRecipients`, which is a different tool with a different risk profile (see Composition).
  - `*cancelworkflowinstance` — the official server's `cancelWorkflowInstance`.
  - `*pausenewworkflowinstances` — the official server's `pauseNewWorkflowInstances`.

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g. `docusign-updateEnvelope` for a server named `docusign`), and that prefix is not standardized, so the policy matches suffixes to stay portable. Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  These names come from the official Docusign MCP Server catalog (camelCase, verified against the developer docs as of 2026-02). The community `luthersystems/mcp-server-docusign` server exposes no void or workflow tools, so it has no surface for this policy to guard.

  ## Argument shape

  `updateEnvelope` mirrors the eSignature Envelopes:update REST body: `envelopeId` plus body fields such as `status` (`"voided"` to void, `"sent"` to send a draft), `voidedReason`, `emailSubject`, `emailBlurb`. The policy anchors on two signals, both matched case-insensitively against the **top-level keys** of `input.payload.args`:

  1. a `status` key whose value (trimmed, lowercased) is `voided`;
  2. the presence of a `voidedReason` key with any value, including empty — a legitimate void requires a non-empty `voidedReason`, so a request carrying that key is a void attempt regardless of what the `status` field says.

  The workflow tools are denied by name alone; their arguments are not inspected.

  ## Examples

  ### Allowed — sending a draft envelope

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "docusign-updateEnvelope", "type": "tool" },
      "payload": {
        "name": "docusign-updateEnvelope",
        "args": { "envelopeId": "abc-123", "status": "sent" }
      }
    }
  }
  ```

  `allow = true`, no reason — not a void attempt.

  ### Denied — voiding a sent envelope

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "docusign-updateEnvelope", "type": "tool" },
      "payload": {
        "name": "docusign-updateEnvelope",
        "args": { "envelopeId": "abc-123", "status": "voided", "voidedReason": "sent to wrong signer" }
      },
      "subject": { "sub": "auth0|agent", "claims": { "groups": ["engineering"] } }
    }
  }
  ```

  `allow = false`, `reason = "Voiding a Docusign envelope permanently invalidates a legally significant signed record..."`.

  ### Allowed — contract-ops remediation

  The same void request with `"claims": { "groups": ["contract-ops"] }` is allowed.

  ## Composition

  This policy is single-purpose. Useful companions on the Docusign path:

  - An ingress transform that rewrites `createEnvelope` `status: "sent"` to `"created"` so agents prepare drafts and humans dispatch them.
  - An ingress deny on `updateEnvelopeRecipients` / envelope creation when a signer email is outside your counterparty allowlist.
  - An ingress allowlist for `triggerWorkflow` pinned to approved workflow IDs.
  - An egress redaction policy on `listRecipients` / `getEnvelope` / `getAgreementDetails` for tab values and extracted terms.

  ## Known limitations

  - **Group names are placeholders** — replace `contract-ops` with your IdP's group name at import time. The exemption reads `input.subject.claims.groups` and expects an array; a missing, empty, or string-valued `groups` claim means no exemption (fail closed).
  - **Official-server argument shapes are inferred from the mapped REST endpoints**, not an MCP schema dump — Docusign does not publish per-tool JSON schemas on a static page. Verify against a live `tools/list` or the dump-input technique before relying on exact field names.
  - **Only top-level `args` keys are inspected for void signals.** If your MCP server nests the envelope body under a wrapper key (none is documented for the official server), a void could evade the argument check — the two workflow tools are still blocked by name. Extend `is_void_attempt` if you observe a nested shape. (Covered by a test asserting the current pass-through behaviour.)
  - **Void signals assume string-typed values.** Signal 1 fires only when the `status` value equals `voided` after lowercasing and trimming, so a non-string value (e.g. `status: ["voided"]`) or a non-object `args` payload evades Signal 1. This is **not** an exploitable bypass: the Docusign eSignature REST body requires `status` to be a string, so a malformed shape is rejected server-side and no void occurs, and any well-formed void must carry a non-empty `voidedReason` that Signal 2 detects by key presence regardless of the `status` value's type. If a future server variant coerces such shapes into a real void, broaden Signal 1 accordingly. (Covered by a test asserting the current pass-through behaviour.)
  - **Void is the only destructive `updateEnvelope` shape this policy detects.** The mapped Envelopes:update endpoint also accepts a document-retention `purgeState` field (e.g. `documents_and_metadata_queued`) that irreversibly purges envelope documents — an irreversible destruction that also falls under the PF-06 anti-destruction scope this policy supports. That field is **not** listed in the verified Docusign landscape note's `updateEnvelope` argument shape, so this policy does **not** key on it (marking it unverified rather than inventing enforcement): a `purgeState` purge carrying no `status: "voided"` and no `voidedReason` currently passes through. If a live `tools/list` confirms `updateEnvelope` exposes `purgeState`, add a third void-detection signal that denies its presence. (Covered by a test asserting the current pass-through behaviour.)
  - **Non-void `updateEnvelope` edits pass through**, including `status: "sent"` (dispatching a draft emails real recipients). If that is too permissive for your environment, pair with the force-drafts companion above.
  - **Web UI, native API, Connect webhooks, and admin console are out of reach** — this policy governs only the MCP agent path.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - docusign
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package docusign.ingress.freeze_destructive_ops

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# --- Tool matching ---
# The gateway prefixes tool names with the configured MCP server name
# (e.g. `docusign-updateEnvelope`), so we match on the suffix to stay
# portable. Suffix matching deliberately excludes `updateEnvelopeRecipients`,
# which is a different tool. Verify exact names on your gateway with the
# dump-input debug technique before relying on this in production.
is_update_envelope if {
    endswith(lower(input.resource.name), "updateenvelope")
}

is_cancel_workflow if {
    endswith(lower(input.resource.name), "cancelworkflowinstance")
}

is_pause_workflows if {
    endswith(lower(input.resource.name), "pausenewworkflowinstances")
}

is_guarded_tool if is_update_envelope

is_guarded_tool if is_cancel_workflow

is_guarded_tool if is_pause_workflows

# --- Identity exemption ---
# `contract-ops` is a placeholder group name — map it to your IdP group at
# import time. Missing subject/claims/groups fails closed: no group, no exemption.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

is_contract_ops if {
    some g in caller_groups
    lower(sprintf("%v", [g])) == "contract-ops"
}

# --- Void detection ---
# Top-level tool arguments; keys are matched case-insensitively below.
args := object.get(object.get(input, "payload", {}), "args", {})

# Signal 1: an explicit `status: "voided"` body (the documented Envelopes:update
# void shape), tolerant of key/value casing and stray whitespace.
is_void_attempt if {
    some k in object.keys(args)
    lower(k) == "status"
    lower(trim_space(sprintf("%v", [args[k]]))) == "voided"
}

# Signal 2: a `voidedReason` key with any value (including empty). That field
# only exists on void requests, so its presence marks void intent even when
# the status key is missing or obfuscated.
is_void_attempt if {
    some k in object.keys(args)
    lower(k) == "voidedreason"
}

# --- Allow rules ---
# Pass through any tool this policy does not guard.
allow if {
    not is_guarded_tool
}

# contract-ops members may perform legitimate remediation.
allow if {
    is_guarded_tool
    is_contract_ops
}

# Non-void updateEnvelope calls (send draft, subject/blurb edits) pass through.
allow if {
    is_update_envelope
    not is_void_attempt
}

# --- Deny reasons ---
reasons contains "Voiding a Docusign envelope permanently invalidates a legally significant signed record, so agent-initiated voids are blocked. Prepare a correcting envelope instead, or ask a member of the contract-ops group to perform the void. Contact your administrator if this block looks wrong." if {
    is_update_envelope
    is_void_attempt
    not is_contract_ops
}

reasons contains "Cancelling a running Docusign Maestro workflow instance is irreversible, so agent-initiated cancellations are blocked. Ask a member of the contract-ops group to cancel the instance from the Docusign console. Contact your administrator if this block looks wrong." if {
    is_cancel_workflow
    not is_contract_ops
}

reasons contains "Pausing new Docusign Maestro workflow instances suspends the workflow account-wide, so agent-initiated pauses are blocked. Ask a member of the contract-ops group to pause the workflow from the Docusign console. Contact your administrator if this block looks wrong." if {
    is_pause_workflows
    not is_contract_ops
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
