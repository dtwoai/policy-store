---
name: Bind Checkout Completion To Approved Cart
tags:
  - ucp
  - agentic-commerce
  - checkout
  - session-state
  - prompt-injection
  - access-control
  - governance
  - ingress
publishedAt: 2026-06-27
description: |
  # ucp / approved-cart-integrity

  **Direction:** ingress (`tool_pre_invoke`) — enforce leg. Requires a
  companion `tool_post_invoke` binding for the observe leg (see below).
  **Default:** deny completion unless a live approval is on file for the checkout; allow otherwise
  **Package:** `ucp.ingress.approved_cart_integrity`
  **Pattern:** stateful observe-enforce pair (policy-accessible session state)

  ## What it does

  Binds `complete_checkout` to the cart the merchant confirmed **completable**
  for that checkout — on the checkout the approval was recorded for, exactly
  once. The threat is prompt injection (the Unit 42 gift-card scenario): a
  poisoned tool result or page convinces the agent to swap a SKU, bump a
  quantity, or add a high-value gift card *after* the cart reached its approved,
  ready-to-finalize state but *before* the checkout is finalized.

  ## Server-asserted approval (re-sourced to the real spec)

  On the confirmed UCP MCP binding, `complete_checkout` args carry only the
  checkout `id` (top level) and finalization data — **no `line_items`, no
  `status`**. And `update_checkout` args carry **no `status`** either. So the old
  trigger (an `update_checkout` *request* whose `checkout.status` was
  `ready_for_complete`) can never fire against the real arg shape.

  This revision sources approval from the **server's response** instead: on a
  `create_checkout` / `update_checkout` / `get_checkout` **response**
  (`input.mode == "output"`) whose `status == "ready_for_complete"`, the policy
  records the checkout id and the server-returned `line_items` as the approved
  baseline. Server-asserted `ready_for_complete` is a stronger signal than an
  agent-submitted status: it is the merchant confirming the cart is in its
  completable state, not the agent asserting it.

  ### Bind BOTH hooks

  - **`tool_post_invoke` (observe, `input.mode == "output"`)** — record / update
    the approval under the object-valued key `approved_carts`, keyed by checkout
    id.
  - **`tool_pre_invoke` (enforce, `input.mode == "input"`)** — on
    `complete_checkout`, look up `args.id` and decide.

  ## Record, invalidate, cancel, consume

  - **Record (observe).** A `ready_for_complete` response records
    `approved_carts[id] = { approved: true, line_items: <normalized baseline> }`.
    A *fresh* `ready_for_complete` response for the same id re-records it with the
    new baseline (the merchant re-confirmed the current cart).
  - **Invalidate (observe).** A later response for that id whose status is **not**
    `ready_for_complete` (e.g. back to `incomplete` / `requires_escalation`)
    writes a tombstone `{ approved: false }`. A post-approval cart mutation that
    takes the checkout out of its ready state therefore clears the approval; a
    fresh `ready_for_complete` re-records it.
  - **Cancel.** `cancel_checkout` for the id writes the same tombstone.
    `cancel_checkout` **exists** on the confirmed tool surface (args
    `{ meta?, id }`); an earlier revision wrongly claimed it did not and skipped
    it — this revision handles it.
  - **Consume (enforce).** An approval is **single-use**: an allowed completion
    writes the tombstone for that id, so a replayed `complete_checkout` finds no
    live approval and fails closed.

  ## Enforce

  - **Allow** when a **live** approval is on file for `args.id`
    (`approved_carts[args.id].approved == true`). Because the approval is keyed by
    checkout id, an approval for one checkout can never authorize another — the
    lookup is the binding.
  - **Content comparison at completion is impossible on the real surface.**
    `complete_checkout` carries no `line_items`, so the allow path does **not**
    require a content match against the completion request (that leg has been
    removed). As **defense in depth**, if the completion *does* echo
    `checkout.line_items` (some servers may) and they diverge from the approved
    baseline, the policy denies.
  - **Fail closed** when no live approval is on file for `args.id` (never
    recorded, invalidated by a mutation, cancelled, or already consumed).

  ## Marker discovery, no hard-coded writer id

  The gateway auto-namespaces this policy's writes under `policies.<writer_id>`.
  The policy never hard-codes `writer_id`: it iterates
  `input.context.session.policies` and reads the `approved_carts` key wherever it
  appears (its marker). Reads use set semantics, so a live approval requires the
  observed `approved` flags for the id to be unanimously `true`; a degenerate
  multi-namespace session can only deny, never raise a conflict. Per the
  session-state contract a policy cannot read its own same-evaluation write;
  observe and enforce are separate evaluations.

  ## Honest scope and limitations

  - **The human-consent claim rides on what drives your server to
    `ready_for_complete`.** This policy keys approval off the server asserting the
    cart is completable. If, in your flow, reaching `ready_for_complete` genuinely
    reflects human review, the control binds completion to that. A tampering
    update that legitimately re-reaches `ready_for_complete` re-records the new
    cart. So the guarantee is narrow but real: *completion is bound to the cart
    state the merchant last confirmed completable, unchanged since* — the policy
    does not itself verify a human was in the loop.
  - **Buyer-side governance, MCP path only.** A browser `continue_url` handoff is
    not visible.
  - **Identity / quantity only.** The baseline compares item id and quantity, not
    price/currency/fulfillment — pair with the totals/price policies for those.
  - **Requires policy-accessible session state.** Without it the observe write is
    a no-op and every completion denies fail-closed. Deploy only on a
    session-state-capable build.

  ## Session writes and the writable-key schema

  | key | JSON Schema | suggested TTL | on_drop |
  | --- | --- | --- | --- |
  | `approved_carts` | `object` mapping checkout id (`string`) to `{ "approved": boolean, "line_items": array of {id,item_id,quantity} }` | a checkout's working lifetime (e.g. 3600s), sliding — each write refreshes it | `deny_request` |

  `on_drop: deny_request` is deliberate: if the baseline cannot be persisted, a
  later `complete_checkout` must fail closed rather than fall through to allow.
  (Per the session-state contract the gateway's per-minute rate-limit drops never
  flip `allow` regardless of `on_drop`.)
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
package ucp.ingress.approved_cart_integrity

