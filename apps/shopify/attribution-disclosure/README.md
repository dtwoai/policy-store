# shopify / attribution-disclosure

Internal Routing Disclosure and Price-Equivalence Check for UCP (Universal
Commerce Protocol) checkouts.

- **Direction:** ingress (`tool_pre_invoke`)
- **Default:** deny on a `complete_checkout` that is undisclosed or
  price-mismatched; allow everything else
- **Package:** `shopify.ingress.attribution_disclosure`

## Framing: govern the agents you run

This is **enterprise buyer-side governance**. It is written for an enterprise
that itself operates a routing/aggregation platform over the UCP agents it
runs, and wants to govern those agents — *its own* — at the gateway. It is
**not** a third-party referee inserted between buyer and merchant. UCP's design
deliberately has no middleman in the buyer↔merchant trust path, and this policy
respects that line: it acts only on the calls the enterprise's own agents make,
and is complementary to UCP and the merchant's (e.g. Shopify's) own controls,
never a competing trust-referee.

## What it enforces

On every `complete_checkout` call, before it reaches the merchant:

1. **Disclosed routing.** `input.payload.args.checkout.attribution` must be
   present and non-empty. `attribution` is UCP's only referral surface — an open
   string-map on the checkout. A completed checkout with empty or absent
   attribution is undisclosed routing and is denied.
2. **Price equivalence.** The submitted grand total — the `checkout.totals[]`
   entry whose `type == "total"` — must equal the price the buyer was shown,
   carried as `input.context.advertised_total`. If the price submitted differs
   from the price displayed, the call is denied.

Any tool that is not `complete_checkout` passes through untouched.

## `input.context.*` is DTwo-supplied, not UCP

The price the buyer was shown is **not a UCP field**. UCP carries only the
submitted `totals[]` on the wire; there is no "advertised price" on the checkout
object. So the reference price the policy compares against,
`input.context.advertised_total`, is **DTwo-supplied policy input injected by the
gateway**, not part of UCP.

The same is true for any spending mandate. A buyer's caps / budget / velocity
constraints do not exist as UCP fields — in UCP they live only inside an opaque
AP2 SD-JWT (`checkout.ap2.checkout_mandate`). Where this policy or its companions
reference `input.context.mandate.*` (e.g. `max_total`, `currency`,
`merchant_allowlist`), that is gateway-supplied policy input, not UCP.

## UCP fields this policy reads

| Purpose | Path | Notes |
| --- | --- | --- |
| Tool name | `input.resource.name` | shape-matched (`…-complete-checkout` / `…-complete_checkout` / `…-completecheckout` suffixes, plus bare names); never `input.payload.name` |
| Tool args | `input.payload.args` | canonical args surface |
| Checkout | `input.payload.args.checkout` | the checkout object |
| Attribution | `…checkout.attribution` | open string-map; UCP's only referral surface |
| Grand total | `…checkout.totals[]` where `type == "total"` | `amount` is a signed integer in minor units (cents; `1000` = $10.00) |
| Advertised price | `input.context.advertised_total` | **DTwo-supplied**, not UCP; minor units |

There is no `totals.grand_total` and no `totals.tax` path — the grand total is
strictly the `totals[]` entry with `type == "total"`.

## Tool name matching

The DTwo gateway prepends a non-standard server prefix to UCP tool names and
commonly slugifies underscores to hyphens when federating them (for example
`ucp-acme-complete-checkout`). The policy reads the tool name from
`input.resource.name` and matches it against hyphenated, underscored, and
collapsed shapes of the OpenRPC op, anchored at a `-`/`_` separator, plus the
bare un-prefixed name:

```rego
complete_checkout_shapes := {"complete_checkout", "complete-checkout", "completecheckout"}
```

This keeps the policy portable across gateway naming conventions (verified
end-to-end behind a live gateway). Confirm the exact name your gateway emits
with the dump-input debug technique before deploying.

## Decision matrix

| Tool | attribution | totals `type=="total"` | `advertised_total` | submitted == advertised | Decision |
| --- | --- | --- | --- | --- | --- |
| not `complete_checkout` | — | — | — | — | **allow** (passthrough) |
| `complete_checkout` | non-empty | exactly one | present | yes | **allow** |
| `complete_checkout` | empty / absent | — | — | — | **deny** (undisclosed) |
| `complete_checkout` | non-empty | exactly one | present | no | **deny** (price mismatch) |
| `complete_checkout` | non-empty | zero / multiple | — | — | **deny** (cannot verify) |
| `complete_checkout` | non-empty | exactly one | absent | — | **deny** (cannot verify) |

