---
name: Require Human Approval Above a Purchase Threshold
tags:
  - shopify
  - ucp
  - agentic-commerce
  - checkout
  - approval-gate
  - egress
publishedAt: 2026-06-27
description: |
  Buyer-side egress gate for Universal Commerce Protocol (UCP) checkouts on
  Shopify. On a `create_checkout` / `update_checkout` *response*
  (`input.mode == "output"`), it reads the grand total — the `totals[]` entry
  whose `type == "total"` — and compares it against a spending cap supplied by
  the gateway at `input.context.mandate.max_total`. When the order is at or
  above the cap, the policy refuses autonomous completion: it denies the
  response so your agent cannot proceed straight to `complete_checkout`, and it
  requires that a human-reviewable `continue_url` is present so the buyer can
  finish the purchase out of band.

  This governs the agents *you* run. UCP encodes the *state*
  `status == "requires_escalation"` and ships `high_value_order` only as a
  freeform example `code` on a `requires_buyer_review` message — it does not
  encode the *business trigger* that should set that state. This policy is that
  trigger: a DTwo-owned threshold check, with the cap injected at
  `input.context.mandate` (DTwo-supplied policy input, not a UCP field).
direction: egress
apps:
  - shopify
industries:
  - retail
bundles:
  - agentic-commerce
schemaVersion: "1.0.0"
minimumGatewayVersion: 1.0.0
---

```rego
package shopify.egress.high_value_approval_gate

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
# OpenRPC operation name (e.g. "shopify-mcp-create_checkout"), so we suffix-match
# the lowercased name read from input.resource.name. We deliberately do NOT read
# the tool name from input.payload.name.
is_create_checkout if {
	endswith(lower(input.resource.name), "create_checkout")
}

is_update_checkout if {
	endswith(lower(input.resource.name), "update_checkout")
}

is_checkout_mutation if {
	is_create_checkout
}

is_checkout_mutation if {
	is_update_checkout
}

# The checkout object is returned as the tool RESULT at input.payload.result.
checkout := object.get(input.payload, "result", {})

# Grand total = the entry in the totals[] array whose type == "total". amount is
# a SIGNED INTEGER in the currency minor unit (cents). There is no
# totals.grand_total path; we scan the array. We take the first matching entry.
total_amounts := [t.amount |
	some t in object.get(checkout, "totals", [])
	t.type == "total"
]

grand_total := total_amounts[0] if {
	count(total_amounts) > 0
}

# Threshold is DTwo-supplied POLICY INPUT injected by the gateway at
# input.context.mandate, NOT a UCP field. The buyer's real spending limits live
# only inside an opaque AP2 SD-JWT (checkout.ap2.checkout_mandate); the gateway
# decodes / configures them and hands the cap to the policy here.
mandate := object.get(input.context, "mandate", {})

max_total := object.get(mandate, "max_total", null)

# continue_url is a TOP-LEVEL string on the checkout object (a URI for the buyer
# to finish out of band). Treat empty / missing as "absent".
continue_url := object.get(checkout, "continue_url", "")

has_continue_url if {
	continue_url != ""
}

# A response is "high value" when we have both a numeric cap and a numeric grand
# total, and the total is at or above the cap. Both amounts are in the same
# minor-unit integer space; the gateway is responsible for currency alignment
# (it may also pass input.context.mandate.currency for an out-of-band check).
is_high_value if {
	is_output_mode
	is_checkout_mutation
	is_number(max_total)
	is_number(grand_total)
	grand_total >= max_total
}

# Pass-through: anything that is not a high-value checkout-mutation response is
# allowed unchanged. This covers ingress mode, other tools, sub-threshold
# orders, and responses where the gateway supplied no cap.
allow if {
	not is_high_value
}

# A high-value response is allowed ONLY when the buyer can complete the purchase
# out of band, i.e. a continue_url is present. Even then the deny reason still
# fires (below) so the agent is told not to auto-complete; allow == true here
# means "the response is well-formed enough to hand back to a human", while the
# reason instructs the agent to escalate rather than call complete_checkout.
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
