---
name: "Internal Routing Disclosure and No-Overcharge Check"
tags:
  - ucp
  - agentic-commerce
  - attribution
  - checkout
  - session-state
  - governance
  - ingress
publishedAt: 2026-06-27
description: |
  # ucp / attribution-disclosure

  **Direction:** ingress (`tool_pre_invoke`) — enforce leg. Requires a
  companion `tool_post_invoke` binding for the price observe leg (see below).
  **Default:** deny a `complete_checkout` that is undisclosed or overcharged; allow everything else
  **Package:** `ucp.ingress.attribution_disclosure`
  **Pattern:** stateful observe-enforce pair (policy-accessible session state)

  ## What it does

  This is buyer-side governance for an enterprise that operates its own
  routing/aggregation platform across the UCP (Universal Commerce Protocol)
  agents it runs. It governs the agents *you* run — it is not a third-party
  referee imposed between buyer and merchant.

  At `complete_checkout` (ingress), the policy requires two things and denies
  otherwise:

  1. **Disclosed routing.** The completion's `checkout.attribution`
     (`input.payload.args.checkout.attribution`, with `input.payload.args.attribution`
     as a fallback) must be present and non-empty. `attribution` is a legitimate
     completion input on the confirmed UCP MCP binding — `complete_checkout`
     carries finalization data including `attribution` — and it is UCP's only
     referral surface (an open string-map). An empty/absent map is undisclosed
     routing.
  2. **No overcharge.** The **observed** grand total for the completing checkout
     (recorded from an earlier checkout response, see below) must not **exceed**
     the price the buyer was shown (`input.context.mandate.advertised_total`,
     with `input.context.advertised_total` as a fallback). The guarantee is that
     the buyer is never charged *more* than they were shown. An observed total
     **lower** than the advertised one (a coupon, promo, or merchant repricing
     down) is allowed.

  Any tool other than `complete_checkout` passes through untouched.

  ## Why the price leg is stateful

  `complete_checkout` on the confirmed UCP MCP binding carries only the checkout
  `id` (top level) and finalization data — **no totals**. The submitted grand
  total is not on the completion request, so the no-overcharge check cannot read
  it there. Instead the policy **observes** the grand total from an earlier
  `create_checkout` / `update_checkout` / `get_checkout` **response** into
  policy-accessible session state, then at completion compares the observed total
  for `args.id` against the advertised price.

  ### Bind BOTH hooks

  - **`tool_post_invoke` (observe, `input.mode == "output"`)** — record the
    observed grand total under the object-valued key `priced_observations`, keyed
    by checkout id, merged with prior observations. An unresolvable total (zero or
    multiple `type == "total"` entries) records an unresolvable marker so
    completion fails closed.
  - **`tool_pre_invoke` (enforce, `input.mode == "input"`)** — on
    `complete_checkout`, check disclosure and the observed-total-vs-advertised
    comparison. **Fail closed** when there is no resolvable observation for
    `args.id` or no advertised price supplied.

  The policy finds its own state by marker discovery over
  `input.context.session.policies` (the `priced_observations` key is its marker);
  it never hard-codes a writer id, and reads use set semantics so a degenerate
  multi-namespace session can only deny.

  ## Honest limits of each leg

  - **Disclosure is an agent-supplied compliance nudge, not enforced
    provenance.** `checkout.attribution` is populated by the agent making the
    call. Requiring it to be non-empty nudges your own agents to carry a routing
    trail; it does **not** verify that the trail is truthful. Real provenance
    assurance would need a gateway-supplied trusted source under
    `input.context.*` (e.g. a routing identity the gateway attaches), not a field
    the caller writes.
  - **`advertised_total` is gateway-supplied policy input, not a UCP field.** UCP
    carries no "price the buyer was shown". The gateway injects it at
    `input.context.mandate.advertised_total` (or `input.context.advertised_total`).
  - **Overcharge only, by design.** A total lower than advertised is allowed.
    Cart-content tampering is `approved-cart-integrity`'s job and the absolute
    ceiling is `checkout-spend-cap`'s; this policy owns only the overcharge
    direction. A strict any-drift stance is a one-comparison change (`<=` to `==`
    in `not_overcharged`).
  - **MCP path only.** The browser `continue_url` handoff is not visible.
  - **Single currency.** Minor-unit integers are compared directly; the advertised
    price is assumed to be in the checkout's currency. No conversion.

  ## Session writes and the writable-key schema

  | key | JSON Schema | suggested TTL | on_drop |
  | --- | --- | --- | --- |
  | `priced_observations` | `object` mapping checkout id (`string`) to `{ "total": integer }` or `{ "unresolvable": true }` | a checkout's working lifetime (e.g. 3600s), sliding | `deny_request` |

  ## Examples

  ### Allowed (disclosed + not overcharged)

  Disclosed `checkout.attribution` on the completion, and the observed grand
  total for `args.id` (`4999`) equals the advertised price (`4999`): allow.

  ### Denied (charged more than the buyer was shown)

  Disclosed attribution, but the observed grand total for `args.id` (`5999`)
  exceeds the advertised price (`4999`): deny.

  ## Composition

  One job (disclosure + no-overcharge on completion). Pair with a spend-cap
  policy (`input.context.mandate.max_total`), merchant allowlisting, or egress
  redaction of buyer PII as needed.
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
package ucp.ingress.attribution_disclosure

