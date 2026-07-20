---
name: Force Docusign Envelopes to Draft
tags:
  - docusign
  - force-draft-envelopes
  - esign
  - human-in-the-loop
  - ingress
publishedAt: 2026-07-12
description: |
  # docusign / force-draft-envelopes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `docusign.ingress.force_draft_envelopes`

  ## What it does

  Rewrites Docusign envelope-creation calls so the envelope is staged as a
  **draft** (`status: "created"`) instead of being **dispatched**
  (`status: "sent"`). With `status: "sent"`, Docusign immediately emails real
  recipients a legally binding signature request under your company's Docusign
  brand — a hallucinated or injected send is a legal and reputational event,
  not a recoverable data event. The safe default is that agents may *stage*
  envelopes but never *dispatch* them.

  Callers whose IdP `groups` claim includes `esign-senders` pass through
  unchanged, preserving the human-authorized dispatch path. Everyone else has
  `status` forced to `"created"` — whether it was `"sent"`, missing (the
  community servers default to `"sent"` when omitted), or any other non-draft
  value. Calls whose `status` is already `"created"` pass through untouched.
  All other tools are unaffected.

  ## Compliance alignment

  - **SOC 2 CC6.3** — supports least privilege and segregation of duties on
    the agent channel: the agent holds only the *initiate* (draft) privilege
    and the *dispatch* privilege stays with humans in the `esign-senders`
    group, preserving the initiate-vs-approve separation for signature
    transactions (agents prepare, an authorized human sends).

  ## Tool name matching

  The policy matches envelope-creation tools by case-insensitive suffix:

  - `*createenvelope` — official Docusign MCP Server `createEnvelope`
    (verified from the developer-docs tool catalog)
  - `*create_envelope_from_template` and `*create_envelope_from_documents` —
    luthersystems community server (verified from source)

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `docusign-createEnvelope`), and that prefix is not standardized, so
  the policy matches on the suffix to stay portable. Both `resource.name` and
  the legacy `payload.name` alias are checked, so a call missing one of the
  two cannot slip past. Verify the exact names your gateway sends with the
  dump-input debug technique before relying on this in production.

  ## Argument shape

  The policy reads and rewrites the top-level `status` argument:

  - Official `createEnvelope` mirrors the eSignature Envelopes:create REST
    body — `status` at the top level (`"sent"` = dispatch now, `"created"` =
    draft), alongside `emailSubject`, `documents[]`, `recipients.signers[]`,
    or `templateId` + `templateRoles[]`.
  - Community `create_envelope_from_template` / `create_envelope_from_documents`
    take a top-level `status` that **defaults to `"sent"` when omitted**,
    which is why a missing `status` is also rewritten to `"created"`.

  The transform preserves every other argument via `object.union` and only
  sets `status`.

  ## Examples

  ### Transformed (agent tried to dispatch)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "docusign-createEnvelope", "type": "tool" },
      "subject": { "sub": "agent@example.com", "claims": { "groups": ["staff"] } },
      "payload": {
        "name": "docusign-createEnvelope",
        "args": {
          "emailSubject": "Please sign: MSA",
          "status": "sent",
          "templateId": "tpl-1",
          "templateRoles": [{ "roleName": "Signer", "name": "Ana", "email": "ana@acme.com" }]
        }
      }
    }
  }
  ```

  `allow = true`; transform rewrites `status` to `"created"` and preserves all
  other arguments — the envelope lands in Drafts, no email goes out.

  ### Allowed unchanged (authorized sender)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "docusign-createEnvelope", "type": "tool" },
      "subject": { "sub": "ops@example.com", "claims": { "groups": ["esign-senders"] } },
      "payload": {
        "name": "docusign-createEnvelope",
        "args": { "emailSubject": "Please sign: MSA", "status": "sent" }
      }
    }
  }
  ```

  `allow = true`, no transform — the human-authorized dispatch path is
  preserved.

  ## Composition

  This policy is single-purpose: it governs the *create* step only. To close
  the full dispatch surface, pair it with:

  - An ingress **deny** on `updateEnvelope` when the body carries
    `status: "sent"` (sending an existing draft) or `status: "voided"`
    (irreversible void) for callers outside `esign-senders` / `contract-ops` —
    without it, an agent can draft here and dispatch via `updateEnvelope`.
  - An ingress deny on `sendReminder` and `updateEnvelopeRecipients` for
    non-senders (both generate real email to counterparties).
  - A recipient-domain allowlist on envelope creation (blocks mis-sends and
    "add my personal email as a signer" exfiltration).

  ## Known limitations

  - **Dispatch via other tools is not covered.** `updateEnvelope`
    (`status: "sent"` on a draft), `sendReminder`, and `triggerWorkflow` can
    still cause external email; attach the companion policies above. This
    policy deliberately does one job: force the *create* step to a draft.
  - **Official-server argument shape is documented, not schema-dumped.** The
    official tools mirror their documented REST bodies (top-level `status`),
    but Docusign does not publish per-tool MCP JSON schemas on a static page —
    verify against a live `tools/list` before relying on exact field paths.
    If your server nests the envelope definition (e.g. under
    `envelopeDefinition`), extend the `args` accessor accordingly.
  - **Nested-`status` decoy (server-shape dependent, red-team residual).** The
    policy reads and pins only the *top-level* `status`. If a server actually
    honours a nested `envelopeDefinition.status`, two crafted shapes evade the
    draft-forcing: (a) a decoy top-level `status:"created"` *plus* a nested
    `envelopeDefinition.status:"sent"` — the top-level `"created"` trips
    `is_explicit_draft`, so the call passes through untouched and the nested
    `"sent"` survives; (b) no top-level `status` plus a nested `"sent"` — the
    transform pins top-level `status:"created"` but the nested `"sent"` is
    preserved. Both are covered by tests as documented residuals. This does
    **not** affect the official server or the luthersystems community server,
    whose create tools take `status` at the top level (per the landscape note);
    it only bites a server that nests the envelope definition. If yours does,
    extend the accessor to read and pin the nested `status` too, and pair with
    the recipient-domain allowlist companion policy.
  - **Non-canonical `status` key casing leaves a decoy key.** JSON keys are
    case-sensitive, so a `Status:"sent"` / `STATUS:"sent"` argument is not the
    top-level `status` the policy inspects; the transform therefore fires and
    injects the canonical lowercase `status:"created"` (the Docusign REST body
    uses lowercase `status`, which wins). The original mixed-case key is left
    in the payload as an inert decoy. A hypothetical case-insensitive server
    that preferred the decoy over the injected canonical key is the residual;
    the official and community servers use lowercase `status` and are safe.
    Covered in tests.
  - **Non-object `args` pass through.** If `args` arrives as a non-object
    (e.g. a bare string), the transform is undefined and the call passes
    through unmodified; such a call carries no valid envelope definition and
    fails at the Docusign server (documented residual, covered in tests).
  - **A pre-existing `status: "created"` is trusted case-insensitively.**
    `"Created"`/`"CREATED"` are treated as already-draft and left unchanged;
    Docusign either accepts them as a draft or rejects the call — neither
    path sends email.
  - **Group name is a placeholder.** Replace `esign-senders` with your IdP's
    group name at import time. Missing subject/claims/groups fail closed for
    the exemption (no group → not an authorized sender → forced to draft).
  - **Suffix matching misses a trailing segment after the create verb.** Tool
    names are matched case-insensitively with `endswith`, so a name that
    carries a trailing segment *after* the create verb (e.g. a version suffix
    `...createEnvelope-v2`) would not match and would pass through unmodified
    with `status:"sent"` intact. No documented Docusign create tool names tools
    this way — the official server exposes `createEnvelope`, the luthersystems
    community server `create_envelope_from_template` / `_from_documents`, and
    the gateway only *prepends* the configured server name — so this does not
    affect the real servers. Confirm your gateway's exact tool names with the
    dump-input debug technique and add any trailing-suffixed variant to
    `envelope_create_suffixes`. Covered in tests.
  - **CData community server is out of scope** — it is read-only SQL and has
    no envelope-creation surface.

  > **Compliance note.** This policy supports alignment with the cited
  > framework controls **on the MCP path only**. No policy or bundle makes an
  > organization compliant with any framework; web-UI, native-API, and in-app
  > access are outside the gateway's reach by design. Validate against your
  > own compliance program before relying on it.
