# shopify / checkout-spend-cap

Deny `complete_checkout` when the checkout total exceeds a policy-supplied
spend cap (and when the checkout currency does not match the cap's currency).
Every other tool passes through unchanged.

- **Direction:** ingress (`tool_pre_invoke`)
- **Package:** `shopify.ingress.checkout_spend_cap`
- **Default:** `allow := false`; the policy explicitly allows everything except
  an over-cap or wrong-currency `complete_checkout`.

## What problem this solves

This is **enterprise buyer-side governance** — it governs the AI agents *you*
run. When one of your agents drives a Universal Commerce Protocol (UCP) /
Shopify checkout through the DTwo gateway and reaches the terminal, money-moving
step (`complete_checkout`), this policy enforces a per-mandate ceiling on how
much it is allowed to spend. It frames two common cases:

- **Travel & expense.** A travel agent may book up to, say, `$1,200.00`. A
  `$980.00` flight goes through; a `$1,390.00` one is denied.
- **Procurement.** A purchasing agent is bound to a purchase-order ceiling. A
  total above the PO ceiling is denied before the charge is submitted to the
  merchant.

## Where the cap comes from — and what it is *not*

A buyer's spending limits **do not exist as UCP checkout fields.** In UCP they
live only inside an opaque AP2 SD-JWT (`checkout.ap2.checkout_mandate`), which a
Rego policy cannot read. So DTwo injects the enforceable cap as **policy input**
at `input.context.mandate`:

| Policy input                         | Meaning                                            |
| ------------------------------------ | -------------------------------------------------- |
| `input.context.mandate.max_total`    | Spend ceiling, integer **minor units** (cents).    |
| `input.context.mandate.currency`     | ISO-4217 currency the cap is denominated in.       |

> `input.context.mandate.*` is **DTwo-supplied policy input**, not a UCP wire
> field and not buyer-asserted. Deriving these values from the AP2 mandate is
> the gateway's job; the policy only consumes them.

## What the policy reads from UCP

| Source                                            | Used for                                            |
| ------------------------------------------------- | --------------------------------------------------- |
| `input.resource.name` (lowercased, shape-match)  | Tool identity — must match a known shape of `complete_checkout` (hyphenated / underscored / collapsed suffix, or the bare name).  |
| `input.payload.args.checkout.totals[]`            | Array of `{type, amount, display_text?}`. The grand total is the entry where `type == "total"`. |
| `…totals[].amount` (signed integer, minor units)  | The amount compared to the cap. `139000` = `$1,390.00`. |
| `input.payload.args.checkout.currency`            | Top-level ISO-4217 string, compared to the mandate currency. |

There is no `totals.grand_total` and no `totals.tax` path — the grand total is
read from the `type == "total"` array entry, and `amount` is a signed integer in
the currency's minor unit. The tool name is read from `input.resource.name`,
never from `input.payload.name`.

## Decision logic

`complete_checkout` is **denied** when either condition holds:

1. **Over cap.** The grand-total `amount` is greater than
   `input.context.mandate.max_total`. (At exactly the cap is allowed.)
2. **Currency mismatch.** `checkout.currency` does not equal
   `input.context.mandate.currency` (case-insensitive). The policy does not
   convert currencies; a mismatch is a denial.

If `complete_checkout` is called but **no cap was supplied**
(`input.context.mandate.max_total` absent), the policy **fails closed** and
denies: a spend gate with no ceiling would be no gate at all.

Every non-`complete_checkout` tool — `create_checkout`, `get_checkout`,
`update_checkout`, `cancel_checkout`, the cart tools, the catalog tools,
`get_order`, `get_product` — passes through unchanged.

### Reason text

Denials carry a reason a person can act on:

- Over cap: `This purchase totals $1,390.00 but the agent's limit is $1,200.00.`
- Currency mismatch: `Checkout currency EUR does not match the agent's mandate currency USD.`
- No cap supplied: `Completing a checkout requires a spend cap, but no mandate limit was supplied to the policy.`

## Tool naming on the gateway

The DTwo gateway prepends a (non-standard) MCP server prefix to tool names, and
federated names are commonly slugified — underscores become hyphens — so a
UCP/Shopify server registered as `ucp-shop` surfaces
`ucp-shop-complete-checkout`, while a direct deployment may surface
`shopify-complete_checkout` or the bare `complete_checkout`. This policy matches
hyphenated (`-complete-checkout`), underscored (`-complete_checkout`), and
collapsed (`-completecheckout`) suffix shapes plus the bare un-prefixed names,
so it stays portable across server registrations (verified end-to-end behind a
live gateway). Confirm the exact tool name your gateway sends with the
dump-input debug technique before deploying.

## Scope and honest limits

- **MCP path only.** The policy sees the agent's MCP calls through the DTwo
  gateway. It does **not** see the browser `continue_url` handoff: a checkout
  finalized in a hosted browser flow rather than via `complete_checkout` over
  MCP is not on this path.
- **Complementary, not a trust-referee.** DTwo does not replace UCP's or the
  merchant's own risk and trust controls and is not a competing trust-referee.
  This is an additional enterprise control on the agent traffic you operate.
- **As good as the injected mandate.** The ceiling is whatever the gateway
  places at `input.context.mandate`. The policy does not parse the AP2 SD-JWT.
- **One cap, one currency, one call.** No cross-currency conversion; a mismatch
  is a denial, not a conversion.

## Tests

| Fixture             | Scenario                                                        | Expected |
| ------------------- | --------------------------------------------------------------- | -------- |
| `tests/allow.json`  | T&E: `$980.00` flight under a `$1,200.00` USD cap.              | `allow = true` |
| `tests/deny.json`   | Procurement: `$1,390.00` order over a `$1,200.00` PO ceiling.  | `allow = false`, reason names both amounts |
| `tests/deny-slugified.json` | The same over-cap order via a federated, slugified tool name (`ucp-shop-complete-checkout`). | `allow = false`, reason names both amounts |

Each fixture wraps the PARC object under a top-level `input` key plus an
`expected` hint. Unwrap `.input` before feeding it to `opa eval` against the
policy (`data.shopify.ingress.checkout_spend_cap`) — evaluating the file as-is
double-nests `input` and fails open.

## Identity claims

This policy does not require any specific IdP claims. The agent principal is
available at `input.subject.claims` if you want to add identity-based exemptions
(e.g. a break-glass approver) via an additional `allow if` branch gated on
`object.get(input.subject.claims, "<claim>", "<default>")`.
