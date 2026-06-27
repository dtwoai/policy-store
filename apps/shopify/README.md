# Shopify (UCP)

Buyer-side egress governance for AI agents that transact over the [Universal Commerce Protocol (UCP)](https://ucp.dev) through Shopify's hosted Cart / Checkout / Order MCP servers.

> **Experimental — for discussion.** These are example policies exploring buyer-side governance of agentic commerce, shared as a starting point and a conversation, not a hardened or endorsed product.

These policies govern **the agents your enterprise runs**. They sit on the MCP path *out* of your organization — the last point you control before a request reaches a merchant. They are complementary to UCP and Shopify, not a replacement: the merchant side (fraud, payment, PII, scope, trust-tier) stays with Shopify, server-side; these add the buyer's own controls on the buyer's own agents.

> **Why the app is `shopify`.** The repo convention is `<app>` = the MCP server name as configured on a gateway. UCP is a protocol exposed over concrete servers; Shopify's hosted Cart/Checkout/Order MCP servers are the concrete target here. Policies match the OpenRPC operation names (`complete_checkout`, `get_order`, …) by **suffix**, because the gateway prepends a non-standardized server prefix. Confirm the exact tool names your gateway sends with the dump-input debug technique before relying on these.

| Policy | Direction | Purpose |
|---|---|---|
| [checkout-spend-cap](./checkout-spend-cap/policy.md) | ingress | Deny `complete_checkout` over an org-supplied spend cap |
| [merchant-allowlist](./merchant-allowlist/policy.md) | ingress | Deny completion to a merchant not on the approved list |
| [cumulative-spend-ceiling](./cumulative-spend-ceiling/policy.md) | ingress · stateful | Running spend across a session vs. an org budget |
| [approved-cart-integrity](./approved-cart-integrity/policy.md) | ingress · stateful | Bind completion to the human-approved cart (blocks post-approval swaps) |
| [order-pii-egress-redaction](./order-pii-egress-redaction/policy.md) | egress | Redact buyer PII from `get_order` / `get_checkout` responses |
| [high-value-approval-gate](./high-value-approval-gate/policy.md) | egress | Require human approval above a purchase threshold |
| [restricted-category-block](./restricted-category-block/policy.md) | ingress | Block agent purchases in restricted categories / SKUs |
| [attribution-disclosure](./attribution-disclosure/policy.md) | ingress | Internal-platform governance: disclosed routing + advertised == submitted price |

The two **stateful** policies require a gateway build that ships policy-accessible session state. See the [`agentic-commerce`](../../bundles/agentic-commerce/README.md) bundle for the curated set and [`retail`](../../industries/retail/README.md) for the industry view.
