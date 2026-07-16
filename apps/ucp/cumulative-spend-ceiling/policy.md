---
name: Cumulative Spend Ceiling Across a Session
tags:
  - ucp
  - agentic-commerce
  - session-state
  - spend-control
  - checkout
  - budget
  - ingress
publishedAt: 2026-06-27
description: |
  # ucp / cumulative-spend-ceiling

  **Direction:** ingress (`tool_pre_invoke`) — enforce leg. Requires a
  companion `tool_post_invoke` binding for the observe leg (see below).
  **Default:** allow; deny an over-ceiling `complete_checkout`
  **Package:** `ucp.ingress.cumulative_spend_ceiling`
  **Pattern:** stateful observe-enforce pair (policy-accessible session state)

  ## What it does

  Enforces a running spend ceiling across every `complete_checkout` an agent
  performs within a session. `complete_checkout` on the confirmed UCP MCP binding
  carries only the checkout `id` (top level) and finalization data — **no
  totals**. So the amount each completion commits is observed from an earlier
  `create_checkout` / `update_checkout` / `get_checkout` **response** into
  policy-accessible session state; at `complete_checkout` the policy adds the
  observed total for `args.id` to the running total committed by prior checkouts
  in the same session and **denies** when the projected total would exceed the
  org budget (`input.context.mandate.session_budget`).

  This is buyer-side governance — you govern the agents *you* run. It is
  impossible without cross-call memory: UCP is stateless on the wire and carries
  no budget or running-total field, so both the ceiling and the accumulated state
  are gateway-supplied policy inputs, not UCP fields.

  ## The observe-enforce pair (bind BOTH hooks)

  `direction` in the catalog is a single value and the decision is made at
  ingress, so this is registered as `ingress`. It is correct only when its
  package is bound to **both** gateway hooks on the same MCP session:

  - **`tool_post_invoke` (observe, `input.mode == "output"`)** — record the
    checkout's observed grand total under the object-valued key
    `ceiling_observations`, keyed by checkout id, merged with prior observations.
  - **`tool_pre_invoke` (enforce, `input.mode == "input"`)** — on
    `complete_checkout`, project `running_total + observed_total[args.id]` and
    decide.

  ## Sliding TTL, not a periodic budget

  This is a **per-SESSION cumulative ceiling with a sliding TTL**, not a per-day
  or otherwise time-bucketed budget. Each write refreshes the TTL on the state
  keys; when the session's state expires, the running total resets to zero. A
  true periodic (e.g. daily) budget needs a gateway-supplied trusted clock and a
  reset boundary the policy can key on; that is tracked as a gateway follow-up
  and is intentionally out of scope here. Do not read a completion timestamp off
  the request payload — an agent-supplied clock is not trustworthy.

  ## Replay / double-count protection

  A completion is **consumed**: on an allowed `complete_checkout` the policy both
  advances `running_total` to the projected total **and** removes that checkout
  id from `ceiling_observations`. A replayed completion for the same id then
  finds no observation on file and fails closed, so the same checkout can never
  add to the running total twice.

  ## Marker discovery, no hard-coded writer id

  An earlier revision hard-coded this policy's own `writer_id` string to find its
  namespace. That is removed: the gateway derives `writer_id` server-side and
  auto-namespaces the writes, so the policy now finds its state the way the other
  stateful policies do — it iterates `input.context.session.policies` and reads
  the `running_total` and `ceiling_observations` keys wherever they appear (those
  keys are this policy's marker). Reads use set semantics, so a degenerate
  multi-namespace session can only deny, never raise an evaluation conflict. Per
  the session-state contract a policy cannot read its own same-evaluation write;
  observe and enforce are separate evaluations.

  ## An honest concession about the earlier emission

  In the previous revision the running-total advance was emitted only as a
  top-level `session_writes` rule, and the policy defined no `decision` object.
  On a gateway that reads writes from the nested `decision.session_writes`
  envelope, that emission was silently non-functional standalone — the running
  total never advanced. This revision defines
  `decision := { "allow": allow, "session_writes": session_writes }` and emits
  the advance through it, so the ceiling actually accumulates.

  ## Session writes and the writable-key schema

  | key | JSON Schema | suggested TTL | on_drop |
  | --- | --- | --- | --- |
  | `running_total` | `integer` (minor units committed so far this session) | session working lifetime, sliding — each advance refreshes it | `deny_request` |
  | `ceiling_observations` | `object` mapping checkout id (`string`) to `{ "total": integer }` or `{ "unresolvable": true }` | same, sliding | `deny_request` |

  `on_drop: deny_request` keeps a lost running total from silently resetting a
  ceiling to zero mid-session. (Per the session-state contract the gateway's
  per-minute rate-limit drops never flip `allow` regardless of `on_drop`.)

  ## Fail-closed and fail-open boundaries

  - **No budget supplied** (`input.context.mandate.session_budget` absent) — the
    policy does **not** gate (fail-open on a missing mandate): with no ceiling
    configured there is nothing to enforce.
  - **Budget supplied but no resolvable observation for `args.id`** — the policy
    fails **closed** and denies: it cannot project a total it never observed.
  - **Budget supplied, observation present, projected over budget** — deny.

  ## Examples

  ### Allowed (under ceiling, advances the running total)

  Prior `running_total` is `4000`; the completing checkout was observed at
  `3000`; budget is `10000`. Projected `7000 <= 10000`, so completion is allowed
  and the policy advances `running_total` to `7000` and consumes the checkout id.

  ### Denied (over ceiling)

  Prior `running_total` is `8500`; the completing checkout was observed at
  `3000`; budget is `10000`. Projected `11500 > 10000`, so completion is denied
  and no write is made (a blocked checkout must not advance the running total).

  ## Scope and honest limits

  - **MCP path only.** Governs the agents you run on the MCP path; the browser
    `continue_url` handoff is not visible.
  - **Requires policy-accessible session state.** On a gateway without it, the
    observe write is a no-op and the running total never advances; the ceiling
    degrades to a per-call check against an empty running total. Deploy only on a
    session-state-capable build.
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
package ucp.ingress.cumulative_spend_ceiling

# Stateful observe-enforce pair (policy-accessible session state).
#
# OBSERVE (tool_post_invoke, mode "output"): record the observed grand total
#   for a create/update/get checkout response under ceiling_observations, keyed
#   by checkout id, merged with prior observations.
# ENFORCE (tool_pre_invoke, mode "input"): on complete_checkout, project
#   running_total + observed_total[args.id] and DENY when it exceeds the budget.
#   On an allowed completion, advance running_total and CONSUME the observed id
#   (remove it) so a replayed completion cannot double-count.

default allow := true

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

# ---- OBSERVE ----------------------------------------------------------------
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
    m := object.get(ns, "ceiling_observations", {})
])

