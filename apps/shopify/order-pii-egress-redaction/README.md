# shopify / order-pii-egress-redaction

Redact buyer PII from Shopify UCP `get_order` and `get_checkout` responses
before they reach the agent you run.

- **Direction:** egress (`tool_post_invoke`, `input.mode == "output"`)
- **Default:** allow (transform-only — never denies)
- **Package:** `shopify.egress.order_pii_redaction`
- **App:** shopify (Universal Commerce Protocol MCP servers)

## Framing: govern the agents you run

This is **buyer-side egress governance**. It governs the agents *you* operate
against a merchant's UCP MCP endpoint — masking buyer PII on the way back
through the DTwo gateway, before your agent, your logs, your traces, and any
downstream tooling can see it.

DTwo is **complementary** to UCP and to Shopify's own controls here. It is not a
competing trust referee for the merchant and it does not assert anything about
the merchant side; it only redacts what flows back to your agent on the MCP
path.

## What it does

On the output path, for any tool whose name suffix-matches the UCP op
`get_order` or `get_checkout`, the policy returns a `transform` that tells the
gateway to replace named PII fields in `input.payload.result` with
`[REDACTED]`. Everything else passes through unchanged. It never denies.

### Redacted fields

By field name within the response body:

| Group | UCP location | Fields |
| --- | --- | --- |
| Buyer contact | `$.buyer` (flat snake_case) | `email`, `phone_number` |
| Fulfillment destination address | `$.fulfillment.methods[].destinations[]` (schema.org names) | `street_address`, `extended_address`, `address_locality`, `address_region`, `address_country`, `postal_code` |

`buyer.first_name` / `buyer.last_name` are left intact so the order stays
identifiable — add them to `redact_fields` if you need full-PII masking.

### Left intact

- **Order economics** — `totals[]` (signed-integer minor-unit amounts; the
  grand total is the entry where `type == "total"`), the top-level `currency`
  ISO-4217 string, and `line_items[]`. These are not PII; the agent still needs
  them to reason about the order.
- **`continue_url`** — the top-level checkout handoff URI is not buyer PII and
  is returned unchanged.

## When to use it

Use it when you run agents that call a Shopify UCP MCP server and you do not
want raw buyer contact details or shipping addresses landing in your agent's
context window, logs, or traces. It is a high-signal masking layer on the MCP
response path, not a complete DLP solution.

## Tool matching

The tool name is read from `input.resource.name` (the canonical PARC source),
lowercased, and matched against hyphenated (`-get-order`), underscored
(`-get_order`), and collapsed (`-getorder`) suffix shapes of `get_order` and
`get_checkout`, plus the bare un-prefixed names. The DTwo gateway prepends a
non-standard server prefix and commonly slugifies underscores to hyphens when
federating tool names (`ucp-shop-get-order`), so the underscored form alone
would never match there; the shape set stays portable across whatever prefix
your gateway emits.

This policy does **not** use `input.payload.name` as the tool-name source.

**Gateway-supplied result contract.** The policy (and the transform the
gateway applies) operates on the structured tool result at
`input.payload.result`. The gateway must present the tool's result object
there when evaluating egress policies; if a gateway's post-invoke hook hands
policies extracted text content instead, the deployment must map it back into
`input.payload.result` in the gateway configuration — that reconstruction is
not part of this policy.

Confirm the exact tool names your gateway sends with the dump-input debug
technique before deploying. If your deployment surfaces buyer PII through
additional UCP reads, extend `target_tool_shapes`.

## `input.context.mandate` is DTwo-supplied, not UCP

This policy reads no spending, budget, velocity, or allowlist fields — because
**those are not UCP fields.** A buyer's constraints live only inside the opaque
AP2 SD-JWT at `checkout.ap2.checkout_mandate`. Where a *different* DTwo policy
needs caps or merchant allowlists, the gateway injects them as policy input at
`input.context.mandate.*` (for example `input.context.mandate.max_total`,
`input.context.mandate.currency`, `input.context.mandate.merchant_allowlist`).
That is **DTwo-supplied policy input, not a UCP field.** This redaction policy
needs none of it.

## Principal / identity

This policy applies the same redaction to every caller and reads no identity.
If you need a break-glass exemption, gate a branch on `input.subject.claims`
using an IdP-supplied claim (e.g. `groups` / `roles` / a namespaced custom
claim) — never the stripped `is_admin`, `teams`, or `user` values.

## Decision rules

Following DTwo Rego conventions, `allow`, `reasons`, `reason`, and `transform`
are separate top-level rules (no structured decision objects). This policy
defines `allow` (defaulted `true`) and `transform` only.

| Rule | Value |
| --- | --- |
| `allow` | `true` (default; never denies) |
| `transform` | defined only when on the output path **and** the tool name suffix-matches `get_order` / `get_checkout`; supplies `redact_fields`, `replacement`, and an empty `redact_patterns` |

## Known limitations

- **Structured-result redaction only (verified live).** Field-level redaction
  rewrites the structured tool result. MCP responses typically also carry the
  same JSON serialized as a string in the `content[].text` channel — that text
  copy is **not** rewritten by this policy, so a text-first client can still
  see the raw values. Deployments must redact or suppress the text channel at
  the gateway (for example with a text-aware transform or `redact_patterns`),
  or treat this policy as structured-result-only.
- **MCP path only.** The browser `continue_url` handoff, and anything the buyer
  enters there, is invisible to DTwo and is not governed by this policy.
- **Field-name scoped.** A merchant server returning buyer PII under different
  keys, or nesting it elsewhere, is not covered until `redact_fields` is
  adjusted.
- **Suffix-scoped tool match.** Only `get_order` / `get_checkout` are in scope.
- **No identity exemptions** by default (see Principal / identity above).

## Tests

| Fixture | Tool | Expectation |
| --- | --- | --- |
| [`tests/redact.json`](./tests/redact.json) | `…-get_order` (output path) | `allow = true`, `transformApplied = true`, `transform.replacement = "[REDACTED]"` |
| [`tests/redact-slugified.json`](./tests/redact-slugified.json) | `ucp-shop-get-order` (federated, slugified name) | `allow = true`, `transformApplied = true` |
| [`tests/allow.json`](./tests/allow.json) | `…-get_order` (output path), redaction-shape inspection | `allow = true`, `transform` present with the expected `redact_fields` |
| [`tests/deny.json`](./tests/deny.json) | `…-search_catalog` (out of scope) | `allow = true`, `transformApplied = false` (pass-through; this policy never denies) |

Test fixtures wrap the PARC object under a top-level `"input"` key plus an
`expected` hint. A naive `opa eval` over the file double-nests under
`input.input` and fails open — unwrap `.input` first when evaluating.
