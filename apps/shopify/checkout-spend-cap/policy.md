---
name: Shopify Checkout Spend Cap
tags:
  - shopify
  - ucp
  - agentic-commerce
  - checkout
  - spend-cap
  - governance
  - ingress
publishedAt: 2026-06-27
description: |
  # shopify / checkout-spend-cap

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `shopify.ingress.checkout_spend_cap`

  ## What it does

  Enforces a per-mandate **spend cap** on the moment an agent tries to finalize a
  purchase. When the agent calls `complete_checkout`, the policy reads the grand
  total from the checkout payload, compares it to a policy-supplied ceiling
  (`input.context.mandate.max_total`), and **denies** the call when the total
  exceeds the cap. It also asserts that the checkout currency matches the
  mandate's currency, so a cap denominated in one currency cannot be silently
  satisfied by a total in another.

  Every other tool — `create_checkout`, `get_checkout`, `update_checkout`,
  `cancel_checkout`, cart and catalog calls, order/product reads — passes through
  unchanged. Only the terminal, money-moving step is gated.

  ## Why ingress

  `complete_checkout` is the irreversible, money-moving step in the Universal
  Commerce Protocol (UCP) flow: it is what turns a priced, ready checkout into a
  charge. The spend decision is fully determined by the request payload (the
  checkout totals and currency) and the policy input (the mandate cap), so
  denying at ingress stops the charge before it is ever submitted to the
  merchant. Earlier steps (`create_checkout`, `update_checkout`) only build and
  price the cart; blocking them would be premature.

  ## Where the numbers come from

  - **Total.** UCP carries the grand total in
    `input.payload.args.checkout.totals`, an array of
    `{type, amount, display_text?}` entries. The grand total is the entry whose
    `type == "total"`. `amount` is a **signed integer in the currency's minor
    unit** (cents): `139000` means `$1,390.00`. There is no `totals.grand_total`
    and no `totals.tax` field — only this array.
  - **Currency.** UCP carries a single top-level ISO-4217 string at
    `input.payload.args.checkout.currency` (e.g. `USD`).
  - **The cap is DTwo policy input, not a UCP field.** A buyer's spending limits
    do not exist as UCP checkout fields — in UCP they live only inside an opaque
    AP2 SD-JWT (`checkout.ap2.checkout_mandate`) that a Rego policy cannot read.
    DTwo therefore injects the enforceable cap as **policy input** at
    `input.context.mandate`: `max_total` (integer minor units) and `currency`
    (ISO-4217). These are **supplied by the DTwo gateway**, not asserted by the
    buyer and not part of the UCP wire format.

  ## How it matches

  A call is denied when **both** hold:

  - **Tool match.** The lowercased `input.resource.name` ends with
    `complete_checkout`. The gateway prepends a (non-standard) MCP server prefix
    to tool names, so the policy suffix-matches the OpenRPC operation name rather
    than hard-coding a server prefix. The tool name is read from
    `input.resource.name` — never from `input.payload.name`.
  - **Over cap or wrong currency.** Either the grand-total `amount` is greater
    than `input.context.mandate.max_total`, or the checkout currency does not
    equal `input.context.mandate.currency` (case-insensitive).

  If no mandate cap is supplied (`input.context.mandate.max_total` is absent),
  the policy fails closed for `complete_checkout`: with no ceiling to enforce, a
  spend-cap gate that let the charge through would be no gate at all.

  ## Human-readable reason

  On denial the policy emits a reason a person can act on, e.g.:

  > This purchase totals $1,390.00 but the agent's limit is $1,200.00.

  or, on a currency mismatch:

  > Checkout currency EUR does not match the agent's mandate currency USD.

  ## Examples

  ### Travel & expense (under a $1,200 cap)

  A travel agent books a flight for `$980.00` (`98000` minor units) with a
  mandate of `max_total: 120000`, `currency: USD`. The total is under the cap and
  the currency matches, so `complete_checkout` is allowed.

  ### Procurement (PO ceiling exceeded)

  A procurement agent tries to complete an order totalling `$1,390.00`
  (`139000`) against a purchase-order ceiling of `max_total: 120000`. The total
  exceeds the ceiling, so the call is denied with the reason above and the charge
  never reaches the merchant.

  ## Tool naming on the gateway

  DTwo prefixes tool names with the MCP server name configured on the gateway, so
  a UCP/Shopify server registered as `shopify` surfaces `shopify-complete_checkout`
  (or similar) while another registration surfaces a different prefix. This policy
  matches on the **suffix** (`complete_checkout`) to stay portable. Confirm the
  exact tool name your gateway sends with the dump-input debug technique before
  deploying.

  ## Scope and honest limits

  - **Buyer-side governance, MCP path only.** This is enterprise buyer-side
    governance — it governs the agents *you* run, on the MCP calls those agents
    make through the DTwo gateway. It does **not** see the browser
    `continue_url` handoff: if a checkout is finalized in a hosted browser flow
    rather than via `complete_checkout` over MCP, this policy is not on that
    path.
  - **Complementary to UCP / Shopify.** DTwo does not replace UCP's or the
    merchant's own trust and risk controls and is not a competing trust-referee;
    it is an additional enterprise control on the agent traffic you operate.
  - **Cap is only as good as the injected mandate.** The ceiling is whatever the
    gateway places at `input.context.mandate`. The policy does not parse the AP2
    SD-JWT itself; deriving `max_total`/`currency` from the mandate is the
    gateway's job.
  - **Single currency, single cap.** One cap per call. The policy does not do
    cross-currency conversion: a mismatch is a denial, not a conversion.
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
package shopify.ingress.checkout_spend_cap