# Stateful observe-enforce pair (policy-accessible session state).
#
# OBSERVE (tool_post_invoke, mode "output"): record the observed grand total for
#   a create/update/get checkout response under priced_observations, keyed by
#   checkout id.
# ENFORCE (tool_pre_invoke, mode "input"): on complete_checkout, require disclosed
#   routing attribution AND that the OBSERVED grand total for args.id does not
#   exceed the advertised price. Fail closed when unobserved / unverifiable.

default allow := false

# ---- tool-name matching -----------------------------------------------------
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

result_total_indices contains i if {
    some i, entry in object.get(result, "totals", [])
    lower(object.get(entry, "type", "")) == "total"
    is_number(object.get(entry, "amount", null))
}

resolved_result_total := object.get(result, "totals", [])[i].amount if {
    count(result_total_indices) == 1
    some i in result_total_indices
}

observed_snapshot := {"total": resolved_result_total} if {
    count(result_total_indices) == 1
}

observed_snapshot := {"unresolvable": true} if {
    count(result_total_indices) != 1
}

session_policies := object.get(object.get(input.context, "session", {}), "policies", {})

prior_observations := object.union_n([m |
    some _, ns in session_policies
    m := object.get(ns, "priced_observations", {})
])

session_writes["priced_observations"] := object.union(prior_observations, {result_id: observed_snapshot}) if {
    is_observe
}

# ---- ENFORCE: disclosure + no-overcharge ------------------------------------
args := object.get(input.payload, "args", {})

target_id := object.get(args, "id", "")

# attribution IS a legitimate completion input on the UCP MCP binding; read it
# from the completion's checkout with a top-level args fallback. Agent-supplied
# — this is a disclosure nudge, not enforced provenance (see docs).
attribution := object.get(object.get(args, "checkout", {}), "attribution", object.get(args, "attribution", {}))

attribution_disclosed if {
    count(attribution) > 0
}

# Observed grand total for the completing checkout id.
observed_snapshots_for_target := {snap |
    some _, ns in session_policies
    m := object.get(ns, "priced_observations", {})
    snap := object.get(m, target_id, null)
    snap != null
}

observed_totals_for_target := {t |
    some snap in observed_snapshots_for_target
    t := object.get(snap, "total", null)
    is_number(t)
}

resolvable_observed_total if count(observed_totals_for_target) == 1

observed_total := t if {
    resolvable_observed_total
    some t in observed_totals_for_target
}

# advertised_total is gateway-supplied policy input, NOT a UCP field.
advertised_total := object.get(object.get(input.context, "mandate", {}), "advertised_total", object.get(input.context, "advertised_total", null))

not_overcharged if {
    resolvable_observed_total
    is_number(advertised_total)
    observed_total <= advertised_total
}

verifiable if {
    resolvable_observed_total
    is_number(advertised_total)
}

# ---- decision ---------------------------------------------------------------
allow if {
    not is_enforce
}

allow if {
    is_enforce
    attribution_disclosed
    not_overcharged
}

decision := {"allow": allow, "session_writes": session_writes}

# ---- reasons ----------------------------------------------------------------
reasons contains "This checkout is being completed without disclosed routing attribution. Populate checkout.attribution with the referral/aggregation trail before completing. Contact your commerce-governance owner if this needs to change." if {
    is_enforce
    not attribution_disclosed
}

reasons contains msg if {
    is_enforce
    attribution_disclosed
    verifiable
    observed_total > advertised_total
    msg := sprintf("Observed checkout grand total (%d) exceeds the price the buyer was shown (%d, minor units). The buyer must not be charged more than the advertised total.", [observed_total, advertised_total])
}

reasons contains "Cannot verify the observed total against the price shown: there is no resolvable observed grand total for this checkout in the session, or no advertised price was supplied in policy context. Read or update the checkout through the gateway before completing it, and supply the advertised price. Completing a checkout whose grand total cannot be unambiguously checked against the price shown is not permitted." if {
    is_enforce
    attribution_disclosed
    not verifiable
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
