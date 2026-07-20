---
name: Stripe Refund Group Gate and Amount Cap
tags:
  - stripe
  - gate-money-movement
  - ingress
  - pci-dss
  - sox
publishedAt: 2026-07-12
description: |
  # stripe / gate-money-movement-refund-cap

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny refund tools unless group-authorized and under the cap; allow everything else
  **Package:** `stripe.ingress.gate_money_movement_refund_cap`

  ## What it does

  Denies Stripe refund tool calls — money out, irreversible — unless the caller's
  IdP groups include `finance` or `billing-admin`. Even for those groups, it
  denies any refund whose `amount` exceeds a configured ceiling (default
  `50000` = $500.00, in cents).

  Because the Stripe API treats an **omitted `amount` as a full refund** of the
  payment intent, a missing `amount` is treated as unbounded and denied above
  the ceiling — only refunds with an explicit positive amount at or under the
  ceiling go through.

  The check runs at ingress, before the call reaches Stripe, so a blocked
  refund never moves money. All non-refund tool calls pass through unchanged.

  ## Compliance alignment

  - **PCI DSS 7.2.1 / 7.2.2** — supports the least-privilege access model by
    restricting a money-moving operation on the payment platform to defined
    finance roles.
  - **SOX ITGC (access to programs and data)** — supports least-privilege
    access to a financial system on the agent channel; **Rule 13a-15(f)(3)** —
    supports safeguarding of assets by capping the unattended outflow an agent
    can trigger; **Rule 13a-15(f)(2)(ii)** — supports transaction authorization
    via the amount threshold, above which a human must act in the Stripe
    dashboard.
  - **SOC 2 CC6.3** — supports role-based access and segregation of duties:
    refund initiation through the agent is limited to finance groups, and
    larger refunds are separated out to human approval.

  ## Tool name matching

  The policy matches refund tools by suffix on `lower(input.resource.name)`:

  - `*create_refund` — the official Stripe MCP server's dedicated refund tool.
    The same name is used by the current meta-tool server (mcp.stripe.com /
    `@stripe/mcp` ≥ 0.9) and the legacy per-resource v0.8.x tool set.
  - `*refund_create` — the community `atharvagupta2003/mcp-stripe` server uses
    inverted `noun_verb` names, which breaks suffix symmetry with the official
    naming; matched explicitly.

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `stripe-mcp-create_refund`), and that prefix is not standardized —
  suffix matching keeps the policy portable. Verify the exact name your
  gateway sends with the dump-input debug technique before relying on this in
  production.

  ## Argument shape

  Verified from the official server source: `create_refund` takes
  `{ payment_intent: string, amount?: int }` with `amount` in **cents** and an
  omitted `amount` meaning a full refund. The policy reads
  `object.get(input.payload.args, "amount", 0)`, so:

  - missing `amount` → default `0` → not a positive explicit amount → denied
    (unbounded full refund);
  - explicit `amount` of `0` or a non-numeric value → denied (fail closed);
  - explicit positive `amount` ≤ `refund_ceiling` → allowed for permitted
    groups.

  Amounts are in the currency's smallest unit — see Known limitations for
  non-cent currencies.

  ## Identity gate

  The caller must present an IdP `groups` claim (array of strings, compared
  case-insensitively) containing `finance` or `billing-admin`. Claims are read
  with `object.get` chains, so a caller with no claims, no `groups` claim, or
  an unpopulated `input.subject` **fails closed**: no group → denied.

  ## Examples

  ### Allowed — finance member, refund under the cap

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-create_refund", "type": "tool" },
      "subject": { "sub": "auth0|jane", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "stripe-mcp-create_refund",
        "args": { "payment_intent": "pi_3Abc", "amount": 2500 }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — full refund (amount omitted), even for finance

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "stripe-mcp-create_refund", "type": "tool" },
      "subject": { "sub": "auth0|jane", "claims": { "groups": ["finance"] } },
      "payload": {
        "name": "stripe-mcp-create_refund",
        "args": { "payment_intent": "pi_3Abc" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This refund has no explicit amount or exceeds the 50000-cent ($500.00) ceiling ..."`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - **A read-only Stripe gate** denying `*stripe_api_write` and the legacy
    write/destructive suffixes outside finance groups — `stripe_api_write` can
    issue refunds via `POST /v1/refunds` and this policy does not see inside
    it.
  - **A dispute-submit gate** on `*update_dispute` (deny or strip
    `submit: true`) — the other irreversible Stripe surface.
  - Stripe Restricted API Key (RAK) scoping — layer key permissions with
    gateway policy rather than relying on either alone.

  ## Known limitations

  - **Group names are placeholders — replace `finance` and `billing-admin`
    with your IdP's group names at import time.** The `groups` claim must be
    emitted by your IdP; many (including Auth0) require explicit configuration
    before group information reaches the token.
  - **`stripe_api_write` bypass.** The official meta-tool server can execute
    any Stripe `POST` method, including refund creation, through
    `*stripe_api_write`. This policy matches only dedicated refund tools; pair
    it with an API-write gate or allowlist policy.
  - **Currency-blind cap.** `amount` is in the currency's smallest unit. The
    default ceiling assumes a cent-denominated currency: 50000 JPY is ¥50,000
    (zero-decimal), not $500. Tune `refund_ceiling` if you refund in
    zero-decimal currencies.
  - **Composio tool names unverified.** Composio's ~415-action Stripe toolkit
    uses its own `STRIPE_*` slug convention; whether its refund action ends in
    `create_refund` is unverified. Capture the live tool name from your
    gateway and extend `is_refund_tool` if needed.
  - **Treasury preview tools unverified.** Stripe's agentic-finance preview
    adds money-movement tools whose names are not published; they are not
    matched here — do not assume they are covered.
  - **MCP path only.** Refunds issued via the Stripe dashboard, direct API
    keys, or webhooks are outside the gateway's reach.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - stripe
industries: []
bundles:
  - pci-dss
  - sox
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package stripe.ingress.gate_money_movement_refund_cap

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Maximum agent-issued refund, in the currency's smallest unit
# (50000 = $500.00 for cent-denominated currencies). Tune per tenant;
# note zero-decimal currencies (e.g. JPY) count whole units.
refund_ceiling := 50000

# IdP groups allowed to issue refunds through the agent. PLACEHOLDERS —
# replace with your IdP's group names at import time. Compared
# case-insensitively against the caller's `groups` claim.
allowed_groups := {"finance", "billing-admin"}

# Refund tools, matched by suffix so the gateway's server-name prefix
# (e.g. `stripe-mcp-`) doesn't matter. `create_refund` covers the official
# current and legacy servers; `refund_create` covers the community server's
# inverted noun_verb naming.
is_refund_tool if {
    endswith(lower(input.resource.name), "create_refund")
}

is_refund_tool if {
    endswith(lower(input.resource.name), "refund_create")
}

# Pass through any tool that isn't a refund call.
allow if {
    not is_refund_tool
}

# Refunds go through only for permitted groups AND within the amount ceiling.
allow if {
    is_refund_tool
    caller_in_allowed_group
    within_ceiling
}

# Fail closed on identity: missing subject, claims, or groups claim means
# no membership and therefore no refund.
caller_in_allowed_group if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    some group in groups
    allowed_groups[lower(group)]
}

# A refund is within the ceiling only when an explicit positive numeric
# `amount` (smallest currency unit) is present and does not exceed
# refund_ceiling. Stripe treats an omitted `amount` as a FULL refund of the
# payment intent, so a missing amount (object.get default 0 here) is
# unbounded and never within the ceiling. Non-numeric amounts fail closed.
within_ceiling if {
    amount := object.get(input.payload.args, "amount", 0)
    is_number(amount)
    amount > 0
    amount <= refund_ceiling
}

reasons contains "Agent-issued Stripe refunds are limited to members of the finance or billing-admin group. Ask someone in those groups to issue this refund from the Stripe dashboard. Contact your InfoSec team if you believe your access is misconfigured." if {
    is_refund_tool
    not caller_in_allowed_group
}

reasons contains "This refund has no explicit amount or exceeds the 50000-cent ($500.00) ceiling for agent-issued refunds; Stripe treats a missing amount as a full refund. Route this refund to a human in the Stripe dashboard. Contact your InfoSec team if the cap is blocking a legitimate refund." if {
    is_refund_tool
    not within_ceiling
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