direction: ingress
apps:
  - docusign
industries: []
bundles: []
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package docusign.ingress.force_draft_envelopes

# Transform-only policy: allow everything, and rewrite envelope-creation
# calls to status "created" (draft) unless the caller is an authorized
# sender. Agents stage envelopes; humans dispatch them. Never denies.
default allow := true

# ---------------------------------------------------------------------------
# Configuration placeholders — replace at import time
# ---------------------------------------------------------------------------

# IdP group whose members may dispatch envelopes (status "sent" passes
# through unmodified). PLACEHOLDER: replace with your IdP group name.
esign_senders_group := "esign-senders"

# Envelope-creation tool suffixes. Lower-case; matched case-insensitively.
# - "createenvelope": official Docusign MCP Server createEnvelope (verified
#   from the developer-docs tool catalog)
# - "create_envelope_from_template" / "create_envelope_from_documents":
#   luthersystems community server (verified from source; its status
#   argument DEFAULTS to "sent" when omitted)
envelope_create_suffixes := {
    "createenvelope",
    "create_envelope_from_template",
    "create_envelope_from_documents",
}

# ---------------------------------------------------------------------------
# Shared accessors — every possibly-missing field is read via object.get
# ---------------------------------------------------------------------------

args := object.get(object.get(input, "payload", {}), "args", {})

