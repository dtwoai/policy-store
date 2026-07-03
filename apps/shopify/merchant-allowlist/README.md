# shopify / merchant-allowlist

Restrict Agent Checkout to Approved Merchants.

**Direction:** ingress (`tool_pre_invoke`)
**Default:** deny on match, allow otherwise
**Package:** `shopify.ingress.merchant_allowlist`

## What this is

This is **enterprise buyer-side governance** for agentic commerce: it governs
the agents *you* run. When an agent in your organization drives a UCP checkout
through a DTwo-mediated MCP path, this policy denies `complete_checkout` unless
the merchant the checkout is being completed with is on a buyer-supplied
allowlist. A compromised, confused, or over-eager agent therefore cannot push
spend through a merchant your organization has not approved.

DTwo is complementary to UCP and Shopify here — it adds the buyer's own
preference layer on top of the rails. It is not a competing trust-referee for
the merchant relationship and does not replace any merchant-side or
marketplace control.

## How it works

A call is denied only when **both** of these hold:

1. **It is the checkout-completion tool.** The lowercased `input.resource.name`
   matches a known shape of `complete_checkout` — hyphenated
   (`-complete-checkout`), underscored (`-complete_checkout`), or collapsed
   (`-completecheckout`) suffixes, plus the bare un-prefixed names. The gateway
   prepends a non-standard server prefix and commonly slugifies underscores to
   hyphens when federating tool names (e.g. `ucp-shop-complete-checkout`). The
   tool name is read **only** from `input.resource.name` — never from
   `input.payload.name`.
2. **The merchant is not approved.** The resolved merchant
   (`input.context.merchant`) is not present in the allowlist at
   `input.context.mandate.merchant_allowlist`.

Every other UCP tool — `create_checkout`, `get_checkout`, `update_checkout`,
`cancel_checkout`, `create_cart`, `get_cart`, `update_cart`, `cancel_cart`,
`search_catalog`, `lookup_catalog`, `get_order`, `get_product` — passes
through untouched, as does any non-UCP tool the gateway routes.

If no merchant is resolved (`input.context.merchant` missing or empty), the
call is **denied** — the policy fails closed rather than completing an
unattributed checkout.

## `input.context.*` is DTwo-supplied policy input, not UCP

This is the most important thing to understand about this policy.

The buyer's spending, budget, velocity, and merchant-preference constraints
**do not exist as UCP fields**. In UCP they live only inside an opaque AP2
SD-JWT carried at `checkout.ap2.checkout_mandate`, which a Rego policy cannot
read. So the two values this policy reads:

- `input.context.merchant` — the gateway's **resolved merchant identity** for
  the checkout, and
- `input.context.mandate.merchant_allowlist` — the buyer's **approved-merchant
  set**, derived from the buyer's AP2 mandate,

are both **injected by the DTwo gateway as policy input**. They are not fields
on the UCP checkout object, and you will not find them in the UCP schema. The
policy trusts the gateway's resolved `input.context.merchant`; it does not
re-derive the merchant from UCP fields.

## Identity authentication vs. buyer preference

UCP namespace-binding authenticates *which* merchant a checkout belongs to — it
proves the merchant's identity. It does **not** enforce a *buyer's* preference
about which merchants are acceptable. That preference is exactly what this
policy supplies on the buyer side: given the gateway's authenticated/resolved
merchant identity, it enforces the buyer's own approved-merchant list. The two
mechanisms are complementary; one is "who is this merchant", the other is "does
this buyer allow that merchant".

## Mapping to enterprise spend programs

The allowlist is the generic mechanism; what the list *means* is set by the
buyer mandate the gateway injects:

- **Travel & expense (T&E).** `merchant_allowlist` is the set of approved
  carriers / booking providers an employee agent may complete a checkout with.
- **Procurement.** `merchant_allowlist` is the set of approved vendors a
  procurement agent may purchase from.

One policy, one job: this does not enforce spend caps, currencies, item
categories, or any other mandate dimension. Pair it with the matching cap and
currency policies in the same bundle for those checks.

## Tests

| Case ([`tests.yaml`](./tests.yaml)) | Scenario | Expected |
| --- | --- | --- |
| `allow` | `complete_checkout` whose resolved merchant is on the allowlist | `allow = true` |
| `deny` | `complete_checkout` whose resolved merchant is not on the allowlist | `allow = false`, reason names the merchant |
| `deny-slugified` | The same unapproved merchant via a federated, slugified tool name (`ucp-shop-complete-checkout`) | `allow = false`, reason names the merchant |

Each fixture wraps the PARC object under a top-level `input` key. A verifier
must unwrap `.input` before evaluating, or a naive `opa eval` double-nests the
data under `input.input` and the policy fails open.

## Known limitations

- **MCP path only.** This governs `complete_checkout` calls that flow through
  the DTwo-mediated MCP path. UCP also supports a browser handoff via the
  checkout `continue_url`; a completion driven by the buyer through that
  redirect is not visible to this policy and is not governed by it. Only the
  MCP path is in scope.
- **`input.context` is gateway-injected.** Both `input.context.merchant` and
  `input.context.mandate.merchant_allowlist` must be populated by the gateway.
  If they are not, the policy fails closed (denies). They are not UCP fields.
- **Exact-match allowlist.** Merchant matching is exact against the supplied
  list — no wildcards or extra normalization beyond what the gateway resolves.
  The mandate must use the same merchant identifiers the gateway resolves into
  `input.context.merchant`.
- **Trusts the resolved identity.** The policy trusts the gateway's
  `input.context.merchant`; it does not independently re-verify the merchant's
  UCP namespace binding.
- **No identity-based exemptions.** All callers get the same allowlist. To add a
  break-glass role, gate an extra `allow if` branch on `input.subject.claims`
  (the principal is `input.subject.claims` — never `is_admin`, `teams`, or
  `user`).

## Compatibility

`minimumGatewayVersion: 1.0.0`. This is a stateless ingress policy — it reads
only the current request (`input.resource`, `input.payload`, `input.context`,
`input.subject`) and does not require session state.
