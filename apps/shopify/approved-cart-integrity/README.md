# shopify / approved-cart-integrity

**Direction:** ingress (`tool_pre_invoke`)
**Default:** deny on divergence, allow otherwise
**Package:** `shopify.ingress.approved_cart_integrity`
**Pattern:** stateful observe-enforce pair (policy-accessible session state)

## The problem this binds

A human buyer reviews a cart and approves it. Then, between approval and the
charge, a prompt-injection payload — a poisoned product page, a malicious tool
result, a hijacked instruction — convinces the agent to quietly change the
cart: swap the SKU, bump the quantity, or slip in a high-value gift card. The
agent then calls `complete_checkout` and the buyer is charged for something they
never agreed to. This is the Unit 42 gift-card scenario, and it is the canonical
agentic-commerce abuse: the consent and the charge are separated in time, and
the thing being charged can drift in between.

A stateless policy cannot catch this. At `complete_checkout` it sees only the
request in front of it; it has no record of what the human actually approved.

This policy closes that gap. It is a single policy that runs in two phases on
the same MCP session:

- **Observe** — when the cart is approved (the `update_checkout` call that moves
  the checkout to `ready_for_complete`), it records the approved `line_items` —
  item ids and quantities — **and the checkout's `id`** into DTwo session state.
- **Enforce** — when `complete_checkout` runs, it reads that recorded baseline
  back and **denies** if the completion targets a different checkout `id` than
  the approval was recorded for, or if the submitted `line_items` diverge from
  the approved baseline.
- **Consume** — an approval is **single-use**. On an allowed completion the
  policy emits session writes that clear the approval (`approval_recorded :=
  false`, baseline and checkout id emptied), so a replayed `complete_checkout`
  — a double-completion — finds no live approval and fails closed.

Same cart as approved, on the checkout it was approved for, once: allowed.
Anything added, removed, re-quantified, or swapped after approval: denied
before the charge. Same content on a *different* checkout: denied — a stale
approval from an abandoned checkout can never authorize a new one. Same
completion replayed: denied — the first completion consumed the approval.

## Enterprise buyer-side egress governance

This policy is for **governing the agents you run**. It is a control an
enterprise puts on its own buying agents, on the MCP calls those agents make to
a merchant. It is not a merchant-side control and not a trust referee sitting
between buyer and seller.

DTwo is complementary to UCP and Shopify here. UCP defines the checkout
protocol; Shopify runs the store and the real payment authorization. DTwo
governs your agent's behavior on the path it can see. It never competes with the
merchant's own fraud and integrity checks — it adds an enterprise policy layer
on top of them, on the requests your agent originates.

## `input.context.mandate.*` is DTwo-supplied, not a UCP field

This particular policy needs no spend caps, so it reads none. But the broader
point matters for the whole agentic-commerce bundle: the buyer's spending
limits, currency constraints, and merchant allowlists **are not UCP fields**.
UCP carries the buyer's spending mandate only as an opaque AP2 SD-JWT
(`checkout.ap2.checkout_mandate`), which a Rego policy does not read directly.

When a DTwo policy enforces a cap or an allowlist, those values arrive as
**policy input injected by the gateway** at `input.context.mandate.*` — supplied
by your DTwo configuration, not extracted from the UCP checkout object. Treat
anything under `input.context.mandate` as DTwo-supplied trusted input, and
anything under `input.payload.args` as the (untrusted) request the agent is
making.

## How it reads the request (UCP-grounded paths)

This policy reads only confirmed UCP paths:

- **Tool name** from `input.resource.name` (lowercased, matched against
  hyphenated, underscored, and collapsed shapes of the OpenRPC operations
  `update_checkout` / `complete_checkout`, plus the bare names). The gateway
  prepends a non-standard server prefix and commonly slugifies underscores to
  hyphens when federating tool names (`ucp-shop-complete-checkout`), so shape
  matching keeps the policy portable. It does **not** read the tool name from
  `input.payload.name`.
