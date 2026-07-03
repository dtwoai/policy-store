# shopify / high-value-approval-gate

**Direction:** egress (`tool_post_invoke`, `input.mode == "output"`)
**Default:** deny a high-value checkout response with no review surface; allow everything else
**Package:** `shopify.egress.high_value_approval_gate`

## What it does

This is a buyer-side egress gate for Universal Commerce Protocol (UCP) checkouts
on Shopify. It inspects the *response* of a `create_checkout` or
`update_checkout` call. When the order's grand total is at or above a spending
cap, the policy refuses to let your agent proceed autonomously to
`complete_checkout` and requires that a human-reviewable `continue_url` is
present so the buyer can finish the purchase out of band.

Concretely, on a checkout-mutation response in output mode:

1. It reads the grand total — the `totals[]` entry whose `type == "total"`. The
   `amount` is a signed integer in the currency minor unit (cents:
   `74250` = $742.50).
2. It compares that against `input.context.mandate.max_total`, a cap supplied by
   the gateway (see "Where the cap comes from" below).
3. If the total is at or above the cap **and** no `continue_url` is present, it
   **denies** the response: the agent must re-run `update_checkout` so the
   response carries a `continue_url`, then route the buyer there instead of
   calling `complete_checkout`.
4. If the total is at or above the cap **and** a `continue_url` is present, it
   **allows** the response but attaches an escalation `reason` telling the agent
   not to auto-complete — hand the buyer the `continue_url` for review.

Everything else passes through unchanged: ingress mode, other tools,
sub-threshold orders, and responses where the gateway supplied no cap.

## This governs the agents *you* run

This is enterprise buyer-side egress governance, not merchant-side escalation.
The policy runs on the path your own commerce agents take through the DTwo
gateway. The decision it makes — "this order is large enough that a human must
approve it" — is *your* organization's risk control, applied to *your* agents'
autonomy. It is not Shopify deciding, and it is not the merchant deciding.

DTwo is complementary to UCP and Shopify here, not a competing trust-referee. We
do not re-decide what UCP or the merchant already decided about the checkout; we
add an organizational approval step on top of the checkout your agent received.

## UCP encodes the state, not the trigger

UCP's checkout object has a `status` enum that includes
`requires_escalation`, and its `messages[]` allow a `requires_buyer_review`
severity on an `error`. But `high_value_order` appears in UCP only as a
**freeform example `code`** on such a message — UCP defines the *state* an order
can be in, not the *business rule* that decides when an order should be in it.

This policy is that missing trigger. It is the DTwo-owned rule that says "an
order at or above $X requires human approval", expressed against the fields UCP
actually returns. The `reason` strings reference `requires_escalation` /
`requires_buyer_review` so the downstream agent maps cleanly onto UCP's
vocabulary.

## Where the cap comes from (`input.context.mandate` is DTwo-supplied)

**`input.context.mandate` is not a UCP field.** The buyer's spending limits,
budgets, and velocity constraints do not exist as UCP checkout fields at all —
in UCP they live only inside an opaque AP2 SD-JWT at
`checkout.ap2.checkout_mandate`, which a Rego policy cannot read.

So the cap this policy compares against is **policy input injected by the DTwo
gateway** at:

- `input.context.mandate.max_total` — the threshold, in the same minor-unit
  integer space as `totals[].amount` (cents).
- `input.context.mandate.currency` — optional, for an out-of-band currency
  sanity check.

The gateway is responsible for deriving / configuring `input.context.mandate`
(e.g. by decoding the AP2 mandate, or from your own org budget config) and for
ensuring `max_total` is denominated in the checkout's currency. The policy does
**no** currency conversion; if `currency` and the checkout currency disagree,
treat that as a configuration error in your gateway wiring, not something this
policy will catch for you. If the gateway supplies no `max_total`, the policy
**passes the response through** — it cannot gate without a cap.

## UCP fields read

All paths below are the real UCP shapes — none are invented:

- **Tool name:** `input.resource.name`, lowercased and matched against
  hyphenated, underscored, and collapsed shapes of `create_checkout` /
  `update_checkout` (plus the bare names). The gateway prepends a non-standard
  server prefix and commonly slugifies underscores to hyphens when federating
  tool names (e.g. `ucp-shop-update-checkout`), so shape matching keeps the
  policy portable. The tool name is **not** read from `input.payload.name`.
- **Mode:** `input.mode == "output"` — this is an egress / response gate.
- **Checkout result:** `input.payload.result` (the returned checkout object).
  **Gateway-supplied contract:** the gateway must present the tool's
  structured result object at `input.payload.result` when it evaluates egress
  policies. If your gateway's post-invoke hook hands policies extracted text
  content instead of the result object, the deployment must map it back into
  `input.payload.result` in the gateway configuration — that reconstruction
  is not part of this policy.
