---
name: Hand Off High-Value Checkouts to a Human
tags:
  - ucp
  - agentic-commerce
  - checkout
  - handoff-gate
  - egress
publishedAt: 2026-06-27
description: |
  # ucp / high-value-handoff-gate

  **Direction:** egress (`tool_post_invoke`, `input.mode == "output"`)
  **Default:** deny the response on a high-value checkout with no buyer-review surface; allow everything else
  **Package:** `ucp.egress.high_value_handoff_gate`

  ## What it does

  Buyer-side egress gate for Universal Commerce Protocol (UCP) checkouts. On a
  `create_checkout` / `update_checkout` *response* (`input.mode == "output"`), it
  reads the grand total — the `totals[]` entry whose `type == "total"` — and
  compares it against a spending cap supplied by the gateway at
  `input.context.mandate.max_total`. When the order is at or above the cap, the
  policy refuses autonomous completion: it denies the response so your agent
  cannot proceed straight to `complete_checkout`, and it requires that a
  human-reviewable `continue_url` is present so the buyer can finish the purchase
  out of band.

  This governs the agents *you* run. UCP encodes the *state*
  `status == "requires_escalation"` and ships `high_value_order` only as a
  freeform example `code` on a `requires_buyer_review` message — it does not
  encode the *business trigger* that should set that state. This policy is that
  trigger: a gateway-owned threshold check, with the cap injected at
  `input.context.mandate` (gateway-supplied policy input, not a UCP field).

  ## Exactly one grand total

  The grand total is resolved only when the response carries **exactly one**
  `totals[]` entry with `type == "total"` and a numeric `amount`. A totals array
  with zero or multiple `type == "total"` entries is ambiguous, so this policy
  cannot prove the order is high-value and does not gate it here. That ambiguity
  is not a silent pass to a charge: the ingress completion-blocking policies
  (`checkout-spend-cap`, `attribution-disclosure` price leg) fail **closed** on
  the same unresolvable-total condition at `complete_checkout` time, so composing
  this egress gate with them keeps an ambiguous totals array from completing.

  ## Why egress

  The trigger is a fact about the *response* (the priced checkout), so the gate
  runs at `tool_post_invoke`. Denying the response is what stops the agent from
  treating a high-value checkout as safe to auto-complete.

  ## Tool-name match

  The gateway prepends a non-standard server prefix to the OpenRPC operation
  name and commonly slugifies underscores to hyphens when federating tool names
  (`ucp-shop-create-checkout`), so we match the lowercased `input.resource.name`
  against hyphenated, underscored, and collapsed shapes of each op — anchored at
  a `-`/`_` separator — plus the bare un-prefixed name. We deliberately do NOT
  read the tool name from `input.payload.name`.

  ## Examples

  ### Allowed (sub-threshold)

  A `create_checkout` response whose grand total (`4500` minor units) is below
  the gateway-supplied cap (`50000`) passes through: `allow = true`, no reason.

  ### Denied (high value, no review surface)

  An `update_checkout` response whose grand total (`74250`) is at or above the
  cap (`50000`) with no `continue_url` present denies: the agent has a high-value
  checkout it could complete but no human-review surface.

  `allow = false`, `reason` instructs the agent to re-run `update_checkout` so
  the response carries a `continue_url`, then route the buyer to it instead of
  calling `complete_checkout`.

  ### Escalated (high value, review surface present)

  A high-value response *with* a `continue_url` returns `allow = true` (the
  response is well-formed enough to hand back to a human) but still emits an
  escalation `reason` telling the agent not to auto-complete — send the buyer to
  the `continue_url`. Delete the `has_continue_url` allow branch for a hard stop.

  ## Scope and honest limitations

  - **MCP path only.** This sees the checkout response that returns through the
    gateway. What the buyer does after following `continue_url` in a browser is
    off the MCP path and not visible here.
  - **Cap is gateway-supplied.** `input.context.mandate.max_total` is policy
    input the gateway injects, not a UCP field. The buyer's real limits live only
    inside the opaque AP2 SD-JWT (`checkout.ap2.checkout_mandate`); the gateway
    decodes / configures them and hands the cap to the policy.
  - **Single currency.** Both amounts are compared as minor-unit integers; the
    gateway is responsible for currency alignment (it may also pass
    `input.context.mandate.currency` for an out-of-band check).
  - **No identity-based exemptions.** All callers are treated the same. A
    break-glass override would be a separate `allow if` branch gated on
    `input.subject.claims`.
direction: egress
apps:
  - ucp
industries:
  - commerce
bundles:
  - agentic-commerce
schemaVersion: "1.0.0"
minimumGatewayVersion: 1.0.0
---

