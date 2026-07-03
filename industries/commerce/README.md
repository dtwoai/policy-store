# Commerce

Policies relevant to commerce and retail, where AI agents discover and purchase from merchants on behalf of a buyer over the [Universal Commerce Protocol (UCP)](https://ucp.dev).

The canonical policy bodies live under [`apps/ucp/`](../../apps/ucp/README.md); this page only curates them (industry pages never duplicate policy files).

- [checkout-spend-cap](../../apps/ucp/checkout-spend-cap/policy.md) — hold an agent's purchase to an org-supplied spend cap (checked against the observed total).
- [merchant-allowlist](../../apps/ucp/merchant-allowlist/policy.md) — restrict checkout completion to approved merchants (carriers, vendors).
- [cumulative-spend-ceiling](../../apps/ucp/cumulative-spend-ceiling/policy.md) — enforce a running session budget across multiple purchases.
- [approved-cart-integrity](../../apps/ucp/approved-cart-integrity/policy.md) — bind completion to the cart the merchant confirmed completable (blocks post-approval tampering).
- [order-pii-egress-redaction](../../apps/ucp/order-pii-egress-redaction/policy.md) — mask buyer PII in order/checkout responses before an agent sees them.
- [high-value-handoff-gate](../../apps/ucp/high-value-handoff-gate/policy.md) — hand off high-value checkouts to a human above a purchase threshold.
- [restricted-category-block](../../apps/ucp/restricted-category-block/policy.md) — block autonomous purchase of restricted categories/SKUs at create/update.
- [attribution-disclosure](../../apps/ucp/attribution-disclosure/policy.md) — internal-platform routing disclosure and no-overcharge (never charge more than the buyer was shown).
