# Agentic Commerce

Buyer-side egress controls for enterprises whose AI agents discover and purchase from merchants over the [Universal Commerce Protocol (UCP)](https://ucp.dev).

The merchant side — fraud, payment, PII handling, scope, trust-tier — stays with the commerce platform (e.g. Shopify+Google's UCP servers), server-side. This bundle is the layer an enterprise puts on **the agents it operates**, on the MCP path out: which merchants and tools they may call, org-level spend and data-egress limits beyond a single consent mandate, and per-call Rego on tool arguments and results.

Canonical policy bodies live under [`apps/ucp/`](../../apps/ucp/README.md); this page only curates them.

| Policy | App | Direction | Purpose |
|---|---|---|---|
| [checkout-spend-cap](../../apps/ucp/checkout-spend-cap/policy.md) | ucp | ingress · stateful | Deny `complete_checkout` over an org-supplied spend cap |
| [merchant-allowlist](../../apps/ucp/merchant-allowlist/policy.md) | ucp | ingress | Deny completion to a merchant not on the approved list |
| [cumulative-spend-ceiling](../../apps/ucp/cumulative-spend-ceiling/policy.md) | ucp | ingress · stateful | Running spend across a session vs. an org budget |
| [approved-cart-integrity](../../apps/ucp/approved-cart-integrity/policy.md) | ucp | ingress · stateful | Bind completion to the cart the merchant confirmed completable |
| [order-pii-egress-redaction](../../apps/ucp/order-pii-egress-redaction/policy.md) | ucp | egress | Redact buyer PII from order/checkout responses |
| [high-value-handoff-gate](../../apps/ucp/high-value-handoff-gate/policy.md) | ucp | egress | Hand off high-value checkouts to a human above a threshold |
| [restricted-category-block](../../apps/ucp/restricted-category-block/policy.md) | ucp | ingress | Block restricted categories / SKUs at create/update |
| [attribution-disclosure](../../apps/ucp/attribution-disclosure/policy.md) | ucp | ingress · stateful | Internal-platform routing disclosure + no-overcharge |

**Suggested starting set:** `merchant-allowlist` (stateless identity check) plus `order-pii-egress-redaction` (transform-only), then add the stateful policies (`checkout-spend-cap`, `cumulative-spend-ceiling`, `approved-cart-integrity`, `attribution-disclosure`) on a session-state-capable gateway build, binding each to both the `tool_post_invoke` observe hook and the `tool_pre_invoke` enforce hook.