- **Checkout** from `input.payload.args.checkout`.
- **Status** from `checkout.status` — the UCP status enum value
  `ready_for_complete` is the buyer-approved, ready-to-finalize state used as the
  approval signal.
- **Line items** from `checkout.line_items[]`, each `{id, item, quantity}` with
  `item.id` the product id. The baseline is normalized to the set of
  `{id, item_id, quantity}` tuples, so the comparison is order-independent and
  ignores display-only fields (`item.title`, `item.image_url`, `totals`).

It deliberately does **not** pin `item.price`, `totals`, `currency`,
`fulfillment`, or `buyer` fields. Pinning price here would falsely deny a
legitimate merchant repricing between approval and completion; bind those with
the dedicated egress totals / price-integrity policies in this bundle if you
need them.

## How the stateful binding works

The "approved cart" is a fact about an earlier call, not a field on the
completion request. UCP carries no "previously approved" marker. So the only way
to know the baseline at completion time is to have recorded it at approval time.
DTwo session state provides exactly that:

1. **Observe write.** On the approval call the policy returns
   `decision.session_writes.approved_line_items`,
   `decision.session_writes.approval_recorded`, and
   `decision.session_writes.approved_checkout_id` (the `checkout.id` the
   approval was given on). The gateway validates these against the policy's
   writable-key schema and commits them, auto-namespaced under
   `policies.<writer_id>` — where `writer_id` is derived **server-side** from
   the policy identity. The policy never names its own `writer_id`.
2. **Enforce read.** On the later `complete_checkout` call in the same session,
   the gateway injects those committed writes into
   `input.context.session.policies.<writer_id>`. The policy reads the baseline
   and the approved checkout id back from there and compares both.
3. **Consume write.** On an allowed completion the policy returns session
   writes that clear the approval (`approval_recorded := false`,
   `approved_line_items := []`, `approved_checkout_id := ""`). The next
   `complete_checkout` in the session sees no live approval and is denied
   fail-closed — an approval authorizes exactly one completion. The consume
   writes and the observe writes can never fire on the same call: the two
   phases match different tools and the consume rule additionally requires
   the call not to be an approval record.

Two session-state facts shape the authoring:

- **No read-your-own-writes in one evaluation.** `input.context.session` always
  serves *pre-state*. A policy cannot read what it wrote in the same decision.
  That is why observe and enforce are two separate evaluations (the approval
  call, then the completion call) — the supported cross-evaluation path.
- **No hard-coded `writer_id`.** A policy cannot write its own `writer_id` as a
  literal, and should not assume one. The enforce read iterates
  `input.context.session.policies` and selects the namespace carrying this
  policy's own `approval_recorded` marker, so it stays correct regardless of the
  uid the gateway assigns.

### Writable-key schema (declare these alongside the policy)

The policy writes three keys; all must be declared in the policy's writable-key
schema (authored alongside the policy, shipped to the gateway in its policy
configuration):

| key | JSON Schema | suggested TTL | `on_drop` |
| --- | --- | --- | --- |
| `approved_line_items` | `array` of `{id,item_id,quantity}` | a checkout's working lifetime (e.g. `3600`s) | `deny_request` |
| `approval_recorded` | `boolean` | same | `deny_request` |
| `approved_checkout_id` | `string` | same | `deny_request` |

