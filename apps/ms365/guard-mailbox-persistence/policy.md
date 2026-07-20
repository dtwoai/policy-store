---
name: Block Mail-Rule and Webhook Persistence
tags:
  - ms365
  - guard-mailbox-persistence
  - ingress
  - bec
  - email
  - finserv-comms
  - soc2
publishedAt: 2026-07-12
description: |
  # ms365 / guard-mailbox-persistence

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `ms365.ingress.guard_mailbox_persistence`

  ## What it does

  Unconditionally denies the classic business-email-compromise (BEC) persistence surface in Microsoft 365: creating or updating Outlook mail rules, changing mailbox settings, and creating Microsoft Graph change-notification subscriptions (webhooks). All other tool calls pass through unchanged.

  Mail rules can silently auto-forward incoming mail to an external address or delete/hide it (the hide-and-forward filter attackers plant after a compromise). Mailbox-settings changes can enable automatic external forwarding for the whole mailbox. A Graph subscription is a standing webhook that streams change notifications to an attacker-controlled URL — a persistent exfiltration channel that survives the session that created it.

  Agents have no legitimate reason to configure any of these. This policy is therefore **deny-for-everyone**: there is no group exemption and no role check. A compromised or prompt-injected agent gets a hard stop, not a permission ladder to climb. The deny reason flags the attempt for security review — treat every denial from this policy as a log-and-alert signal, not routine noise.

  ## Compliance alignment

  - **SEC 17a-4(b) / FINRA 4511(c)** — supports record-integrity requirements: mail rules that auto-delete or divert incoming correspondence would silently destroy or reroute business communications before they can be preserved; blocking rule creation on the agent path supports record anti-destruction.
  - **SOC 2 CC6.6** — supports boundary protection against external threats: mail
    rules and Graph change-notification subscriptions are the standing channels a
    compromised agent uses to auto-forward or stream tenant content to an outside
    endpoint, and denying their creation on the agent path closes that boundary hole.
  - **GDPR Art. 32 / Art. 5(1)(f)** — supports security of processing: an
    auto-forwarding mail rule or a webhook subscription is a persistent
    personal-data exfiltration channel, so blocking its creation on the agent channel
    reduces the risk of unauthorized disclosure of personal data.
  - Anti-BEC hardening generally: mailbox-rule and forwarding persistence is the most common post-compromise action in real-world BEC incidents, so denying it on the agent channel removes a high-value attacker foothold.

  ## Tool name matching

  The policy matches tools case-insensitively by verb-noun suffix:

  - `*create-mail-rule`
  - `*update-mail-rule`
  - `*update-mailbox-settings`
  - `*create-subscription` (the Graph change-notification webhook)

  These suffixes are verified names from the softeria `ms-365-mcp-server` inventory (observed live behind a gateway with the `ms365-` prefix, e.g. `ms365-create-mail-rule`). The DTwo gateway prefixes tool names with the configured MCP server name, and that prefix — and the separator it uses — is not standardized, so the policy anchors on the bare verb-noun suffix (no leading `-`). This matches whether the gateway joins the prefix with a hyphen (`ms365-create-mail-rule`), a dot or underscore (`ms365.create-mail-rule`, `ms365_create-mail-rule`), or exposes the unprefixed name (`create-mail-rule`). No benign ms365 tool ends in these suffixes — the read counterparts are `list-mail-rules`, `get-mailbox-settings`, and `get`/`list-subscription(s)` — so there are no false positives. Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  None inspected. The deny is keyed entirely on the tool name — arguments are irrelevant because no invocation of these tools is acceptable. Calls with missing or empty `args` are still denied (fail closed on the name match alone).

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-list-mail-rules", "type": "tool" },
      "payload": { "name": "ms365-list-mail-rules", "args": {} }
    }
  }
  ```

  `allow = true`, no reason — reading existing rules is fine (and useful for detection).

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-create-mail-rule", "type": "tool" },
      "payload": {
        "name": "ms365-create-mail-rule",
        "args": { "body": { "displayName": "sync", "actions": { "forwardTo": [ /* external address */ ], "delete": true } } }
      }
    }
  }
  ```

  `allow = false`, denied with the security-review reason below.

  ## Composition

  - **`apps/ms365/freeze-destructive-ops`** — covers the companion surfaces `*-delete-mail-rule` and `*-delete-subscription` (destroying rules/subscriptions is a destructive op, not a persistence op, so it lives there).
  - **`apps/ms365/role-gate-writes`** — the outer least-privilege write gate; this policy is the unconditional inner wall for the BEC surface specifically.
  - **`apps/ms365/deny-graph-batch`** — **must ship together with this policy.** `graph-batch` can reach the same Graph endpoints (`/me/mailFolders/inbox/messageRules`, `/subscriptions`, `/me/mailboxSettings`) without touching these tool names.

  ## Known limitations

  - **`graph-batch` bypass if unaccompanied.** This policy matches tool names only. If `deny-graph-batch` is not attached to the same pipeline, a batched Graph request can create the same mail rule or subscription this policy blocks. Attach both.
  - **Generic passthrough servers.** Lokka-style servers (`Lokka-Microsoft`) expose one dynamic tool whose name never matches these suffixes; they need argument-level (`method`/`path`) policies instead.
  - **Existing subscriptions are not torn down.** `*-update-subscription` and `*-reauthorize-subscription` (which extend the lifetime of an already-existing webhook, but cannot create a new one or change its notification URL) are left to `role-gate-writes`; this policy only blocks the creation of new persistence.
  - **Focused-inbox overrides are out of scope.** `*-create-focused-inbox-override` (and its `update-`/`delete-` siblings) plant a standing rule that pins a chosen sender to the Focused or Other tab. This is a weaker persistence surface than a mail rule — it only reclassifies which tab mail lands in and cannot forward externally or delete — but an attacker can use it to bury a legitimate vendor's fraud-warning mail in Other. This policy deliberately covers only mail rules, mailbox settings, and subscriptions, so a focused-inbox override passes through here; gate it via `role-gate-writes` (least-privilege write gate) instead.
  - **Suffix anchoring.** Matching is anchored on the bare verb-noun suffix (`create-mail-rule`, not `-create-mail-rule`), so it catches prefixed names regardless of the separator the gateway uses (`-`, `.`, `_`) as well as the unprefixed name `create-mail-rule`. A server that *renames* the tool entirely (e.g. `add-inbox-filter`) would still slip past — verify your gateway's naming with the dump-input technique. Combined with the `default-deny-unknown-tools` (PF-28) allowlist this residual is closed.
  - **MCP path only.** Rules created via Outlook, OWA, PowerShell, or direct Graph API calls are outside the gateway's reach.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - ms365
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package ms365.ingress.guard_mailbox_persistence