session_writes["ceiling_observations"] := object.union(prior_observations, {result_id: observed_snapshot}) if {
    is_observe
}

# ---- ENFORCE: read prior running total and this checkout's observation ------
args := object.get(input.payload, "args", {})

target_id := object.get(args, "id", "")

# Prior committed running total, via marker discovery over any namespace
# carrying our running_total key. Default 0 for the first checkout; a degenerate
# multi-value session leaves it undefined so the completion fails closed.
prior_running_totals := {rt |
    some _, ns in session_policies
    rt := object.get(ns, "running_total", null)
    is_number(rt)
}

prior_total := 0 if {
    count(prior_running_totals) == 0
}

prior_total := rt if {
    count(prior_running_totals) == 1
    some rt in prior_running_totals
}

# Observed total for the completing checkout id.
observed_snapshots_for_target := {snap |
    some _, ns in session_policies
    m := object.get(ns, "ceiling_observations", {})
    snap := object.get(m, target_id, null)
    snap != null
}

has_observation if count(observed_snapshots_for_target) > 0

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

session_budget := object.get(object.get(input.context, "mandate", {}), "session_budget", null)

projected := prior_total + observed_total

within_budget if {
    is_number(projected)
    projected <= session_budget
}

# ---- decision ---------------------------------------------------------------
# Deny only an over-ceiling / unverifiable complete_checkout. With no budget
# supplied the policy does not gate (fail-open on missing mandate).
allow := false if {
    is_enforce
    is_number(session_budget)
    not within_budget
}

decision := {"allow": allow, "session_writes": session_writes}

# ---- session writes on an allowed completion --------------------------------
# Advance the running total AND consume the observed id so a replayed completion
# fails closed. Both fire only for an allowed (within-budget) completion.
session_writes["running_total"] := projected if {
    is_enforce
    is_number(session_budget)
    within_budget
}

session_writes["ceiling_observations"] := object.remove(prior_observations, {target_id}) if {
    is_enforce
    is_number(session_budget)
    within_budget
}

# ---- reasons ----------------------------------------------------------------
reasons contains "No observed total for this checkout id in the session, so the projected session spend cannot be computed. Read or update the checkout through the gateway before completing it." if {
    is_enforce
    is_number(session_budget)
    not has_observation
}

reasons contains "The observed grand total for this checkout could not be resolved to exactly one numeric total, so the session spend ceiling cannot be enforced; completion is refused." if {
    is_enforce
    is_number(session_budget)
    has_observation
    not resolvable_observed_total
}

reasons contains msg if {
    is_enforce
    is_number(session_budget)
    resolvable_observed_total
    is_number(prior_total)
    projected > session_budget
    msg := sprintf(
        "session spend ceiling exceeded: prior=%d + this=%d = %d > budget=%d (minor units)",
        [prior_total, observed_total, projected, session_budget],
    )
}

reason := joined if {
    count(reasons) > 0
    joined := concat("; ", sort([r | some r in reasons]))
}
```