# Ingress pre-invoke gate. The PARC field is `action`; `kind` is its populated
# legacy alias (same value). Accept EITHER via object.get: if a gateway build
# ever populates only the legacy `kind` (or PARC drops `action`), keying solely
# off `input.action` would silently fail the match and pass a `status:"sent"`
# call straight through — a fail-open dispatch. Restricting to pre-invoke keeps
# the transform off egress hooks, whose payload has `text`, not `args`.
is_pre_invoke if object.get(input, "action", "") == "tool_pre_invoke"
is_pre_invoke if object.get(input, "kind", "") == "tool_pre_invoke"

# Envelope-creation call. The gateway prefixes tool names with the configured
# MCP server name, so match by suffix for portability. Case-insensitive so a
# mixed-case tool name can't slip past. Match on resource.name OR the legacy
# payload.name alias (both populated on tool hooks, same value): a call that
# arrived with an absent resource.name would otherwise miss the match and
# dispatch real signature-request email — a fail-open leak. Reading both via
# object.get also means a missing `resource` object can't error the rule.
is_envelope_create_call if {
    is_pre_invoke
    some suffix in envelope_create_suffixes
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), suffix)
}

is_envelope_create_call if {
    is_pre_invoke
    some suffix in envelope_create_suffixes
    endswith(lower(object.get(object.get(input, "payload", {}), "name", "")), suffix)
}

# True when the caller is in the authorized-senders group. Missing subject /
# claims / groups fail closed (no group -> not an authorized sender -> the
# envelope is forced to draft). A groups claim emitted as a bare string is
# not iterated by `some g in`, so it also fails closed.
is_authorized_sender if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    some g in object.get(claims, "groups", [])
    g == esign_senders_group
}

# True only when the caller already asked for an explicit draft. Anything
# else — "sent", a missing status (the community default is "sent"), padded
# or unexpected values — gets rewritten. trim_space + lower so "Created "
# still counts as a draft; a non-string status is never treated as a draft.
is_explicit_draft if {
    status := object.get(args, "status", "")
    is_string(status)
    lower(trim_space(status)) == "created"
}

# ---------------------------------------------------------------------------
# Transform: force status "created" on unauthorized envelope creation
# ---------------------------------------------------------------------------

# Preserves every other argument (documents, recipients, templateId,
# emailSubject, ...) and only pins status to "created": the agent's envelope
# lands in Drafts and no recipient is emailed. If args is a non-object the
# object.union is undefined and the call passes through unmodified — such a
# call carries no valid envelope definition and fails at the Docusign server
# (documented residual).
transform := {"transformed_payload": object.union(args, {"status": "created"})} if {
    is_envelope_create_call
    not is_authorized_sender
    not is_explicit_draft
}
```