# Stateful observe-enforce pair (policy-accessible session state).
#
# OBSERVE (tool_post_invoke, mode "output"):
#   - a ready_for_complete response RECORDS approved_carts[id] =
#     { approved: true, line_items: <normalized baseline> };
#   - any other status for that id writes a tombstone { approved: false };
#   - cancel_checkout writes the tombstone too.
# ENFORCE (tool_pre_invoke, mode "input"): on complete_checkout, ALLOW when a
#   live approval is on file for args.id; DENY on no live approval (fail closed)
#   or on a divergent echoed cart (defense in depth). An allowed completion
#   CONSUMES the approval (tombstone) so a replay fails closed.

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

cancel_checkout_shapes := {
    "cancel_checkout",
    "cancel-checkout",
    "cancelcheckout",
}

# Tools whose RESPONSE carries the checkout state we observe for approval.
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

# ---- OBSERVE ----------------------------------------------------------------
result := object.get(input.payload, "result", {})

result_id := object.get(result, "id", "")

result_status := lower(object.get(result, "status", ""))

# Normalize a line_items array (nested item.id) to an order-independent list of
# {id, item_id, quantity} so the comparison ignores display-only fields.
observed_baseline := [entry |
    some li in object.get(result, "line_items", [])
    entry := {
        "id": object.get(li, "id", ""),
        "item_id": object.get(object.get(li, "item", {}), "id", ""),
        "quantity": object.get(li, "quantity", 0),
    }
]

is_approval_record if {
    input.mode == "output"
    tool_matches(observe_tool_shapes)
    result_id != ""
    result_status == "ready_for_complete"
}

is_invalidation if {
    input.mode == "output"
    tool_matches(observe_tool_shapes)
    result_id != ""
    result_status != "ready_for_complete"
}

# cancel_checkout carries the id at the top level of args (mode input) or in the
# response (mode output). A cancel clears the approval for that id.
args := object.get(input.payload, "args", {})