The cannot-verify cases fail closed: an ambiguous `totals[]` or a missing
advertised price denies rather than letting the completion through.

## Examples

### Allowed — disclosed routing, price matches

```jsonc
{
  "input": {
    "action": "tool_pre_invoke",
    "mode": "input",
    "resource": { "name": "ucp-acme-complete_checkout", "type": "tool" },
    "payload": {
      "args": {
        "checkout": {
          "currency": "USD",
          "attribution": { "dev.acme.route": "aggregator-hub" },
          "totals": [
            { "type": "items", "amount": 4499 },
            { "type": "shipping", "amount": 500 },
            { "type": "total", "amount": 4999 }
          ]
        }
      }
    },
    "context": { "advertised_total": 4999 }
  }
}
```

`allow = true`, no reason.

### Denied — price changed between display and submit

```jsonc
{
  "input": {
    "action": "tool_pre_invoke",
    "mode": "input",
    "resource": { "name": "ucp-acme-complete_checkout", "type": "tool" },
    "payload": {
      "args": {
        "checkout": {
          "currency": "USD",
          "attribution": { "dev.acme.route": "aggregator-hub" },
          "totals": [{ "type": "total", "amount": 5999 }]
        }
      }
    },
    "context": { "advertised_total": 4999 }
  }
}
```

`allow = false`, `reason = "Submitted grand total (5999) does not match the
price the buyer was shown (4999, minor units). …"`.

### Denied — undisclosed routing

A `complete_checkout` whose `checkout.attribution` is `{}` or absent denies with
the disclosure reason, regardless of price.

## Why ingress (not egress)

Completing a checkout is a purchase — a write with permanent side effects. Once
the call reaches the merchant the order exists. The only place to prevent an
undisclosed or price-mismatched completion is *before* the call leaves the
gateway, so this runs at `tool_pre_invoke` and denies. An egress
(`input.mode == "output"`) check could only inspect the result after the fact.

## Scope and honest limitations

- **MCP path only.** This policy governs the MCP tool call. The browser
  `continue_url` handoff — where a buyer finishes in a hosted checkout page — is
  not visible to it. It governs agent-driven completion, not human-in-browser
  completion.
- **`advertised_total` must be supplied.** Price equivalence can only be checked
  when the gateway injects `input.context.advertised_total`. If it is absent the
  call is denied (cannot-verify), not silently allowed. Make sure your gateway
  populates it for the `complete_checkout` hook.
- **Exactly one grand total.** A `totals[]` carrying zero or more than one
  `type == "total"` entry is treated as unverifiable and denied. This prevents a
  malformed or ambiguous totals array from collapsing to a single "matching"
  total.
- **Single currency.** The check compares minor-unit integers and assumes
  `advertised_total` is in the same currency as `checkout.currency`. It does not
  convert currencies.
- **No identity-based exemptions.** All callers are treated the same. Identity
  lives in `input.subject.claims` (use IdP-supplied claims like `groups` /
  `roles`; never `is_admin`, `teams`, or `user`). Add a separate `allow if`
  branch if you need a break-glass path.

## Testing

The cases in [`tests.yaml`](./tests.yaml) — `allow` (disclosed + matching price), `deny` (disclosed
but price-mismatched), and `deny-slugified` (the same mismatch via a
federated, slugified tool name, `ucp-acme-complete-checkout`) — carry the PARC
document under each case's `input` key. Run them all with the repo test
runner from the repo root:

```sh
pnpm test
```

To hand-run one case against OPA, extract the fenced `rego` block from
`policy.md` and feed only the case's `input` object (from the repo root, so
the `yaml` package resolves):

```sh
opa check policy.rego
node -e 'const{parse}=require("yaml");const t=parse(require("fs").readFileSync("apps/shopify/attribution-disclosure/tests.yaml","utf8"));console.log(JSON.stringify(t[0].input))' > /tmp/in.json
opa eval -d policy.rego -i /tmp/in.json \
  'data.shopify.ingress.attribution_disclosure.allow' --format raw   # -> true
```

## Composition

This policy does one job: disclosure plus price equivalence on completion. Pair
it with separate single-purpose policies for:

- **Mandate caps** — deny when the grand total exceeds
  `input.context.mandate.max_total` (DTwo-supplied).
- **Merchant allowlisting** — deny completion against merchants outside
  `input.context.mandate.merchant_allowlist`.
- **Result review** — an egress policy (`input.mode == "output"`,
  `input.payload.result`) that inspects the completed-checkout response.