```rego
package ucp.egress.high_value_handoff_gate

# Deny-by-default for the response: a high-value checkout response must clear
# the threshold check (or carry a present continue_url) before the agent is
# allowed to act on it autonomously.
default allow := false

# This policy only governs the RESPONSE side (egress). On ingress / request
# mode there is nothing to gate here, so allow everything through.
default is_output_mode := false

is_output_mode if {
    input.mode == "output"
}

# Tool-name match. The gateway prepends a non-standard server prefix to the
# OpenRPC operation name and commonly slugifies underscores to hyphens when
# federating tool names ("ucp-shop-create-checkout"), so we match the
# lowercased input.resource.name against hyphenated, underscored, and
# collapsed shapes of each op — anchored at a "-"/"_" separator — plus the
# bare un-prefixed name. We deliberately do NOT read the tool name from
# input.payload.name.
create_checkout_shapes := {
    "create_checkout",
    "create-checkout",
    "createcheckout",
}

update_checkout_shapes := {
    "update_checkout",
    "update-checkout",
    "updatecheckout",
}

tool_matches(shapes) if {
    shapes[lower(object.get(input.resource, "name", ""))]
}

tool_matches(shapes) if {
    name := lower(object.get(input.resource, "name", ""))
    some shape in shapes
    endswith(name, sprintf("-%s", [shape]))
}

tool_matches(shapes) if {
    name := lower(object.get(input.resource, "name", ""))
    some shape in shapes
    endswith(name, sprintf("_%s", [shape]))
}

is_create_checkout if tool_matches(create_checkout_shapes)

is_update_checkout if tool_matches(update_checkout_shapes)

is_checkout_mutation if {
    is_create_checkout
}

is_checkout_mutation if {
    is_update_checkout
}

# The checkout object is returned as the tool RESULT at input.payload.result.
checkout := object.get(input.payload, "result", {})

# Grand total = the single totals[] entry whose type == "total" with a numeric
# amount (a SIGNED INTEGER in the currency minor unit, cents). We index by
# array position, not by amount, so two entries with the same amount still
# count as two — an ambiguous/malformed totals[] must not collapse to one
# "matching" total. grand_total is defined ONLY when there is exactly one such
# entry (the shared exactly-one-total idiom); otherwise it is undefined and the
# response is not treated as provably high-value here.
grand_total_indices contains i if {
    some i, entry in object.get(checkout, "totals", [])
    lower(object.get(entry, "type", "")) == "total"
    is_number(object.get(entry, "amount", null))
}

grand_total := object.get(checkout, "totals", [])[i].amount if {
    count(grand_total_indices) == 1
    some i in grand_total_indices
}

# Threshold is gateway-supplied POLICY INPUT injected at input.context.mandate,
# NOT a UCP field. The buyer's real spending limits live only inside an opaque
# AP2 SD-JWT (checkout.ap2.checkout_mandate); the gateway decodes / configures
# them and hands the cap to the policy here.
mandate := object.get(input.context, "mandate", {})

max_total := object.get(mandate, "max_total", null)

# continue_url is a TOP-LEVEL string on the checkout object (a URI for the buyer
# to finish out of band). Treat empty / missing as "absent".
continue_url := object.get(checkout, "continue_url", "")

has_continue_url if {
    continue_url != ""
}

# A response is "high value" when we have both a numeric cap and a single
# resolvable numeric grand total, and the total is at or above the cap.
is_high_value if {
    is_output_mode
    is_checkout_mutation
    is_number(max_total)
    is_number(grand_total)
    grand_total >= max_total
}

# Pass-through: anything that is not a high-value checkout-mutation response is
# allowed unchanged. This covers ingress mode, other tools, sub-threshold
# orders, ambiguous totals, and responses where the gateway supplied no cap.
allow if {
    not is_high_value
}

# A high-value response is allowed ONLY when the buyer can complete the purchase
# out of band, i.e. a continue_url is present. Even then the escalation reason
# still fires (below) so the agent is told not to auto-complete; allow == true
# here means "the response is well-formed enough to hand back to a human", while
# the reason instructs the agent to escalate rather than call complete_checkout.
# If you want a hard stop instead, delete this rule so high-value always denies.
allow if {
    is_high_value
    has_continue_url
}

# Deny reason: high value AND no continue_url to hand off to a human. This is the
# unsafe case — the agent has a high-value checkout it could complete but no
# review surface, so we block.
reasons contains msg if {
    is_high_value
    not has_continue_url
    msg := sprintf("Checkout grand total (%d minor units) is at or above the approval threshold of %d, and no continue_url is present for buyer review. Autonomous completion is refused; re-run update_checkout so the response carries a continue_url, then route the buyer to it instead of calling complete_checkout.", [grand_total, max_total])
}

# Escalation reason: high value WITH a continue_url. The response is returned,
# but the agent must NOT auto-complete — hand the buyer the continue_url.
reasons contains msg if {
    is_high_value
    has_continue_url
    msg := sprintf("Checkout grand total (%d minor units) is at or above the approval threshold of %d. Do not call complete_checkout autonomously: send the buyer to the continue_url for human review and approval (UCP status requires_escalation / requires_buyer_review).", [grand_total, max_total])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
