---
name: Human-Only Stripe Dispute Submission
tags:
  - stripe
  - require-human-approval
  - disputes
  - separation-of-duties
  - transform
  - ingress
  - sox
publishedAt: 2026-07-12
description: |
  # stripe / require-human-approval-dispute-submit

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `stripe.ingress.require_human_approval_dispute_submit`

  ## What it does

  Strips the irreversible `submit` flag from Stripe `*update_dispute` tool
  calls. Filing dispute evidence with the card network is **one-shot**: once
  `update_dispute` is called with `submit: true`, the evidence is submitted and
  cannot be amended or resubmitted. This policy keeps that consummating step
  off the agent path while leaving the drafting step fully functional — the
  initiate-vs-approve separation.

  Concretely: when an `*update_dispute` call carries a `submit` key in its
  arguments, the policy emits a transform that removes the key and passes the
  rest of the call (the `dispute` ID and the `evidence` draft —
  `cancellation_policy_disclosure`, `duplicate_charge_explanation`,
  `uncategorized_text`) through unchanged. The agent's evidence draft lands on
  the dispute; a human then reviews and submits it in the Stripe dashboard,
  where the submitting person is recorded. Calls without a `submit` key, and
  every other tool, pass through untouched with no transform.

  There is **no identity-group exemption**: evidence filing is human-gated for
  every caller, including privileged users, because the point of the gate is
  that the irreversible decision is taken by a person, not by whichever
  service identity the agent happens to run as.

  ## Compliance alignment

  - **SOC 2 CC6.3** — supports role-based access with separation of duties on
    the agent path: the actor that drafts dispute evidence cannot also be the
    actor that files it with the card network over MCP.
  - **SOX SoD (COSO Principle 10)** — supports the initiate-vs-approve
    separation on a financially consequential transaction: the agent
    initiates (drafts evidence), a human approves (submits in the dashboard).
  - **SOX 13a-15(f)(2)(ii)** — supports transaction authorization by keeping
    the authorizing action (irreversible submission of dispute evidence, which
    determines whether disputed funds are recovered) off the automated actor.
  - **SOX / PCAOB AI human-in-the-loop** — supports a draft-only agent posture
    for dispute consummation, consistent with human-oversight expectations for
    AI acting on financial records.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name as
  `<server-name>-<tool-name>` (e.g. `stripe-mcp-update_dispute`), and that
  prefix is not standardized across deployments. The policy therefore matches
  case-insensitively on `lower(input.resource.name)` by **suffix**
  (`endswith`), against one verified name:

  - `*update_dispute` — the legacy per-resource tool from `@stripe/mcp`
    v0.8.x / the Claude Desktop `.dxt` manifest (verified from the `stripe/ai`
    repo history). Its argument shape is
    `{ dispute, evidence?: { cancellation_policy_disclosure?,
    duplicate_charge_explanation?, uncategorized_text? }, submit?: boolean }`.

  Suffix matching is deliberately broad for a control gate: a hypothetical
  `bulk_update_dispute`, or an aggregator slug like `STRIPE_UPDATE_DISPUTE`
  (unverified — Composio-style naming), also ends with the suffix and is
  also transformed, which is the intended fail-safe direction. Verify the
  exact name your gateway sends with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  The policy reads `input.payload.args` via `object.get` at every step, so a
  missing `payload`, missing `args`, or missing `submit` key simply means the
  transform never fires and the call passes through — there is nothing to
  strip, and a transform-only policy has nothing to deny.

  The transform fires on **presence of the `submit` key, not on
  `submit == true`**. Stripe's form-encoded API treats string encodings like
  `"true"` as truthy, so matching only the boolean would leave an encoding
  bypass; and removing an explicit `submit: false` is a semantic no-op
  (`false` is Stripe's default). Stripping on presence closes the bypass
  without changing behavior for compliant callers.

  When it fires, the transform emits `transformed_payload` =
  `object.remove(args, ["submit"])` — the original arguments minus the flag,
  with the `dispute` ID and the entire `evidence` object preserved verbatim.

  ## Examples

  ### Allowed untouched — drafting evidence without submitting

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-update_dispute", "type": "tool" },
      "payload": {
        "name": "stripe-mcp-update_dispute",
        "args": {
          "dispute": "dp_1OABCD2eZvKYlo2C",
          "evidence": { "duplicate_charge_explanation": "Two distinct orders; receipts attached." }
        }
      }
    }
  }
  ```

  `allow = true`, no transform — the draft reaches Stripe as sent.

  ### Transformed — submit flag stripped

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-update_dispute", "type": "tool" },
      "payload": {
        "name": "stripe-mcp-update_dispute",
        "args": {
          "dispute": "dp_1OABCD2eZvKYlo2C",
          "evidence": { "uncategorized_text": "Customer signed the cancellation policy on 2026-05-02." },
          "submit": true
        }
      }
    }
  }
  ```

  `allow = true`, `transform.transformed_payload = { "dispute": "dp_1OABCD2eZvKYlo2C", "evidence": { ... } }`
  — the evidence draft is saved, the filing is not; a human submits from the
  Stripe dashboard.

  ## Composition

  This policy is single-purpose — it removes only the dispute-submission
  consummation step. Pair it with:

  - An **API-write allowlist / escape-hatch policy on `*stripe_api_write`** —
    the current official Stripe MCP server routes *all* writes through the
    `stripe_api_write` meta-tool, including dispute updates. A dispute
    submission made through that tool never matches `*update_dispute`, so
    this transform cannot see it (see Known limitations). Denying or
    endpoint-allowlisting `stripe_api_write` is what closes that route.
  - A **default-deny-unknown-tools allowlist (PF-28)** — catches renamed or
    aggregator-specific dispute tools this suffix match cannot anticipate.
  - A **refund-cap policy on `*create_refund`** — the other irreversible
    money-out surface in the legacy Stripe tool set.
  - **Stripe Restricted API Key (RAK) scoping** — layer, don't substitute:
    a key without dispute-write permission is the control that also covers
    non-MCP access.

  ## Known limitations

  - **The `stripe_api_write` escape hatch is invisible here.** On the current
    official server (mcp.stripe.com and the v0.9+ `@stripe/mcp` proxy), all
    writes — including `POST /v1/disputes/{id}` with `submit: true` — go
    through the `stripe_api_write` meta-tool, whose name does not end in
    `update_dispute`. This policy's verified target is the legacy per-resource
    `update_dispute` tool (v0.8.x installs, the `.dxt` manifest, and
    `@stripe/agent-toolkit` embeddings). Deployments on the current server
    must pair this with an allowlist/deny on `*stripe_api_write` or the gate
    is decorative.
  - **Renamed tools slip past.** A `noun_verb` server (e.g. a community
    server's `dispute_update`) or a trailing-token variant
    (`update_disputes`, `update_dispute_v2`) does not end with the exact
    suffix and passes through untouched. Rely on a PF-28 allowlist to fail
    unknown names closed.
  - **Suffix breadth (prefix side) is intentional.** Any tool name *ending*
    in `update_dispute` is transformed, including hypothetical bulk variants.
    For a human-approval gate this over-inclusion is the safe direction; if a
    legitimate tool is caught, escalate to your gateway admin.
  - **`trim_space` normalizes only standard whitespace.** A tool name ending
    in a zero-width or format character (U+200B, U+FEFF, U+2060) after
    `update_dispute` does not match the suffix and passes through untouched.
    Any strip list can itself be evaded, so this is not chased in the Rego;
    the PF-28 allowlist is the backstop.
  - **Presence-based stripping also removes `submit: false`.** Semantically a
    no-op (false is Stripe's default), but the call Stripe receives differs
    byte-for-byte from the call the agent sent. This is the cost of closing
    the truthy-string-encoding bypass.
  - **Treasury preview tools are out of scope.** Stripe's agentic-finance
    preview tool names are not published; nothing here matches them, and no
    policy in this store should guess at them.
  - **MCP path only.** The Stripe dashboard, direct API keys, and webhooks
    are outside the gateway's reach — which is exactly why the human submits
    from the dashboard. Pair with RAK scoping for the non-MCP surface.
  - **No identity-based exemptions — by design.** There is no break-glass
    group, so there are no placeholder group names to replace at import time.
    Submission over MCP is stripped for everyone; humans submit in the
    dashboard where their identity is recorded.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - stripe
industries: []
bundles:
  - sox
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package stripe.ingress.require_human_approval_dispute_submit

# Transform-only policy: never denies. When an *update_dispute call carries
# the irreversible `submit` flag, the transform strips it so the evidence
# draft still lands on the dispute but the one-shot filing with the card
# network stays human-actuated (initiate-vs-approve separation).
default allow := true

# Tool arguments; a missing payload or args resolves to {} so the transform
# condition simply never fires on malformed input (nothing to strip).
args := object.get(object.get(input, "payload", {}), "args", {})

# Ingress pre-invoke gate. `action` is the PARC field; `kind` is its populated
# legacy alias (same value). Accept EITHER: a build that populates only `kind`
# (or a PARC revision that drops `action`) would otherwise fail the match and
# pass a submit:true call straight through — a fail-open submission of the
# one-shot filing. Restricting to pre-invoke also keeps the transform off
# egress hooks, whose payload carries `text`, not `args`.
is_pre_invoke if object.get(input, "action", "") == "tool_pre_invoke"

is_pre_invoke if object.get(input, "kind", "") == "tool_pre_invoke"

# Tool name, lowercased and whitespace-trimmed; a missing resource/name
# resolves to "" (matches nothing). trim_space closes a suffix-match evasion:
# a name with a trailing space/tab/newline would otherwise fail endswith and
# carry its submit flag through untouched.
tool_name := trim_space(lower(object.get(object.get(input, "resource", {}), "name", "")))

# The verified legacy per-resource tool `update_dispute`, matched by suffix
# for portability across the gateway's `<server-name>-<tool-name>` prefixing.
# Suffix breadth is intentional: any name ending in update_dispute (bulk or
# aggregator variants) is also a dispute write and gets the same treatment.
is_update_dispute_tool if {
    endswith(tool_name, "update_dispute")
}

# Fire on presence of the `submit` key, not on `submit == true`: Stripe's
# form-encoded API treats string encodings like "true" as truthy, and
# removing an explicit `submit: false` is a semantic no-op (false is the
# API default), so presence-matching closes the encoding bypass without
# changing behavior for compliant callers.
has_submit_key if {
    "submit" in object.keys(args)
}

# Strip the submit flag; everything else (dispute ID, evidence draft) passes
# through verbatim. The human consummates submission in the Stripe dashboard.
transform := {"transformed_payload": object.remove(args, ["submit"])} if {
    is_pre_invoke
    is_update_dispute_tool
    has_submit_key
}
```
