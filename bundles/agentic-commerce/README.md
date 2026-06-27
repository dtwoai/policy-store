# Agentic Commerce

Buyer-side egress controls for enterprises whose AI agents discover and purchase from merchants over the [Universal Commerce Protocol (UCP)](https://ucp.dev).

The merchant side — fraud, payment, PII handling, scope, trust-tier — stays with the commerce platform (e.g. Shopify), server-side. This bundle is the layer an enterprise puts on **the agents it operates**, on the MCP path out: which merchants and tools they may call, org-level spend and data-egress limits beyond a single consent mandate, and per-call Rego on tool arguments and results.

Canonical policy bodies live under [`apps/shopify/`](../../apps/shopify/README.md); this page only curates them.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [checkout-spend-cap](../../apps/shopify/checkout-spend-cap/policy.md) | shopify | ingress | Deny `complete_checkout` over an org-supplied spend cap |
| [merchant-allowlist](../../apps/shopify/merchant-allowlist/policy.md) | shopify | ingress | Deny completion to a merchant not on the approved list |
| [cumulative-spend-ceiling](../../apps/shopify/cumulative-spend-ceiling/policy.md) | shopify | ingress · stateful | Running spend across a session vs. an org budget |
| [approved-cart-integrity](../../apps/shopify/approved-cart-integrity/policy.md) | shopify | ingress · stateful | Bind completion to the human-approved cart |
| [order-pii-egress-redaction](../../apps/shopify/order-pii-egress-redaction/policy.md) | shopify | egress | Redact buyer PII from order/checkout responses |
| [high-value-approval-gate](../../apps/shopify/high-value-approval-gate/policy.md) | shopify | egress | Require human approval above a threshold |
| [restricted-category-block](../../apps/shopify/restricted-category-block/policy.md) | shopify | ingress | Block restricted categories / SKUs |
| [attribution-disclosure](../../apps/shopify/attribution-disclosure/policy.md) | shopify | ingress | Internal-platform routing disclosure + price equivalence |

**Suggested starting set:** `checkout-spend-cap` + `merchant-allowlist` (stateless, the two flagships), then `order-pii-egress-redaction`. Add the stateful pair (`cumulative-spend-ceiling`, `approved-cart-integrity`) on a session-state-capable gateway build.