`on_drop: deny_request` is intentional: if the baseline cannot be persisted, a
later `complete_checkout` must not silently fall through to allow. (Per the session-state contract,
the gateway's per-minute *rate-limit* drops never flip `allow` regardless of
`on_drop` — that is a load-shedding defense, not the author's intent.)

### Deployment requirements (verified end-to-end)

The full observe → enforce loop has been verified end-to-end behind a live
gateway against a mock UCP MCP server: a completion with no recorded approval
was denied fail-closed, the `ready_for_complete` `update_checkout` committed
the baseline, an identical completion was then allowed, and a post-approval
gift-card injection was denied. Two configuration preconditions are
load-bearing:

1. **Declare the writable-key schema.** The gateway's policy configuration
   must declare `approved_line_items`, `approval_recorded`, and
   `approved_checkout_id` as this policy's writable session keys — writes to
   undeclared keys are dropped, and with `on_drop: deny_request` a dropped
   baseline write surfaces as a loud deny rather than a silent fail-open.
2. **Reads follow the attributed writer.** The gateway must attribute this
   policy's writes to a stable per-policy namespace under
   `input.context.session.policies`. This policy discovers its own namespace
   by its `approval_recorded` marker rather than a hard-coded id, so it has
   no literal coupling — but write attribution must stay consistent across
   the session for the enforce read to find the baseline.

## What it does on each call

| call | condition | result |
| --- | --- | --- |
| `*update_checkout` | `status == ready_for_complete` | allow; record baseline + checkout id to session state |
| `*complete_checkout` | same checkout id, submitted cart set == approved baseline set | allow; **consume** the approval (single-use) |
| `*complete_checkout` | checkout id != recorded `approved_checkout_id` | **deny** (approval bound to its checkout) |
| `*complete_checkout` | submitted cart set != approved baseline set | **deny** |
| `*complete_checkout` | no live approval on file (never recorded, or consumed by a prior completion) | **deny** (fail-closed) |
| any other tool | — | allow (out of scope), no writes |

## Examples

See the cases in [`tests.yaml`](./tests.yaml): `allow` (completion matches the
approved baseline on the approved checkout, and asserts the consume writes
that make the approval single-use), `deny` (a `$500` gift card added after
approval), `deny-slugified` (the same injection via a federated, slugified
tool name, `ucp-shop-complete-checkout`), `deny-checkout-mismatch` (identical
line items but a different checkout id than the approval was recorded for),
and `deny-replay` (a second completion after the approval was consumed). All
cases pre-populate session state under the policy's own writer namespace in
`input.context.session.policies`, simulating the prior observe (or consume)
step.

## Scope and honest limitations

- **MCP path only.** This binds completion to approval on the MCP requests your
  agent makes. If your flow hands the buyer off to a browser via the top-level
  `continue_url`, anything that happens in that browser session is **not
  visible** to this policy. It is a binding on the MCP path, not an end-to-end
  guarantee.
- **Approval signal is configurable.** The policy treats the `update_checkout`
  that sets `status: ready_for_complete` as the human-approval-of-record. If your
  flow signals consent differently (a distinct tool, a buyer-review message),
  adjust `is_approval_record` to match the call that genuinely represents human
  consent in your flow.
- **Identity and quantity only.** The baseline compares item id and quantity. It
  does not pin price, totals, currency, fulfillment, or buyer fields. Pair with
  the egress totals / price-integrity policies if you need those bound too.
- **No cancellation handling — by design.** There is no cancellation tool in
  the confirmed UCP tool surface, so the policy does not clear an approval on
  "cancel". It does not need to: an abandoned checkout's approval is bound to
  that checkout's `id` and can never authorize a different checkout, and the
  session-state TTL on the approval keys clears it otherwise. A *completed*
  checkout's approval is consumed immediately by the consume writes.
- **No identity-based exemptions.** All callers are treated the same. A
  break-glass override would be a separate `allow if` branch gated on
  `input.subject.claims`.
- **Requires a session-state-capable gateway.** On a gateway without
  policy-accessible session state (`input.context.session` and
  `decision.session_writes`), the observe write is a no-op and the enforce
  read is always empty — so every completion would be denied (the fail-closed
  `approval_on_file` check fails). Deploy only on a gateway that provides
  policy-accessible session state, configured per the deployment requirements
  above.

## Composition

This policy is single-purpose: bind completion-content to approval-content. It
pairs naturally with the rest of the `agentic-commerce` bundle:

- an egress totals / price-integrity policy (bind the *amount* charged, not just
  the items),
- an egress high-value-approval gate (require human review above a mandate
  threshold),
- a mandate / spend-cap policy reading `input.context.mandate.*`.

Together they cover content, amount, and authority. This one owns content
integrity across the approval-to-completion seam.
