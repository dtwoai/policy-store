# Retail

Policies relevant to retail and commerce, where AI agents discover and purchase from merchants on behalf of a buyer over the [Universal Commerce Protocol (UCP)](https://ucp.dev).

The canonical policy bodies live under [`apps/shopify/`](../../apps/shopify/README.md); this page only curates them (industry pages never duplicate policy files).

- [checkout-spend-cap](../../apps/shopify/checkout-spend-cap/policy.md) — hold an agent's purchase to an org-supplied spend cap.
- [merchant-allowlist](../../apps/shopify/merchant-allowlist/policy.md) — restrict checkout completion to approved merchants (carriers, vendors).
- [cumulative-spend-ceiling](../../apps/shopify/cumulative-spend-ceiling/policy.md) — enforce a running session budget across multiple purchases.
- [approved-cart-integrity](../../apps/shopify/approved-cart-integrity/policy.md) — bind completion to the human-approved cart (blocks post-approval tampering).
- [order-pii-egress-redaction](../../apps/shopify/order-pii-egress-redaction/policy.md) — mask buyer PII in order/checkout responses before an agent sees them.
- [high-value-approval-gate](../../apps/shopify/high-value-approval-gate/policy.md) — require human approval above a purchase threshold.
- [restricted-category-block](../../apps/shopify/restricted-category-block/policy.md) — block autonomous purchase of restricted categories/SKUs.
- [attribution-disclosure](../../apps/shopify/attribution-disclosure/policy.md) — internal-platform routing disclosure and price-equivalence.