cancel_target_id := object.get(args, "id", object.get(result, "id", ""))

is_cancel if {
    tool_matches(cancel_checkout_shapes)
    cancel_target_id != ""
}

session_policies := object.get(object.get(input.context, "session", {}), "policies", {})

prior_approved := object.union_n([m |
    some _, ns in session_policies
    m := object.get(ns, "approved_carts", {})
])

# Record a fresh approval.
session_writes["approved_carts"] := object.union(prior_approved, {result_id: {"approved": true, "line_items": observed_baseline}}) if {
    is_approval_record
}

# Invalidate on any non-ready response for the id.
session_writes["approved_carts"] := object.union(prior_approved, {result_id: {"approved": false, "line_items": []}}) if {
    is_invalidation
}

# Invalidate on cancel.
session_writes["approved_carts"] := object.union(prior_approved, {cancel_target_id: {"approved": false, "line_items": []}}) if {
    is_cancel
}

# ---- ENFORCE ----------------------------------------------------------------
is_enforce if {
    input.mode == "input"
    tool_matches(complete_checkout_shapes)
}

# complete_checkout carries the checkout id at the TOP LEVEL of args.
target_id := object.get(args, "id", "")

# Approval entries recorded for the completing checkout id, across marker-
# carrying namespaces (set semantics keep the read total and conflict-free).
approved_entries_for_target := {e |
    some _, ns in session_policies
    m := object.get(ns, "approved_carts", {})
    e := object.get(m, target_id, null)
    e != null
}

# The set of `approved` flags recorded for the id. A live approval requires the
# flags to be unanimously true, so a degenerate mixed session denies.
approved_flags_for_target := {b |
    some e in approved_entries_for_target
    b := object.get(e, "approved", false)
}

live_approval if {
    approved_flags_for_target == {true}
}

# The approved baseline as an order-independent set (union over the live
# approval entries; one namespace in the normal case).
approved_baseline_set := {entry |
    some e in approved_entries_for_target
    object.get(e, "approved", false) == true
    some li in object.get(e, "line_items", [])
    entry := {
        "id": object.get(li, "id", ""),
        "item_id": object.get(li, "item_id", ""),
        "quantity": object.get(li, "quantity", 0),
    }
}

# Defense in depth: complete_checkout normally carries no line_items, but if a
# server echoes them, normalize and compare against the approved baseline.
submitted_line_items := object.get(object.get(args, "checkout", {}), "line_items", [])

submitted_present if count(submitted_line_items) > 0

normalized_submitted := {entry |
    some li in submitted_line_items
    entry := {
        "id": object.get(li, "id", ""),
        "item_id": object.get(object.get(li, "item", {}), "id", ""),
        "quantity": object.get(li, "quantity", 0),
    }
}

divergent_echo if {
    submitted_present
    normalized_submitted != approved_baseline_set
}

allowed_completion if {
    is_enforce
    live_approval
    not divergent_echo
}

# ---- decision ---------------------------------------------------------------
# Everything that is not the enforce leg passes through: observe responses,
# cancel calls, other tools, and the complete_checkout response itself.
allow if {
    not is_enforce
}

allow if {
    allowed_completion
}

# Consume the approval on an allowed completion so a replay fails closed.
session_writes["approved_carts"] := object.union(prior_approved, {target_id: {"approved": false, "line_items": []}}) if {
    allowed_completion
}

decision := {"allow": allow, "session_writes": session_writes}

# ---- reasons ----------------------------------------------------------------
reasons contains "Checkout completion blocked: no live human-approved cart is on file for this checkout in this session. Approvals are single-use and are consumed by a successful completion, and are cleared by a cart mutation that leaves the ready-to-finalize state or by cancel_checkout; the merchant must re-confirm the checkout as ready_for_complete before completing." if {
    is_enforce
    not live_approval
}

reasons contains "Checkout completion does not match the cart the merchant confirmed completable. The echoed line items diverge from the approved baseline recorded at approval time." if {
    is_enforce
    live_approval
    divergent_echo
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