# Deny-by-default: only the explicit allow rule below permits the request.
default allow := false

# Mailbox-persistence surfaces (classic BEC foothold). The gateway prefixes
# tool names with the configured MCP server name (observed live as `ms365-`),
# so we match case-insensitively on the verb-noun suffix WITHOUT requiring a
# specific prefix separator. Anchoring on the bare `create-mail-rule` suffix
# (rather than `-create-mail-rule`) also catches gateways that join the prefix
# with a non-hyphen separator (`ms365.create-mail-rule`, `ms365_create-mail-rule`)
# and servers that expose the unprefixed tool name — all of which would slip past
# a leading-hyphen anchor. No benign ms365 tool ends in these verb-noun suffixes
# (reads are `list-mail-rules`, `get-mailbox-settings`, `get/list-subscription(s)`),
# so dropping the hyphen adds no false positives.

# Creates an Outlook inbox rule (can auto-forward or silently delete mail).
is_persistence_tool if {
    endswith(lower(input.resource.name), "create-mail-rule")
}

# Rewrites an existing inbox rule (same forward/hide capability).
is_persistence_tool if {
    endswith(lower(input.resource.name), "update-mail-rule")
}

# Changes mailbox settings (can enable automatic external forwarding).
is_persistence_tool if {
    endswith(lower(input.resource.name), "update-mailbox-settings")
}

# Creates a Graph change-notification webhook (standing exfiltration channel).
is_persistence_tool if {
    endswith(lower(input.resource.name), "create-subscription")
}

# Allow everything that is not a mailbox-persistence tool.
allow if {
    not is_persistence_tool
}

# No allow rule exists for persistence tools: the deny is unconditional.
# There is deliberately no group exemption — agents never configure
# mail rules, mailbox settings, or webhooks.

reasons contains "Mailbox rules, mailbox settings, and Graph change-notification subscriptions must be configured by a human in Outlook or the Microsoft 365 admin center — agents are not permitted to create or modify them. This attempt has been flagged for security review. Contact your InfoSec team if you believe this block is a mistake." if {
    is_persistence_tool
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