default allow := false

# Pass through every tool that is not complete_checkout.
allow if {
	not is_complete_checkout
}

# Allow complete_checkout only when it is within cap and the currency matches.
allow if {
	is_complete_checkout
	not over_cap
	not currency_mismatch
}

is_complete_checkout if {
	endswith(lower(object.get(input.resource, "name", "")), "complete_checkout")
}

# The checkout object carried in the tool arguments.
checkout := object.get(object.get(input.payload, "args", {}), "checkout", {})

# Mandate is DTwo-supplied policy input at input.context, not a UCP field.
mandate := object.get(input.context, "mandate", {})

# Grand total = the totals[] entry where type == "total"; amount is a signed
# integer in the currency minor unit (cents).
total_amount := amount if {
	some entry in object.get(checkout, "totals", [])
	lower(object.get(entry, "type", "")) == "total"
	amount := object.get(entry, "amount", null)
	is_number(amount)
}

cap := object.get(mandate, "max_total", null)

over_cap if {
	is_complete_checkout
	is_number(cap)
	is_number(total_amount)
	total_amount > cap
}

# Fail closed: completing a checkout with no enforceable cap is a denial.
over_cap if {
	is_complete_checkout
	not is_number(cap)
}

currency_mismatch if {
	is_complete_checkout
	mandate_currency := object.get(mandate, "currency", null)
	is_string(mandate_currency)
	checkout_currency := object.get(checkout, "currency", "")
	lower(checkout_currency) != lower(mandate_currency)
}

reasons contains msg if {
	over_cap
	is_number(cap)
	is_number(total_amount)
	msg := sprintf(
		"This purchase totals %s but the agent's limit is %s.",
		[money(total_amount), money(cap)],
	)
}

reasons contains "Completing a checkout requires a spend cap, but no mandate limit was supplied to the policy." if {
	over_cap
	not is_number(cap)
}

reasons contains msg if {
	currency_mismatch
	mandate_currency := object.get(mandate, "currency", "")
	checkout_currency := object.get(checkout, "currency", "")
	msg := sprintf(
		"Checkout currency %s does not match the agent's mandate currency %s.",
		[upper(checkout_currency), upper(mandate_currency)],
	)
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat(" ", reason_list)
}

# Render integer minor units (cents) as a $-grouped decimal string,
# e.g. 139000 -> "$1,390.00".
money(cents) := out if {
	whole := floor(cents / 100)
	frac := cents - (whole * 100)
	out := sprintf("$%s.%02d", [group(whole), frac])
}

# Insert thousands separators into a non-negative integer, without recursion:
# reverse the digit string, chunk every 3, comma-join, then reverse back.
group(n) := s if {
	digits := sprintf("%d", [n])
	rev := reverse_str(digits)
	chunks := [chunk |
		some i in numbers.range(0, count(rev) - 1)
		i % 3 == 0
		chunk := substring(rev, i, 3)
	]
	s := reverse_str(concat(",", chunks))
}

reverse_str(x) := out if {
	chars := split(x, "")
	n := count(chars)
	out := concat("", [c |
		some i in numbers.range(0, n - 1)
		c := chars[(n - 1) - i]
	])
}
```