- **Grand total:** the entry in `result.totals[]` where `type == "total"`; its
  `amount` is a signed integer in minor units. There is no `totals.grand_total`
  and no `totals.tax` path — `totals` is a flat array of
  `{type, amount, display_text?}`.
- **Review surface:** `result.continue_url`, a top-level URI string.
- **Cap:** `input.context.mandate.max_total` (DTwo-supplied, see above).
- **Principal** (available if you want caller-based exemptions):
  `input.subject.claims`. Never `is_admin` / `teams` / `user`.

## Scope and honesty about what's visible

- **Only the MCP path is visible to this policy.** The browser handoff that
  happens when the buyer opens `continue_url` is out of band — DTwo does not see
  it and cannot confirm the human actually approved. The control this policy
  provides is "the agent is stopped from auto-completing and is forced to
  produce a review surface", not "a human definitely clicked approve".
- **It is a response-side gate.** It reasons about the checkout the agent already
  received; it does not stop the `create_checkout` / `update_checkout` call
  itself (those are reads/builds of a checkout, not the irreversible purchase).
  The irreversible step is `complete_checkout`, and the way to actually block
  that autonomously is to pair this with an ingress companion (see Composition).
- **Threshold is a blunt instrument.** A single `max_total` does not capture
  per-merchant limits, category rules, or cumulative spend. Those belong in the
  gateway-supplied `mandate` (extend it with more fields and add branches), or
  in separate policies.

## Examples

### Allowed (sub-threshold)

```jsonc
{
  "input": {
    "mode": "output",
    "resource": { "name": "shopify-mcp-create_checkout", "type": "tool" },
    "payload": {
      "result": {
        "status": "ready_for_complete",
        "currency": "USD",
        "continue_url": "https://shop.example.com/checkouts/01J9ABCD",
        "totals": [{ "type": "total", "amount": 4500 }]
      }
    },
    "context": { "mandate": { "max_total": 50000, "currency": "USD" } }
  }
}
```

`allow = true`, no reason. ($45.00 is below the $500.00 cap.)

### Denied (at/above cap, no review surface)

```jsonc
{
  "input": {
    "mode": "output",
    "resource": { "name": "shopify-mcp-update_checkout", "type": "tool" },
    "payload": {
      "result": {
        "status": "ready_for_complete",
        "currency": "USD",
        "continue_url": "",
        "totals": [{ "type": "total", "amount": 74250 }]
      }
    },
    "context": { "mandate": { "max_total": 50000, "currency": "USD" } }
  }
}
```

`allow = false`, `reason = "Checkout grand total (74250 minor units) is at or
above the approval threshold of 50000, and no continue_url is present for buyer
review. …"`.

### Escalation (at/above cap, review surface present)

Same as denied but with a non-empty `continue_url`: `allow = true` with an
escalation `reason` instructing the agent to route the buyer to the
`continue_url` and not call `complete_checkout`. If you want a hard stop in this
case instead, delete the second `allow if { is_high_value; has_continue_url }`
rule in `policy.md` so high-value always denies.

## Composition

This policy is single-purpose (the response-side approval gate). Useful
companions:

- An **ingress** policy on `complete_checkout` (`input.mode == "input"`,
  `endswith(..., "complete_checkout")`) that denies the call unless an approval
  token / reviewed flag is present, so the agent physically cannot complete a
  high-value checkout autonomously. This response-side gate produces the
  escalation; the ingress gate enforces it.
- A policy that asserts the platform-asserted `signals`
  (`dev.ucp.buyer_ip`, `dev.ucp.user_agent`) are present and not buyer-asserted.

See the [`bundles/agentic-commerce`](../../../bundles/agentic-commerce/README.md)
bundle for the curated set.

## Tests

Cases in [`tests.yaml`](./tests.yaml), run by the repo test runner (`pnpm test`):

- `allow` — a `create_checkout` response at $45.00, below a $500.00
  cap → `allow = true`.
- `deny` — an `update_checkout` response at $742.50, at/above a
  $500.00 cap, with no `continue_url` → `allow = false` with a reason.
- `deny-slugified` — the same over-threshold response via a
  federated, slugified tool name (`ucp-shop-update-checkout`) →
  `allow = false`.

Both wrap the PARC object under a top-level `input` key. Evaluate by unwrapping
`.input` first (a naive `opa eval` that feeds the whole file double-nests under
`input.input` and fails open).
