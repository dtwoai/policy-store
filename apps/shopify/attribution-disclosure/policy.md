---
name: "Shopify/UCP: Internal Routing Disclosure and Price-Equivalence Check"
tags:
  - shopify
  - ucp
  - agentic-commerce
  - attribution
  - checkout
  - governance
  - ingress
publishedAt: 2026-06-27
description: |
  # shopify / attribution-disclosure

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on a `complete_checkout` that is undisclosed or price-mismatched; allow everything else
  **Package:** `shopify.ingress.attribution_disclosure`

  ## What it does

  This is buyer-side governance for an enterprise that operates its own
  routing/aggregation platform across the UCP (Universal Commerce Protocol)
  agents it runs. It governs the agents *you* run — it is not a third-party
  referee imposed between buyer and merchant.

  At ingress, before a `complete_checkout` call reaches the merchant, the policy
  requires two things and denies otherwise:

  1. **Disclosed routing.** `input.payload.args.checkout.attribution` must be
     present and non-empty. `attribution` is UCP's only referral surface (an
     open string-map), so a completed checkout with empty/absent attribution is
     undisclosed routing.
  2. **Price equivalence.** The submitted grand total — the entry in
     `checkout.totals[]` whose `type == "total"` — must equal the price the
     buyer was shown, carried as `input.context.advertised_total`. This catches
     the price changing between what was displayed and what is submitted.

  Any tool other than `complete_checkout` passes through untouched.

  ## What `input.context.advertised_total` is (and is not)

  `input.context.advertised_total` is **DTwo-supplied policy input injected by
  the gateway**, not a UCP field. UCP carries no "price the buyer was shown"
  on the checkout object; the only authoritative price on the wire is the
  submitted `totals[]` grand total. The policy needs an independent reference
  for the displayed price, and the gateway supplies it under `input.context`.

  The buyer's spending caps / budget / velocity constraints also do not exist
  as UCP fields — in UCP they live only inside an opaque AP2 SD-JWT
  (`checkout.ap2.checkout_mandate`). Where this policy references a mandate
  (`input.context.mandate.*`) it is likewise DTwo-supplied, never a UCP field.

  ## Why ingress

  Completing a checkout has permanent side effects (it is a purchase). The only
  place to stop an undisclosed or price-mismatched completion is *before* the
  call reaches the merchant, so the policy runs at `tool_pre_invoke` and denies.

  ## Tool name matching

  The DTwo gateway prepends a non-standard server prefix to UCP tool names
  (e.g. `ucp-acme-complete_checkout`). The policy suffix-matches the OpenRPC op
  name (`endswith(lower(input.resource.name), "complete_checkout")`) so it stays
  portable across gateway naming. The tool name is read from
  `input.resource.name` — never `input.payload.name`. Confirm the exact name your
  gateway emits with the dump-input debug technique before deploying.

  ## UCP fields used

  - **Args** at `input.payload.args` (canonical), checkout under `args.checkout`.
  - **Attribution** at `checkout.attribution` (open string-map).
  - **Grand total** = the `checkout.totals[]` entry where `type == "total"`;
    `amount` is a signed integer in the currency minor unit (cents; `1000` =
    $10.00). There is no `totals.grand_total` and no `totals.tax` path.

  ## Examples

  ### Allowed (disclosed + price matches)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "ucp-acme-complete_checkout", "type": "tool" },
      "payload": {
        "args": {
          "checkout": {
            "attribution": { "dev.acme.route": "aggregator-hub" },
            "totals": [{ "type": "total", "amount": 4999 }]
          }
        }
      },
      "context": { "advertised_total": 4999 }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (price changed between display and submit)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "ucp-acme-complete_checkout", "type": "tool" },
      "payload": {
        "args": {
          "checkout": {
            "attribution": { "dev.acme.route": "aggregator-hub" },
            "totals": [{ "type": "total", "amount": 5999 }]
          }
        }
      },
      "context": { "advertised_total": 4999 }
    }
  }
  ```

  `allow = false`,
  `reason = "Submitted grand total (5999) does not match the price the buyer was shown (4999, minor units). ..."`.

  ## Scope and honest limitations

  - **MCP path only.** The policy sees the MCP tool call. The browser
    `continue_url` handoff (where a buyer finishes a checkout in a hosted page)
    is not visible to it. This governs the agent-driven completion, not a
    human-in-browser completion.
  - **`advertised_total` must be supplied.** Price equivalence can only be
    checked when the gateway injects `input.context.advertised_total`. If it is
    absent the call is denied (cannot-verify), not silently allowed.
  - **Exactly one grand total.** A `totals[]` with zero or multiple
    `type == "total"` entries is treated as unverifiable and denied — an
    ambiguous totals array must not collapse to a single "matching" total.
  - **Single currency assumed.** The check compares minor-unit integers; it
    assumes `advertised_total` is in the same currency as the checkout
    (`checkout.currency`). It does not convert currencies.
  - **DTwo is complementary.** This policy adds buyer-side governance on top of
    UCP and the merchant's own controls. It is not a competing trust-referee.

  ## Composition

  This policy does one job (disclosure + price equivalence on completion). Pair
  it with separate policies for mandate-cap enforcement
  (`input.context.mandate.max_total`), merchant allowlisting, or egress review
  of `complete_checkout` results (`input.mode == "output"`,
  `input.payload.result`).
direction: ingress
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
package shopify.ingress.attribution_disclosure

# Deny-by-default: a complete_checkout call is allowed only when routing
# attribution is disclosed AND the submitted grand total matches the price
# the buyer was shown (carried in DTwo-supplied input.context).
default allow := false

# -----------------------------------------------------------------------------
# Tool name matching.
#
# The DTwo gateway prepends a non-standard server prefix to UCP tool names
# (e.g. "ucp-acme-complete_checkout"), so we suffix-match the OpenRPC op name.
# Confirm the exact name your gateway emits with the dump-input debug technique
# before relying on this in production.
# -----------------------------------------------------------------------------
is_complete_checkout if {
	endswith(lower(input.resource.name), "complete_checkout")
}

# -----------------------------------------------------------------------------
# Attribution disclosure.
#
# `attribution` is UCP's only referral surface: an open string-map on the
# checkout object. We require it to be present and non-empty so that every
# completed checkout this enterprise's own agents submit carries a disclosed
# routing/aggregation trail. An absent or empty map is undisclosed routing.
# -----------------------------------------------------------------------------
checkout := object.get(input.payload.args, "checkout", {})

attribution := object.get(checkout, "attribution", {})

attribution_disclosed if {
	count(attribution) > 0
}

# -----------------------------------------------------------------------------
# Price-equivalence check.
#
# UCP's grand total is the entry in the totals[] array whose type == "total".
# `amount` is a SIGNED INTEGER in the currency minor unit (cents). There is no
# totals.grand_total and no totals.tax path.
#
# `input.context.advertised_total` is the minor-unit price the buyer was shown.
# It is DTwo-supplied policy input injected by the gateway, NOT a UCP field. We
# assert the submitted grand total equals it (price shown == price submitted).
# -----------------------------------------------------------------------------
totals := object.get(checkout, "totals", [])

# Indices of totals[] entries whose type == "total". UCP defines exactly one
# grand total; we index by array position (not by amount) so that two entries
# with the same amount still count as two — an ambiguous/malformed totals[]
# must not collapse to a single "matching" total and silently pass.
grand_total_indices contains i if {
	some i, entry in totals
	object.get(entry, "type", "") == "total"
	is_number(object.get(entry, "amount", null))
}

# The single, well-formed grand-total amount (only defined when there is
# exactly one type=="total" entry with a numeric amount).
grand_total_amount := totals[i].amount if {
	count(grand_total_indices) == 1
	some i in grand_total_indices
}

advertised_total := object.get(input.context, "advertised_total", null)

price_matches if {
	is_number(advertised_total)
	grand_total_amount == advertised_total
}

# -----------------------------------------------------------------------------
# Allow rules.
# -----------------------------------------------------------------------------

# Any tool that is not complete_checkout passes through untouched.
allow if {
	not is_complete_checkout
}

# complete_checkout is allowed only when routing is disclosed AND the price
# the buyer was shown equals the price being submitted.
allow if {
	is_complete_checkout
	attribution_disclosed
	price_matches
}

# -----------------------------------------------------------------------------
# Reasons.
# -----------------------------------------------------------------------------

reasons contains "This checkout is being completed without disclosed routing attribution. Populate checkout.attribution with the referral/aggregation trail before completing. Contact your commerce-governance owner if this needs to change." if {
	is_complete_checkout
	not attribution_disclosed
}

reasons contains msg if {
	is_complete_checkout
	attribution_disclosed
	not price_matches
	is_number(advertised_total)
	count(grand_total_indices) == 1
	msg := sprintf("Submitted grand total (%d) does not match the price the buyer was shown (%d, minor units). The price presented to the buyer and the price submitted must be equal.", [grand_total_amount, advertised_total])
}

reasons contains "Cannot verify price equivalence: the checkout does not carry exactly one totals entry with type == \"total\" (and a numeric amount), or no advertised price was supplied in policy context. Completing a checkout whose grand total cannot be unambiguously verified against the price shown is not permitted." if {
	is_complete_checkout
	attribution_disclosed
	not price_matches
	not single_grand_total_with_advertised
}

single_grand_total_with_advertised if {
	count(grand_total_indices) == 1
	is_number(advertised_total)
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
