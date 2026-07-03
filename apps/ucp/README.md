# UCP (Universal Commerce Protocol)

Buyer-side egress governance for AI agents that transact over the [Universal Commerce Protocol (UCP)](https://ucp.dev) — for example through Shopify+Google's hosted Cart / Checkout / Order MCP servers.

> **Experimental — for discussion.** These are example policies exploring buyer-side governance of agentic commerce, shared as a starting point and a conversation, not a hardened or endorsed product.

These policies govern **the agents your enterprise runs**. They sit on the MCP path *out* of your organization — the last point you control before a request reaches a merchant. They are complementary to UCP and to the commerce platform, not a replacement: the merchant side (fraud, payment, PII, scope, trust-tier) stays with the platform, server-side; these add the buyer's own controls on the buyer's own agents.

> **Why the app is `ucp`.** UCP is an open standard, exposed over concrete MCP servers (Shopify+Google's hosted Cart / Checkout / Order servers are the reference target). The app slug is vendor-neutral because the same policies apply to any UCP server. Policies match the OpenRPC operation names (`complete_checkout`, `get_order`, …) by **suffix**, because the gateway prepends a non-standardized server prefix (often slugifying underscores to hyphens, e.g. `ucp-shop-complete-checkout`). Confirm the exact tool names your gateway sends with the dump-input debug technique before relying on these.

| Policy | Direction | Purpose |
|---|---|---|
| [checkout-spend-cap](./checkout-spend-cap/policy.md) | ingress · stateful | Deny `complete_checkout` over an org-supplied spend cap (against the observed total) |
| [merchant-allowlist](./merchant-allowlist/policy.md) | ingress | Deny completion to a merchant not on the approved list |
| [cumulative-spend-ceiling](./cumulative-spend-ceiling/policy.md) | ingress · stateful | Running spend across a session vs. an org budget |
| [approved-cart-integrity](./approved-cart-integrity/policy.md) | ingress · stateful | Bind completion to the cart the merchant confirmed completable (blocks post-approval swaps) |
| [order-pii-egress-redaction](./order-pii-egress-redaction/policy.md) | egress | Redact buyer PII from `get_order` / `get_checkout` responses |
| [high-value-handoff-gate](./high-value-handoff-gate/policy.md) | egress | Hand off high-value checkouts to a human above a purchase threshold |
| [restricted-category-block](./restricted-category-block/policy.md) | ingress | Block agent purchases in restricted categories / SKUs at create/update |
| [attribution-disclosure](./attribution-disclosure/policy.md) | ingress · stateful | Internal-platform governance: disclosed routing + no-overcharge (observed vs advertised) |

## The stateful policies observe at egress and enforce at completion

Four policies are **stateful** and share one pattern. On the confirmed UCP MCP binding, `complete_checkout` carries only the checkout `id` (top level) and finalization data — **no totals, no cart content**. Anything that gates completion on the cart or the money must therefore have *observed* those facts from an earlier checkout **response** into policy-accessible session state, then *enforce* at the completion request by reading that state keyed on `args.id`:

- **Observe leg** — bind the policy's package to `tool_post_invoke` (`input.mode == "output"`). On a `create_checkout` / `update_checkout` / `get_checkout` response it records what it needs (a total, a currency, an approval baseline) into its own session namespace, merged with prior observations.
- **Enforce leg** — bind the same package to `tool_pre_invoke` (`input.mode == "input"`). On `complete_checkout` it reads the observation for `args.id` and decides, failing **closed** when nothing was observed for that id.

`direction` in the catalog is a single value, so these four are registered as `ingress` (where the decision is made); **bind each of them to BOTH hooks**. Each stateful policy documents its writable-key schema in its `policy.md`. They require a gateway that provides policy-accessible session state. See the [`agentic-commerce`](../../bundles/agentic-commerce/README.md) bundle for the curated set and [`commerce`](../../industries/commerce/README.md) for the industry view.

## Status

This set compiles under `opa check --strict` and its test suites pass under `pnpm test`, exercised against the confirmed UCP tool-argument and response shapes (id at the top level of completion args; completion args without cart or totals; observe cases as `tool_post_invoke` responses). The org-constraint inputs the policies read at `input.context.*` (mandate caps and allowlists, `restricted_skus`, `advertised_total`, the resolved `merchant`) are gateway-supplied configuration your deployment must populate before those denies can fire. A live end-to-end re-run of the redesigned observe-enforce pair behind a gateway is a follow-up; treat these as reviewed examples, not a hardened release.
