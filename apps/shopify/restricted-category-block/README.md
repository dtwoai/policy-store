# Shopify: Block Agent Purchases in Restricted Categories

**Direction:** ingress (`tool_pre_invoke`)
**Package:** `shopify.ingress.restricted_category_block`
**Default:** allow, with targeted denies on checkout/cart writes that contain a restricted category, SKU, or product

## What it does

This is enterprise buyer-side governance: it governs the agents *you* run. An
organization that lets its agents transact over the Universal Commerce Protocol
(UCP) can bar those agents from autonomously buying certain categories — for
example weapons, controlled substances, gift cards, or a named set of
enterprise-restricted SKUs.

The policy is `default allow := true`. It denies a `complete_checkout`,
`update_cart`, or `update_checkout` call only when one of these is present:

1. A line item whose product **id** matches a DTwo-supplied SKU in
   `input.context.restricted_skus`.
2. A line item whose product **title** contains a restricted keyword from the
   configurable `restricted_keywords` set.
3. A `messages[]` **warning** carrying a restricted `code` from the configurable
   `restricted_message_codes` set (e.g. `age_restricted`).

Reads (`get_checkout`, `get_cart`, `search_catalog`, …), non-restricted carts,
and any other tool pass through untouched.

## Why ingress

A completed checkout is irreversible, so the only place to stop a restricted
purchase is *before* the call reaches the merchant. Each violation is fully
determined by the request (tool name + arguments), so an ingress
(`tool_pre_invoke`) deny prevents the purchase from ever executing.
`complete_checkout` is the primary gate; gating `update_cart` /
`update_checkout` as well catches a restricted item when it is added rather than
only at the final commit.

## Scope — what is and is not visible

DTwo sits on the **MCP path** only. It sees the tool calls your agent makes
through the gateway. It does **not** see a browser `continue_url` handoff: if a
checkout is finished by a human in a browser tab, that step is outside the
gateway and outside this policy. This is an agent-autonomy guardrail, not a
guarantee that a restricted item can never be purchased by any route.

DTwo is **complementary** to UCP and to Shopify, not a competing trust referee.
The merchant still authorizes the order, Shopify still owns the catalog, and UCP
still defines the wire shapes. This policy only decides whether *your* agent is
allowed to push the call.

## `input.context.*` is DTwo-supplied, not a UCP field

The buyer's spending limits, budgets, velocity, and allow/deny lists **do not
exist as UCP fields**. In UCP those constraints live only inside an opaque AP2
SD-JWT (`checkout.ap2.checkout_mandate`) that the gateway cannot read as plain
JSON. So any cap or list this policy consults is **policy input that DTwo
injects** at `input.context`, never something parsed out of the UCP payload:

| Path | Source | Meaning |
|---|---|---|
| `input.context.restricted_skus` | **DTwo-supplied** | array of exact product ids / SKUs the org bars |

Treat `input.context.*` as administrator-configured policy data, never as a
buyer-asserted UCP field. The buyer cannot set it.

## UCP fields read (confirmed paths only)

Every field is read defensively with `object.get(...)` so a missing value falls
through to allow rather than erroring.

| What | Path | Notes |
|---|---|---|
| Tool name | `input.resource.name` | lowercased, matched against hyphenated / underscored / collapsed shapes of the OpenRPC op (plus bare names); gateways prepend a non-standard server prefix and commonly slugify underscores to hyphens (`ucp-shop-complete-checkout`). Never `input.payload.name`. |
| Tool args | `input.payload.args` | checkout object under `args.checkout` (canonical); flattened top-level args kept as fallback |
| Line items | `args.checkout.line_items[]` (fallback: `args.line_items[]`) | `{ id, item, quantity, totals }`; `item` = `{ id, title, price, image_url? }`, `price` is signed-int minor units (cents) |
| Messages | `args.checkout.messages[]` (fallback: `args.messages[]`) | `oneOf` error \| warning \| info on the `type` const; `code` / `error_code` freeform; `severity` only on `error` |
| Principal | `input.subject.claims` | for optional break-glass branches; never `is_admin` / `teams` / `user` |

Notes on UCP shapes this policy intentionally does **not** invent:
`totals` is an **array** of `{ type, amount, display_text? }` (grand total is the
`type == "total"` entry; there is no `totals.grand_total` / `totals.tax`);
`continue_url` is a top-level string; `currency` is a single top-level
ISO-4217 string; `buyer` is flat snake_case with no single `name` and no
address (postal address reaches checkout via `fulfillment.methods[].destinations[]`).

## Configuration

Edit two sets at the top of the Rego; the exact-id list is supplied per-tenant.

- `restricted_keywords` — lowercase substrings matched against each
  `item.title` (shipped placeholders: `firearm`, `ammunition`, `gift card`).
- `restricted_message_codes` — lowercase `messages[].code` values that, on a
  `warning`, force a deny (shipped placeholder: `age_restricted`).
- The exact-id / SKU list is **not** in the Rego. DTwo supplies it per tenant at
  `input.context.restricted_skus`, so one policy body serves every tenant.

## Tests

- [`tests/deny.json`](./tests/deny.json) — `complete_checkout` whose
  `checkout.line_items[].item.id` matches `input.context.restricted_skus`;
  expect `allow = false` with the item id named in the reason.
- [`tests/deny-slugified.json`](./tests/deny-slugified.json) — the same
  restricted SKU via a federated, slugified tool name
  (`ucp-shop-complete-checkout`); expect `allow = false`.
- [`tests/deny-top-level-args.json`](./tests/deny-top-level-args.json) — the
  flattened fallback shape (`line_items` at the top level of `args`); expect
  `allow = false`.
- [`tests/allow.json`](./tests/allow.json) — `complete_checkout` with only
  ordinary items and no restricted SKU, title keyword, or warning; expect
  `allow = true`.

The test JSON wraps the PARC object under a top-level `input` key plus an
`expected` hint. A verifier must unwrap `.input` before evaluating — a naive
`opa eval -i tests/deny.json` double-nests the document (`input.input.…`) and
fails open.

## Composition

Part of the [`agentic-commerce`](../../../bundles/agentic-commerce/README.md)
bundle. Useful companions:

- A spend-cap policy that reads a DTwo-supplied `input.context.mandate.max_total`
  (again, DTwo-supplied policy input mirroring the opaque AP2 mandate — not a UCP
  field) to enforce per-order budgets.
- An egress policy that redacts buyer PII from tool results.

## Known limitations

- **Browser handoff is invisible.** A checkout completed via a `continue_url` in
  a human's browser does not pass through the gateway, so this policy cannot gate
  it. Use it for autonomous agent purchases.
- **Keyword matching is substring-based** and can over- or under-match. Prefer
  the exact-id `restricted_skus` list where the catalog gives you stable SKUs;
  treat keywords as a coarse backstop.
- **No identity-based exemptions.** All callers are treated the same. To add a
  break-glass purchaser, gate a separate `allow if` branch on
  `input.subject.claims`.
- **Only the configured write tools are gated.** If your Shopify MCP server
  exposes another mutating checkout/cart tool, add its name shapes to
  `write_tool_shapes`.
