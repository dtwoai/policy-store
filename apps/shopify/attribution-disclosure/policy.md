---
name: "Shopify/UCP: Internal Routing Disclosure and No-Overcharge Check"
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
  **Default:** deny on a `complete_checkout` that is undisclosed or overcharged; allow everything else
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
  2. **No overcharge.** The submitted grand total — the entry in
     `checkout.totals[]` whose `type == "total"` — must not **exceed** the
     price the buyer was shown, carried as
     `input.context.advertised_total`. The guarantee is that the buyer is
     never charged *more* than they were shown. A submitted total **lower**
     than the advertised one (a coupon, a promo, a merchant repricing down)
     is allowed — denying it would punish the buyer for getting a better
     deal.

  Any tool other than `complete_checkout` passes through untouched.

  This policy deliberately owns only the overcharge direction. Cart-content
  tampering (swapped SKUs, injected items) is `approved-cart-integrity`'s
  job, and the absolute upper bound on spend is `checkout-spend-cap`'s —
  composing the three covers content, ceiling, and overcharge without
  double-owning any of them. Deployments that want a strict any-drift
  stance (deny on *any* difference, lower included) can get it with a
  one-comparison change: replace the `<=` in `not_overcharged` with `==`.

  ## What `input.context.advertised_total` is (and is not)

  `input.context.advertised_total` is **DTwo-supplied policy input injected by
  the gateway**, not a UCP field. UCP carries no "price the buyer was shown"
  on the checkout object; the only authoritative price on the wire is the
  submitted `totals[]` grand total. The policy needs an independent reference
  for the displayed price to bound the charge, and the gateway supplies it
  under `input.context`.

  The buyer's spending caps / budget / velocity constraints also do not exist
  as UCP fields — in UCP they live only inside an opaque AP2 SD-JWT
  (`checkout.ap2.checkout_mandate`). Where this policy references a mandate
  (`input.context.mandate.*`) it is likewise DTwo-supplied, never a UCP field.

  ## Why ingress

  Completing a checkout has permanent side effects (it is a purchase). The only
  place to stop an undisclosed or overcharged completion is *before* the
  call reaches the merchant, so the policy runs at `tool_pre_invoke` and denies.

  ## Tool name matching

  The DTwo gateway prepends a non-standard server prefix to UCP tool names and
  commonly slugifies underscores to hyphens when federating them (e.g.
  `ucp-acme-complete-checkout`). The policy matches the lowercased
  `input.resource.name` against hyphenated (`-complete-checkout`), underscored
  (`-complete_checkout`), and collapsed (`-completecheckout`) suffix shapes of
  the OpenRPC op, plus the bare un-prefixed names, so it stays portable across
  gateway naming. The tool name is read from `input.resource.name` — never
  `input.payload.name`. Confirm the exact name your gateway emits with the
  dump-input debug technique before deploying.

  ## UCP fields used

  - **Args** at `input.payload.args` (canonical), checkout under `args.checkout`.
  - **Attribution** at `checkout.attribution` (open string-map).
  - **Grand total** = the `checkout.totals[]` entry where `type == "total"`;
    `amount` is a signed integer in the currency minor unit (cents; `1000` =
    $10.00). There is no `totals.grand_total` and no `totals.tax` path.

  ## Examples

  ### Allowed (disclosed + not overcharged)

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

  ### Denied (charged more than the buyer was shown)

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
  `reason = "Submitted grand total (5999) exceeds the price the buyer was shown (4999, minor units). ..."`.

  A submitted grand total of `4499` against the same `advertised_total: 4999`
  (a discount applied between display and submit) is **allowed**.

  ## Scope and honest limitations

  - **MCP path only.** The policy sees the MCP tool call. The browser
    `continue_url` handoff (where a buyer finishes a checkout in a hosted page)
    is not visible to it. This governs the agent-driven completion, not a
    human-in-browser completion.
  - **`advertised_total` must be supplied.** The overcharge check can only be
    performed when the gateway injects `input.context.advertised_total`. If it
    is absent the call is denied (cannot-verify), not silently allowed.
  - **Overcharge only, by design.** A submitted total lower than the
    advertised one is allowed. Cart-content tampering is
    `approved-cart-integrity`'s job and the absolute spend ceiling is
    `checkout-spend-cap`'s; this policy owns only the overcharge direction.
    A strict any-drift stance is a one-comparison change (`<=` to `==` in
    `not_overcharged`).
  - **Exactly one grand total.** A `totals[]` with zero or multiple
    `type == "total"` entries is treated as unverifiable and denied — an
    ambiguous totals array must not collapse to a single "matching" total.
  - **Single currency assumed.** The check compares minor-unit integers; it
    assumes `advertised_total` is in the same currency as the checkout
    (`checkout.currency`). It does not convert currencies.
  - **DTwo is complementary.** This policy adds buyer-side governance on top of
    UCP and the merchant's own controls. It is not a competing trust-referee.

  ## Composition

  This policy does one job (disclosure + no-overcharge on completion). Pair
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
# attribution is disclosed AND the submitted grand total does not exceed the
# price the buyer was shown (carried in DTwo-supplied input.context).
default allow := false

