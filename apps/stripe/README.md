# Stripe policies

Reusable DTwo policies for the Stripe MCP server — the official `mcp.stripe.com` remote server (used by the Claude "Stripe" connector, the `@stripe/mcp` local proxy, and the Claude Desktop `.dxt`), plus compatible community and legacy `verb_resource` implementations. The current official surface is a **meta-tool design**: a dozen tools, four of which wrap the *entire* Stripe API dynamically — `stripe_api_read`/`search_stripe_resources`/`fetch_stripe_resources` for reads and the raw `stripe_api_write` passthrough that can execute any `POST`/`PATCH`/`PUT`/`DELETE` — alongside named tools like `create_refund` and legacy per-resource writes. Its risk profile is dominated by *irreversible money movement and financial-data exposure*: refunds, payouts, transfers, and dispute submissions cannot be undone; connected-account (Connect) mutations move funds to third parties; and bulk customer reads concentrate PII. Because scope is enforced server-side by the Restricted API Key or OAuth grant, the raw-API meta-tools are the primary escape hatch these policies are built to contain.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [role-gate-writes-billing](./role-gate-writes-billing/policy.md) | ingress | Read-only Stripe by default: deny named billing write and destructive tools unless the caller is in a `finance`/`billing-admin` IdP group. | soc2, pci-dss, sox, gdpr-ccpa |
| [gate-money-movement-refund-cap](./gate-money-movement-refund-cap/policy.md) | ingress | Deny refund tools unless the caller is in a finance/billing group, and deny any refund whose amount exceeds a configured ceiling. | pci-dss, sox, soc2 |
| [deny-escape-hatches-api-write](./deny-escape-hatches-api-write/policy.md) | ingress | Deny the `stripe_api_write` raw-API passthrough for non-finance callers, and hard-stop money-movement/account endpoints even for them. | pci-dss, sox, soc2 |
| [require-human-approval-dispute-submit](./require-human-approval-dispute-submit/policy.md) | ingress | Strip the irreversible `submit` flag from dispute-update calls so evidence filing stays a human step (transform-only). | soc2, sox |
| [guard-share-links-payment-redirect](./guard-share-links-payment-redirect/policy.md) | ingress | Scrub post-payment redirect URLs from payment-link creation unless the host is on a configured allowlist (transform-only). | soc2, gdpr-ccpa |
| [redact-pii-egress-customer](./redact-pii-egress-customer/policy.md) | egress | Mask customer PII (email, phone, address, name) in bulk read/search Stripe responses before they reach the agent. | soc2, gdpr-ccpa |

## Tool naming on the DTwo gateway

DTwo prefixes tool names with the MCP server name configured on the gateway. A Stripe MCP server registered as `stripe` will surface tools like `stripe-create_refund`, while one registered as `stripe-mcp` will surface `stripe-mcp-create_refund`. The policies in this directory match on the *suffix* (`create_refund`, `update_dispute`, `stripe_api_write`, etc.) so they stay portable across naming conventions — but you should always confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. The raw-API meta-tools (`stripe_api_write`, `stripe_api_read`) are matched by their exact verified names.

## Identity claims

The gating policies (`role-gate-writes-billing`, `gate-money-movement-refund-cap`, `deny-escape-hatches-api-write`) read `input.subject.claims.groups` with **placeholder** group names (`finance`, `billing-admin`). Replace these with your own IdP group names at import time. Missing claims fail closed for grants (no group → not authorized). The transform-only policies (`require-human-approval-dispute-submit`, `guard-share-links-payment-redirect`) and the egress redaction policy require no IdP claims.

## Known residuals across the set

Because the official server exposes raw-API meta-tools, endpoint-token matching cannot catch every parameter-only money-movement vector (e.g. `application_fee_amount` on a direct charge). These residuals are documented per-policy under **Known limitations** and are backstopped by Restricted API Key scoping and the companion gate policies — deploy the gating policies together for defence in depth. Legacy per-resource tool names and Treasury "agentic finance" preview tools are unverified in the landscape note and are noted where relevant.

## Contributing

To add a Stripe policy:

1. Create `apps/stripe/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["stripe"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. If the policy fits a framework or thematic bundle under [`bundles/`](../../bundles/), link to it from the matching landing page.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
