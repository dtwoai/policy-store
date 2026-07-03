---
name: Checkout Spend Cap
tags:
  - ucp
  - agentic-commerce
  - checkout
  - spend-cap
  - session-state
  - governance
  - ingress
publishedAt: 2026-06-27
description: |
  # ucp / checkout-spend-cap

  **Direction:** ingress (`tool_pre_invoke`) — enforce leg. Requires a
  companion `tool_post_invoke` binding for the observe leg (see below).
  **Default:** deny `complete_checkout` unless an observed total clears the cap; allow otherwise
  **Package:** `ucp.ingress.checkout_spend_cap`
  **Pattern:** stateful observe-enforce pair (policy-accessible session state)

  ## What it does

  Enforces a per-mandate **spend cap** at the moment an agent tries to finalize a
  purchase. `complete_checkout` on the confirmed UCP MCP binding carries only the
  checkout `id` (top level) plus finalization data — **no totals, no cart**. The
  money the buyer will be charged is therefore not present on the completion
  request; it was established on an earlier `create_checkout` / `update_checkout`
  / `get_checkout` **response**. This policy observes those responses into
  policy-accessible session state, then at `complete_checkout` reads the observed
  total for `args.id` and **denies** when it exceeds a policy-supplied ceiling
  (`input.context.mandate.max_total`) or when the observed currency does not
  match the mandate currency.

  ## The observe-enforce pair (bind BOTH hooks)

  `direction` in the catalog is a single value, and this policy's *decision* is
  made at ingress, so it is registered as `ingress`. But the policy is only
  correct when its package is bound to **both** gateway hooks on the same MCP
  session:

  - **`tool_post_invoke` (observe / egress, `input.mode == "output"`)** — on a
    `create_checkout` / `update_checkout` / `get_checkout` response, the policy
    records `{ <checkout id>: { total, currency } }` into its own session
    namespace under the object-valued key `observed_checkouts`, merged with any
    prior observations via `object.union`. When the response's grand total cannot
    be resolved to exactly one numeric `type == "total"` entry, it records
    `{ <checkout id>: { unresolvable: true } }` instead, so completion later
    fails closed.
  - **`tool_pre_invoke` (enforce / ingress, `input.mode == "input"`)** — on
    `complete_checkout`, the policy looks up `args.id` in the observed map and
    decides.

  Bind the package to both hooks. On a gateway without policy-accessible session
  state, the observe write is a no-op and every recorded-total completion denies
  fail-closed (see limitations).

  ## Fail closed when nothing was observed

  If `complete_checkout` arrives for a checkout id with **no observation on
  file** — the flow never read or updated the checkout through the gateway, or
  the observation could not be resolved to a single numeric total — the policy
  **denies**. A spend-cap gate that let an unverifiable total through would be no
  gate at all. Real UCP flows read/update the checkout before completing, so the
  observation exists in practice.

  ## Marker discovery, no hard-coded writer id

  The gateway auto-namespaces this policy's writes under `policies.<writer_id>`
  and injects them into `input.context.session` on later evaluations. The policy
  never hard-codes `writer_id`: the enforce read iterates
  `input.context.session.policies` and reads the `observed_checkouts` key
  wherever it appears (that key is this policy's marker). Reads use set semantics
  over checkout ids, so a degenerate multi-namespace session can only deny, never
  raise an evaluation conflict. Per the session-state contract a policy cannot
  read what it wrote in the *same* evaluation; observe and enforce are separate
  evaluations, which is the supported cross-evaluation read path.

  ## Where the numbers come from

  - **Observed total.** The grand total is the `totals[]` entry whose
    `type == "total"`; `amount` is a **signed integer in the currency's minor
    unit** (cents): `139000` means `$1,390.00`. It is read from the checkout
    **response** (`input.payload.result.totals`) at observe time — not from the
    completion request, which carries no totals.
  - **The cap is gateway-supplied policy input, not a UCP field.** A buyer's
    limits do not exist as UCP checkout fields; in UCP they live only inside an
    opaque AP2 SD-JWT (`checkout.ap2.checkout_mandate`) that Rego cannot read.
    The gateway injects the enforceable cap at `input.context.mandate`:
    `max_total` (integer minor units) and `currency` (ISO-4217).

  ## Human-readable reason

  On denial the policy emits a reason a person can act on, e.g.
  `This purchase totals $1,390.00 but the agent's limit is $1,200.00.`, a
  currency-mismatch message, a no-observation message, or a no-cap message.

  ## Session writes and the writable-key schema

  This policy writes one object-valued key. It must be declared in the policy's
  writable-key schema (authored alongside the policy and shipped to the gateway
  in its policy configuration):

  | key | JSON Schema | suggested TTL | on_drop |
  | --- | --- | --- | --- |
  | `observed_checkouts` | `object` mapping checkout id (`string`) to either `{ "total": integer, "currency": string }` or `{ "unresolvable": true }` | a checkout's working lifetime (e.g. 3600s), sliding — each observation refreshes it | `deny_request` |

  `on_drop: deny_request` is deliberate: if the observation cannot be persisted,
  a later `complete_checkout` must fail closed rather than fall through to allow.
  (Per the session-state contract the gateway's per-minute rate-limit drops never
  flip `allow` regardless of `on_drop` — that is load-shedding, not intent.) The
  TTL is sliding: each observation write refreshes the key's lifetime.

  ## Examples

  ### Allowed (observed total within cap, on the completing checkout)

  A prior `update_checkout` response for `chk_9f2b` was observed at `$980.00`
  (`98000`). The `complete_checkout` targets `chk_9f2b` with a mandate of
  `max_total: 120000`, `currency: USD`. The observed total is under the cap and
  the currency matches, so completion is allowed.

  ### Denied (observed total over cap)

  The observed total for `chk_9f2b` was `$1,390.00` (`139000`) against a ceiling
  of `120000`. `complete_checkout` is denied and the charge never reaches the
  merchant.

  ## Scope and honest limits

  - **Buyer-side governance, MCP path only.** This governs the agents *you* run,
    on the MCP calls they make through the gateway. It does not see a browser
    `continue_url` handoff.
  - **Complementary to UCP / the merchant.** It does not replace the merchant's
    own trust and risk controls; it is an additional buyer-side control on the
    agent traffic you operate.
  - **Cap is only as good as the injected mandate.** The ceiling is whatever the
    gateway places at `input.context.mandate`. The policy does not parse the AP2
    SD-JWT itself.
  - **Single currency, single cap.** One cap per call, no cross-currency
    conversion: a mismatch is a denial, not a conversion.
  - **Requires a gateway that ships policy-accessible session state.** Without
    `input.context.session` and `decision.session_writes`, the observe write is a
    no-op and the enforce read is always empty, so the policy denies every
    completion fail-closed. Deploy only on a session-state-capable build.
direction: ingress
apps:
  - ucp
industries:
  - commerce
bundles:
  - agentic-commerce
schemaVersion: "1.0.0"
minimumGatewayVersion: 1.0.0-session-state
---

```rego
package ucp.ingress.checkout_spend_cap

# Stateful observe-enforce pair (policy-accessible session state).
#
# OBSERVE (tool_post_invoke, mode "output"): on a create/update/get checkout
#   response, record { <result.id>: { total, currency } } (or { unresolvable:
#   true } when the grand total is not exactly one numeric entry) into this
#   policy's own session namespace under the object-valued key
#   observed_checkouts, merged with prior observations.
# ENFORCE (tool_pre_invoke, mode "input"): on complete_checkout, read the
#   observed snapshot for args.id back from session state and DENY when it is
#   missing/unresolvable (fail closed), over the mandate cap, or in a currency
#   that does not match the mandate.

default allow := false

# ---- tool-name matching -----------------------------------------------------
# The gateway prepends a server prefix and commonly slugifies underscores to
# hyphens when federating tool names ("ucp-shop-complete-checkout"), so match
# hyphenated, underscored, and collapsed shapes anchored at a "-"/"_" separator,
# plus the bare un-prefixed name.

tool_name := lower(object.get(input.resource, "name", ""))

tool_matches(shapes) if shapes[tool_name]

tool_matches(shapes) if {
    some shape in shapes
    endswith(tool_name, sprintf("-%s", [shape]))
}

tool_matches(shapes) if {
    some shape in shapes
    endswith(tool_name, sprintf("_%s", [shape]))
}

complete_checkout_shapes := {
    "complete_checkout",
    "complete-checkout",
    "completecheckout",
}

# Tools whose RESPONSE carries the priced checkout we observe. complete_checkout
# is deliberately excluded: observing its response would re-record a checkout we
# are about to finalize.
observe_tool_shapes := {
    "create_checkout",
    "create-checkout",
    "createcheckout",
    "update_checkout",
    "update-checkout",
    "updatecheckout",
    "get_checkout",
    "get-checkout",
    "getcheckout",
}

is_enforce if {
    input.mode == "input"
    tool_matches(complete_checkout_shapes)
}

is_observe if {
    input.mode == "output"
    tool_matches(observe_tool_shapes)
    result_id != ""
}

# ---- OBSERVE: record the priced checkout ------------------------------------

result := object.get(input.payload, "result", {})

result_id := object.get(result, "id", "")

# Grand total = the single totals[] entry whose type == "total" with a numeric
# amount. Index by position so two entries with the same amount still count as
# two — an ambiguous totals[] must not collapse to one "matching" total.
result_total_indices contains i if {
    some i, entry in object.get(result, "totals", [])
    lower(object.get(entry, "type", "")) == "total"
    is_number(object.get(entry, "amount", null))
}

resolved_result_total := object.get(result, "totals", [])[i].amount if {
    count(result_total_indices) == 1
    some i in result_total_indices
}

observed_snapshot := {"total": resolved_result_total, "currency": lower(object.get(result, "currency", ""))} if {
    count(result_total_indices) == 1
}

observed_snapshot := {"unresolvable": true} if {
    count(result_total_indices) != 1
}

session_policies := object.get(object.get(input.context, "session", {}), "policies", {})

# Prior observations across any namespace carrying our marker key. Set/union
# semantics keep the read total; with one namespace per writer this is our own.
prior_observed := object.union_n([m |
    some _, ns in session_policies
    m := object.get(ns, "observed_checkouts", {})
])

session_writes["observed_checkouts"] := object.union(prior_observed, {result_id: observed_snapshot}) if {
    is_observe
}

# ---- ENFORCE: read the observed snapshot for the completing checkout --------

args := object.get(input.payload, "args", {})

# complete_checkout carries the checkout id at the TOP LEVEL of args.
target_id := object.get(args, "id", "")

observed_snapshots_for_target := {snap |
    some _, ns in session_policies
    m := object.get(ns, "observed_checkouts", {})
    snap := object.get(m, target_id, null)
    snap != null
}

has_observation if count(observed_snapshots_for_target) > 0

observed_totals_for_target := {t |
    some snap in observed_snapshots_for_target
    t := object.get(snap, "total", null)
    is_number(t)
}

resolvable_total if count(observed_totals_for_target) == 1

observed_total := t if {
    resolvable_total
    some t in observed_totals_for_target
}

observed_currencies_for_target := {c |
    some snap in observed_snapshots_for_target
    c := object.get(snap, "currency", null)
    is_string(c)
    c != ""
}

observed_currency := c if {
    count(observed_currencies_for_target) == 1
    some c in observed_currencies_for_target
}

mandate := object.get(input.context, "mandate", {})

cap := object.get(mandate, "max_total", null)

mandate_currency := object.get(mandate, "currency", null)

currency_mismatch if {
    is_enforce
    is_string(mandate_currency)
    is_string(observed_currency)
    observed_currency != lower(mandate_currency)
}

# ---- decision ---------------------------------------------------------------

# Everything that is not the enforce leg passes through: observe responses,
# other tools, and the complete_checkout response itself.
allow if {
    not is_enforce
}

# complete_checkout is allowed only with an observed, resolvable total that is
# within a supplied cap and in the mandate currency.
allow if {
    is_enforce
    resolvable_total
    is_number(cap)
    observed_total <= cap
    not currency_mismatch
}

decision := {"allow": allow, "session_writes": session_writes}

# ---- reasons ----------------------------------------------------------------

reasons contains "No observed checkout state for this checkout id in the session. Read or update the checkout through the gateway (create_checkout / update_checkout / get_checkout) before completing it, so the spend cap can be checked against the observed total." if {
    is_enforce
    not has_observation
}

reasons contains "The observed grand total for this checkout could not be resolved to exactly one numeric total, so the spend cap cannot be enforced; completion is refused." if {
    is_enforce
    has_observation
    not resolvable_total
}

reasons contains "Completing a checkout requires a spend cap, but no mandate limit was supplied to the policy." if {
    is_enforce
    resolvable_total
    not is_number(cap)
}

reasons contains msg if {
    is_enforce
    resolvable_total
    is_number(cap)
    observed_total > cap
    msg := sprintf("This purchase totals %s but the agent's limit is %s.", [money(observed_total), money(cap)])
}

reasons contains msg if {
    currency_mismatch
    msg := sprintf("Checkout currency %s does not match the agent's mandate currency %s.", [upper(observed_currency), upper(mandate_currency)])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat(" ", reason_list)
}

# ---- money formatting -------------------------------------------------------
# Render integer minor units (cents) as a $-grouped decimal string,
# e.g. 139000 -> "$1,390.00".
money(cents) := out if {
    whole := floor(cents / 100)
    frac := cents - (whole * 100)
    out := sprintf("$%s.%02d", [group(whole), frac])
}

# Insert thousands separators into a non-negative integer, without recursion:
# reverse the digit string, chunk every 3, comma-join, then reverse back.
group(n) := s if {
    digits := sprintf("%d", [n])
    rev := reverse_str(digits)
    chunks := [chunk |
        some i in numbers.range(0, count(rev) - 1)
        i % 3 == 0
        chunk := substring(rev, i, 3)
    ]
    s := reverse_str(concat(",", chunks))
}

reverse_str(x) := out if {
    chars := split(x, "")
    n := count(chars)
    out := concat("", [c |
        some i in numbers.range(0, n - 1)
        c := chars[(n - 1) - i]
    ])
}
```