# -----------------------------------------------------------------------------
# Tool name matching.
#
# The DTwo gateway prepends a non-standard server prefix to UCP tool names and
# commonly slugifies underscores to hyphens when federating them
# ("ucp-acme-complete-checkout"), so the underscored form alone would never
# match there. Match hyphenated, underscored, and collapsed shapes of the
# OpenRPC op, anchored at a "-"/"_" separator, plus the bare un-prefixed name.
# Confirm the exact name your gateway emits with the dump-input debug technique
# before relying on this in production.
# -----------------------------------------------------------------------------
complete_checkout_shapes := {
	"complete_checkout",
	"complete-checkout",
	"completecheckout",
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

is_complete_checkout if tool_matches(complete_checkout_shapes)

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
# No-overcharge check.
#
# UCP's grand total is the entry in the totals[] array whose type == "total".
# `amount` is a SIGNED INTEGER in the currency minor unit (cents). There is no
# totals.grand_total and no totals.tax path.
#
# `input.context.advertised_total` is the minor-unit price the buyer was shown.
# It is DTwo-supplied policy input injected by the gateway, NOT a UCP field. We
# assert the submitted grand total does not EXCEED it: the buyer must never be
# charged more than they were shown. A lower submitted total (coupon, promo,
# merchant repricing down) is allowed. Cart-content tampering is
# approved-cart-integrity's job and the absolute ceiling is
# checkout-spend-cap's, so this policy owns only the overcharge direction.
# For a strict any-drift stance, change the `<=` below to `==`.
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

not_overcharged if {
	is_number(advertised_total)
	grand_total_amount <= advertised_total
}

# -----------------------------------------------------------------------------
# Allow rules.
# -----------------------------------------------------------------------------

# Any tool that is not complete_checkout passes through untouched.
allow if {
	not is_complete_checkout
}

# complete_checkout is allowed only when routing is disclosed AND the
# submitted total does not exceed the price the buyer was shown.
allow if {
	is_complete_checkout
	attribution_disclosed
	not_overcharged
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
	is_number(advertised_total)
	count(grand_total_indices) == 1
	grand_total_amount > advertised_total
	msg := sprintf("Submitted grand total (%d) exceeds the price the buyer was shown (%d, minor units). The buyer must not be charged more than the advertised total.", [grand_total_amount, advertised_total])
}

reasons contains "Cannot verify the submitted total against the price shown: the checkout does not carry exactly one totals entry with type == \"total\" (and a numeric amount), or no advertised price was supplied in policy context. Completing a checkout whose grand total cannot be unambiguously checked against the price shown is not permitted." if {
	is_complete_checkout
	attribution_disclosed
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
