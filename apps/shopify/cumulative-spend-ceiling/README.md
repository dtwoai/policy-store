# Cumulative Spend Ceiling Across a Session

Hold a running spend ceiling across every `complete_checkout` an agent runs
within one session. Each completed checkout adds its grand total to the total
committed by prior checkouts; once the projected session total would cross the
org budget, the next over-ceiling `complete_checkout` is denied.

This is **buyer-side egress governance**: you govern the agents *you* run. It
is not a referee between Shopify and the buyer, and it does not replace any
UCP, AP2, or Shopify control — it is complementary to them. DTwo only sees the
MCP path; see [Honest scope](#honest-scope).

- **App:** shopify
- **Direction:** ingress (gates the request before the tool runs)
- **Tool gated:** `complete_checkout`
- **Stateful:** yes — policy-accessible session state

## Why this needs session state

UCP is stateless on the wire. A single checkout object carries its own totals,
but nothing about *how much this agent has already spent in this session*. The
buyer's spending and budget constraints are not UCP fields at all — they live
only inside the opaque AP2 mandate (`checkout.ap2.checkout_mandate`), which a
policy cannot read. So a per-session spend ceiling is impossible to express
from UCP data alone. It requires two DTwo-supplied inputs:

1. **The ceiling** — `input.context.mandate.session_budget`, injected by the
   gateway as policy input (minor units, same currency as `totals`). This is
   **DTwo-supplied policy input, not a UCP field.** UCP has no budget field.
2. **Cross-call memory** — `input.context.session`, the gateway's session-state
   surface. Each allowed `complete_checkout` writes the new running total; the
   next checkout in the same session reads it back as pre-state.

Without (2) the policy would treat every checkout in isolation and could never
enforce a *cumulative* limit.

## How it works

On each request the policy:

1. Gates on the tool name. The tool name is read from `input.resource.name`
   (lowercased) and **suffix-matched** against `complete_checkout`, because the
   gateway prepends a non-standard server prefix (e.g.
   `shopify_prod__complete_checkout`). Tool args are read from
   `input.payload.args`. Non-checkout tools are not gated.
2. Reads this checkout's grand total from `checkout.totals[]` — the entry where
   `type == "total"`. `amount` is a **signed integer in the currency minor
   unit** (cents; `1000` = `$10.00`). There is no `totals.grand_total` path.
3. Reads the prior running total committed by earlier checkouts in this session
   from `input.context.session.policies.<writer_id>.running_total` (default `0`
   for the first checkout).
4. Computes `projected_total = prior_total + grand_total` and compares it to
   `session_budget`.
   - If `projected_total > session_budget`: **deny** with a reason. No session
     write is made — a blocked checkout must not advance the running total.
   - Otherwise: **allow** and emit a session write setting `running_total` to
     `projected_total`.

If no `session_budget` is supplied, the policy does not gate (it allows and
still records the running total). See [Honest scope](#honest-scope).

### Session-state contract

This policy follows the gateway's session-state contract:

- **Read path:** `input.context.session.policies.<writer_id>.<key>`. Within a
  single evaluation this is **pre-state only** — a policy cannot read a value
  it wrote in the same decision (no read-your-own-writes). The running total a
  checkout reads is the value committed by a *prior* request's evaluation.
- **Write shape:** the policy returns only the bare key under `session_writes`
  (`session_writes["running_total"] := value`). The gateway auto-namespaces it
  to `policies.<writer_id>.running_total` and validates it against the
  writable-key schema before committing.
- **`writer_id` is server-derived.** A policy **cannot** hardcode its real
  writer id — the gateway derives it from the OPA URL and the SOTW config. The
  `writer_id := "shopify.ingress.cumulative_spend_ceiling"` literal in the
  policy is the authoring-time alias the deploy pipeline aligns with the
  resolved writer id. Correctness depends on policy uids being **immutable and
  non-reusable** (enforced by the d2 policy store): if a retired uid were
  reissued to a different policy, that policy would inherit this one's running
  total. The session-state contract explicitly rejects single-policy self-read *within one
  evaluation*; this policy relies on the supported cross-evaluation form —
  request N writes, request N+1 reads — which is exactly the marker-based
  pattern the session-state contract commits to.

### Writable-key schema

The session write must be declared in the policy's writable-key schema (Hub
policy form → Session Writes step). For this policy:

| Key             | JSON Schema             | TTL (s) | On drop |
| --------------- | ----------------------- | ------- | ------- |
| `running_total` | `{"type":"integer"}`    | 86400   | `drop`  |

`x-d2-ttl-seconds` is mandatory per key (no global default). Pick a TTL that
matches your session lifetime; `drop` is appropriate here because a dropped
write only loses accumulation (it never opens the ceiling). The integer type
matches the signed-minor-unit convention of `totals[].amount`.

## Files

- `policy.md` — frontmatter plus the single Rego block.
- `tests/allow.json` — under-ceiling checkout (prior `4000` + this `3000` =
  `7000` ≤ budget `10000`): `allow=true`, write `running_total=7000`.
- `tests/deny.json` — over-ceiling checkout (prior `8500` + this `3000` =
  `11500` > budget `10000`): `allow=false`, reason emitted, no write.

Both fixtures wrap the PARC object under a top-level `input` key and seed the
prior running total at `input.context.session.policies.<writer_id>` per the
static-test recipe. The fixtures carry `expectedSessionWrites` (and, on deny,
`reasonContains`) hints alongside `expected.allow`.

> A verifier MUST unwrap the top-level `input` before calling `opa eval`. A
> naive `opa eval` against the whole file double-nests (`input.input.…`),
> leaves `input.resource.name` empty, and **fails open** (`allow` defaults
> `true`), silently masking the deny case.

## Honest scope

- **DTwo-supplied, not UCP.** Everything under `input.context.mandate.*`
  (including `session_budget`) and `input.context.session.*` is policy input
  the DTwo gateway injects. None of it is a UCP, AP2, or Shopify field. UCP
  carries no budget, no running-total, and no per-session spend surface.
- **MCP path only.** This policy can only see and gate `complete_checkout`
  calls that flow through the MCP gateway. If the agent hands the buyer off to
  a browser via the checkout's top-level `continue_url`, that path is invisible
  to DTwo and the ceiling does not apply to it.
- **Complementary, never a competing referee.** DTwo enforces *your*
  organization's spend governance over the agents you operate. It does not
  arbitrate trust between Shopify and the buyer, and it does not duplicate the
  AP2 mandate's own constraints.
- **Single-process scope.** Policy-accessible session state targets the current runtime:
  one uvicorn process per gateway. The running total is durable across MCP
  reconnects within that scope; multi-worker / multi-node behavior is explicit
  planned follow-up work, not a guarantee here.
- **Fail-open on missing budget.** With no `session_budget` supplied the policy
  does not gate. If you want a missing budget to block instead, pair this with
  a separate deny-by-default policy that requires the mandate to be present.
- **Currency is assumed consistent.** The policy adds minor-unit amounts
  directly and does not convert currencies. Supply `session_budget` in the same
  currency the checkouts use (`checkout.currency`); mixed-currency sessions are
  out of scope.
