---
name: Shopify Bind Checkout Completion To Approved Cart
tags:
  - shopify
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
  # shopify / approved-cart-integrity

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on divergence, allow otherwise
  **Package:** `shopify.ingress.approved_cart_integrity`
  **Pattern:** stateful observe-enforce pair (policy-accessible session state)

  ## What it does

  Binds `complete_checkout` to the cart the human buyer actually approved —
  on the checkout the approval was recorded for, exactly once.

  This is a single policy that acts in two phases across two hook
  evaluations on the same MCP session:

  - **Observe** — on the call that records human approval of the cart
    (`update_checkout` that moves the checkout to `ready_for_complete`),
    the policy snapshots the approved `line_items` AND the checkout's `id`
    into session state under its own writer namespace
    (`approved_line_items`, `approval_recorded`, `approved_checkout_id`).
  - **Enforce** — on the later `complete_checkout` call, the policy reads
    that snapshot back from session state and **denies** if the completion
    targets a different checkout `id` than the approval was recorded for,
    or if the submitted `line_items` diverge from the approved baseline by
    item id or quantity.
  - **Consume** — an approval is **single-use**: on an allowed completion
    the policy emits session writes that clear the approval
    (`approval_recorded := false`, baseline and checkout id emptied), so a
    replayed `complete_checkout` fails closed instead of double-completing.

  The threat is prompt injection (the Unit 42 gift-card scenario): a
  poisoned tool result or page convinces the agent to swap the SKU, bump
  the quantity, or add a high-value gift card *after* the human said "yes"
  but *before* the checkout is finalized. A stateless policy cannot see
  that the cart changed since approval — it only sees the request in front
  of it. By recording the human-approved baseline at approval time and
  comparing at completion time, this policy makes a silent post-approval
  swap a hard deny.

  ## Why ingress

  `complete_checkout` is a write with permanent side effects (it charges
  the buyer and creates an order). The divergence is fully determined by
  the request payload compared against recorded state, so denying at
  ingress prevents the altered order from ever being placed.

  ## Why this is stateful (and why it must be)

  The "approved cart" is not a field on the `complete_checkout` request —
  it is a fact about something the human did on an *earlier* call. UCP
  carries no "previously approved" marker, so the only way to know the
  baseline at completion time is to have recorded it at approval time.
  That is exactly what DTwo session state provides: the policy
  returns `decision.session_writes` at approval; the gateway auto-
  namespaces those writes under `policies.<writer_id>` and injects them
  into `input.context.session` on the next evaluation in the session.

  Per the session-state contract, a policy cannot read what it wrote in the *same*
  evaluation — `input.context.session` always serves pre-state. The
  observe write and the enforce read therefore land on two different
  evaluations (the approval-recording call, then the completion call),
  which is the supported cross-evaluation read path. The policy never
  hard-codes its own `writer_id`; the gateway derives it server-side and
  the read iterates over `input.context.session.policies` to find the
  baseline the gateway namespaced for this same policy.

  ## How it matches

  ### Observe (record the approved baseline)

  All of:

  - **Tool match.** Lowercased `input.resource.name` matches a known shape of
    `update_checkout` (hyphenated / underscored / collapsed suffix, or the
    bare name).
  - **Approval transition.** `input.payload.args.checkout.status` is
    `ready_for_complete` (the buyer-approved, ready-to-finalize state in
    the UCP checkout status enum).

  On a match the policy emits:

  ```text
  decision.session_writes.approved_line_items  := <normalized baseline>
  decision.session_writes.approval_recorded    := true
  decision.session_writes.approved_checkout_id := <checkout.id>
  ```

  The baseline is normalized to the set of `{id, item_id, quantity}` tuples
  (using `line_items[].id`, `line_items[].item.id`, and
  `line_items[].quantity`) so the comparison is order-independent and
  ignores display-only fields.

  ### Enforce (deny divergence at completion)

  - **Tool match.** Lowercased `input.resource.name` matches a known shape of
    `complete_checkout` (hyphenated / underscored / collapsed suffix, or the
    bare name).
  - **Read baseline.** The policy reads `approved_line_items` and
    `approved_checkout_id` from its own namespace under
    `input.context.session.policies` (the gateway injected them from the
    observe step).
  - **Deny on checkout mismatch.** If the completing checkout's `id` does
    not equal the recorded `approved_checkout_id`, the call is denied even
    when the line items are identical — the approval is bound to the
    checkout it was given on, and the reason names both ids.
  - **Deny when divergent.** If the submitted
    `input.payload.args.checkout.line_items` normalize to a set that is not
    equal to the approved baseline set, the call is denied.

  Equal sets on the approved checkout pass. A submitted cart that changes
  any item id, changes any quantity, adds a line, or drops a line produces
  a different set and is denied; a completion for any other checkout id is
  denied regardless of content.

  ### Consume (an approval is single-use)

  On an allowed completion — approval on file, matching checkout id,
  matching baseline — the policy emits:

  ```text
  decision.session_writes.approval_recorded    := false
  decision.session_writes.approved_line_items  := []
  decision.session_writes.approved_checkout_id := ""
  ```

  The approval is consumed by the completion it authorized. A replayed
  `complete_checkout` (double-completion) then finds no live approval on
  file and fails closed. The observe writes and the consume writes are
  mutually exclusive by construction — the approval-record call and the
  completion call are different tools, and the consume rule additionally
  requires `not is_approval_record` — so the two write phases can never
  fire on one call.

  ### Fail-closed if approval was never recorded

  If a `complete_checkout` arrives and no live approval is on file in this
  session (`approval_recorded` absent, or already consumed by a prior
  completion), the policy denies. A completion with no
  human-approval-of-record on file is exactly the injection shape this
  policy exists to stop. Operators who genuinely complete checkouts
  without a recorded approval step should not deploy this policy on that
  flow.

  ### Abandoned checkouts

  There is no cancellation tool in the confirmed UCP tool surface, so the
  policy does not (and cannot) clear an approval on "cancel". It does not
  need to: an abandoned checkout's approval is bound to that checkout's
  `id` and can never authorize a different checkout, and the session-state
  TTL on the approval keys clears it otherwise.

  ## Tool naming on the gateway

  DTwo prepends the configured MCP server name to tool names, that prefix is
  not standardized across deployments, and federated names are commonly
  slugified (underscores become hyphens, e.g. `ucp-shop-complete-checkout`).
  This policy matches hyphenated, underscored, and collapsed suffix shapes of
  the OpenRPC operations (`update_checkout`, `complete_checkout`), plus the
  bare un-prefixed names, so it stays portable. Confirm the exact tool names
  your gateway sends with the dump-input debug technique before deploying.

  ## Session writes and the writable-key schema

  This policy writes three keys; all must be declared in the policy's
  writable-key schema (authored alongside the policy and shipped to the
  gateway in its policy configuration):

  | key | JSON Schema | suggested TTL | on_drop |
  | --- | --- | --- | --- |
  | `approved_line_items` | `array` of `{id,item_id,quantity}` objects | a checkout's working lifetime (e.g. 3600s) | `deny_request` |
  | `approval_recorded` | `boolean` | same as above | `deny_request` |
  | `approved_checkout_id` | `string` | same as above | `deny_request` |

  `on_drop: deny_request` is deliberate: if the baseline cannot be
  persisted, a later `complete_checkout` must not silently fall through to
  allow. (Note that per the session-state contract the gateway's per-minute rate-limit drops
  never flip `allow` regardless of `on_drop` — that is a load-shedding
  defense, not the author's intent.)

  ## Examples

  ### Allowed (completion matches the approved baseline, on the approved checkout)

  Prior `update_checkout` recorded `approved_line_items` for SKU
  `prod_sweater` x2 on checkout `chk_9f2b`. The `complete_checkout`
  submits the same cart for the same checkout:

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "shopify-mcp-complete_checkout", "type": "tool" },
      "payload": {
        "name": "complete_checkout",
        "args": {
          "checkout": {
            "id": "chk_9f2b",
            "status": "complete_in_progress",
            "line_items": [
              { "id": "li_1", "item": { "id": "prod_sweater" }, "quantity": 2 }
            ]
          }
        }
      },
      "context": {
        "session": {
          "policies": {
            "approved-cart-integrity": {
              "approval_recorded": true,
              "approved_checkout_id": "chk_9f2b",
              "approved_line_items": [
                { "id": "li_1", "item_id": "prod_sweater", "quantity": 2 }
              ]
            }
          }
        }
      }
    }
  }
  ```

  `allow = true`, no reason — and the decision carries the consume writes
  (`approval_recorded := false`, `approved_line_items := []`,
  `approved_checkout_id := ""`), so replaying this same completion is
  denied fail-closed.

  ### Denied (gift-card swap after approval)

  Same approved baseline (`prod_sweater` x2), but the completion now
  submits a `$500` gift card the buyer never approved:

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "mode": "input",
      "resource": { "name": "shopify-mcp-complete_checkout", "type": "tool" },
      "payload": {
        "name": "complete_checkout",
        "args": {
          "checkout": {
            "id": "chk_9f2b",
            "status": "complete_in_progress",
            "line_items": [
              { "id": "li_1", "item": { "id": "prod_sweater" }, "quantity": 2 },
              { "id": "li_2", "item": { "id": "prod_giftcard_500" }, "quantity": 1 }
            ]
          }
        }
      },
      "context": {
        "session": {
          "policies": {
            "approved-cart-integrity": {
              "approval_recorded": true,
              "approved_checkout_id": "chk_9f2b",
              "approved_line_items": [
                { "id": "li_1", "item_id": "prod_sweater", "quantity": 2 }
              ]
            }
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Checkout completion does not match the cart the buyer approved. The submitted line items diverge from the approved baseline recorded at approval time."`.

  ## Scope and honest limitations

  - **Buyer-side governance, MCP path only.** This policy governs the
    agents *you* run, on the MCP requests they make. If your checkout flow
    hands the buyer off to a browser via the top-level `continue_url`,
    anything that happens in that browser session is **not visible** to
    this policy. It binds completion to approval *on the MCP path*, not
    end-to-end. DTwo is complementary to UCP and Shopify here, not a
    competing trust referee.
  - **Approval is identified by the `ready_for_complete` transition.** The
    policy treats the `update_checkout` that sets
    `status: ready_for_complete` as the human-approval-of-record. If your
    flow signals approval differently (a distinct tool, a buyer-review
    message), adjust `is_approval_record` to match that signal. The point
    of truth is whatever call genuinely represents human consent in your
    flow.
  - **Identity / quantity only.** The baseline compares item id and
    quantity. It does not pin price, totals, currency, fulfillment, or
    buyer fields — pair this with the egress totals/price-integrity
    policies if you need those bound too. Comparing the per-unit `price`
    here would falsely deny on a legitimate merchant repricing between
    approval and completion.
  - **No identity-based exemptions.** All callers are treated the same. A
    break-glass override would be a separate `allow if` branch gated on
    `input.subject.claims`.
  - **Requires a gateway that ships policy-accessible session state.** On a gateway
    without `input.context.session` and `decision.session_writes`, the
    observe write is a no-op and the enforce read is always empty, so the
    policy degrades to denying every recorded-approval completion. Deploy
    only on a session-state-capable build.

  ## A note on caps and budgets (not a UCP field)

  This policy needs no spend caps or merchant allowlists — it binds the
  *content* of the completion to the *content* of the approval. If you do
  add caps (max total, currency, merchant allowlist), remember those are
  **DTwo-supplied policy input** injected by the gateway at
  `input.context.mandate.*`. They are not UCP checkout fields. The UCP
  object carries the buyer's spending constraints only as an opaque AP2
  SD-JWT (`checkout.ap2.checkout_mandate`), which Rego does not read
  directly.
direction: ingress
apps:
  - shopify
industries:
  - retail
bundles:
  - agentic-commerce
schemaVersion: "1.0.0"
minimumGatewayVersion: 1.0.0-session-state
---

```rego
package shopify.ingress.approved_cart_integrity

# Stateful observe-enforce pair (policy-accessible session state).
#
# OBSERVE: on the buyer-approval call (update_checkout -> ready_for_complete),
#   snapshot the approved line items AND the checkout's id into this policy's
#   own session namespace.
# ENFORCE: on complete_checkout, read that snapshot back (the gateway injects
#   it under input.context.session.policies.<writer_id>) and DENY if the
#   completion targets a different checkout id than the one approved, or if
#   the submitted line items diverge from the approved baseline.
# CONSUME: an approval is single-use. On an allowed completion the policy
#   emits session writes that clear the approval (approval_recorded := false,
#   baseline and checkout id emptied), so a replayed completion fails closed.
#
# Per the session-state contract a policy cannot read what it wrote in the same evaluation
# (input.context.session is pre-state only); the write and the read are on
# two separate evaluations in the same session. The policy never hard-codes
# its own writer_id: the enforce read iterates input.context.session.policies
# to find the baseline the gateway namespaced for this same policy.

default allow := false

# ---- tool-name matching ----
# The gateway prepends a server prefix and commonly slugifies underscores to
# hyphens when federating tool names ("ucp-shop-complete-checkout"), so match
# hyphenated, underscored, and collapsed shapes of each op — anchored at a
# "-"/"_" separator — plus the bare un-prefixed name.

tool_name := lower(object.get(input.resource, "name", ""))

update_checkout_shapes := {
	"update_checkout",
	"update-checkout",
	"updatecheckout",
}

complete_checkout_shapes := {
	"complete_checkout",
	"complete-checkout",
	"completecheckout",
}

tool_matches(shapes) if shapes[tool_name]

tool_matches(shapes) if {
	some shape in shapes
	endswith(tool_name, sprintf("-%s", [shape]))
}

tool_matches(shapes) if {
	some shape in shapes
	endswith(tool_name, sprintf("_%s", [shape]))
}

is_approval_record if {
	tool_matches(update_checkout_shapes)
	checkout := object.get(input.payload.args, "checkout", {})
	lower(object.get(checkout, "status", "")) == "ready_for_complete"
}

is_complete_checkout if {
	tool_matches(complete_checkout_shapes)
}

# ---- baseline normalization ----
# Reduce a line_items array to an order-independent set of
# {id, item_id, quantity} so the comparison ignores display-only fields
# and array ordering.

submitted_line_items := object.get(object.get(input.payload.args, "checkout", {}), "line_items", [])

# The id of the checkout this call operates on. Read at observe time to bind
# the approval to a specific checkout, and at enforce time to check that the
# completion targets that same checkout.
submitted_checkout_id := object.get(object.get(input.payload.args, "checkout", {}), "id", "")

normalized_submitted := {entry |
	some li in submitted_line_items
	entry := {
		"id": object.get(li, "id", ""),
		"item_id": object.get(object.get(li, "item", {}), "id", ""),
		"quantity": object.get(li, "quantity", 0),
	}
}

# ---- OBSERVE: record the approved baseline ----

session_writes["approved_line_items"] := baseline if {
	is_approval_record
	baseline := [entry |
		some li in submitted_line_items
		entry := {
			"id": object.get(li, "id", ""),
			"item_id": object.get(object.get(li, "item", {}), "id", ""),
			"quantity": object.get(li, "quantity", 0),
		}
	]
}

session_writes["approval_recorded"] := true if {
	is_approval_record
}

# Bind the approval to the checkout it was given on: record the checkout's id
# alongside the baseline. A completion for any OTHER checkout id must not be
# authorized by this approval (so an abandoned checkout's stale approval can
# never leak onto a new one).
session_writes["approved_checkout_id"] := submitted_checkout_id if {
	is_approval_record
}

# ---- CONSUME: an approval is single-use ----
# On an allowed completion (same conditions as the completion allow rule,
# restated to avoid recursing through `allow`), clear the approval so a
# replayed complete_checkout fails closed. `not is_approval_record` keeps the
# consume writes and the observe writes mutually exclusive by construction —
# they assign different values to the same keys and must never fire together
# (the tool-shape sets are already disjoint; this makes the exclusion
# explicit).
completion_consumes_approval if {
	is_complete_checkout
	not is_approval_record
	approval_on_file
	checkout_id_matches
	approved_baseline_set == normalized_submitted
}

session_writes["approval_recorded"] := false if {
	completion_consumes_approval
}

session_writes["approved_line_items"] := [] if {
	completion_consumes_approval
}

session_writes["approved_checkout_id"] := "" if {
	completion_consumes_approval
}

decision := {"allow": allow, "session_writes": session_writes}

# The observe call itself is allowed to proceed.
allow if {
	is_approval_record
}

# Any tool that is neither the approval-record call nor a completion is out
# of scope for this policy and passes through.
allow if {
	not is_approval_record
	not is_complete_checkout
}

# ---- ENFORCE: read this policy's own namespace from session state ----
# The gateway auto-namespaces our prior writes under policies.<writer_id>.
# We don't know writer_id as a literal, so we read the baseline from whatever
# namespace carries our own recorded marker (approval_recorded). We never
# bind a single "own namespace" to a complete rule: if a degenerate session
# somehow carried the marker under more than one namespace, a single-valued
# rule would raise a conflict and crash the evaluation. Instead we work over
# sets, so the read stays total and the policy can only ever allow or deny —
# never error out of its fail-closed posture.

session_policies := object.get(object.get(input.context, "session", {}), "policies", {})

# Approval is on file if ANY namespace in session state carries our marker.
approval_on_file if {
	some _, ns in session_policies
	object.get(ns, "approval_recorded", false) == true
}

# The baseline was already normalized to {id, item_id, quantity} at observe
# time, so read those fields directly here (do NOT re-extract item.id — the
# stored shape is flat). This is a set union over every marker-carrying
# namespace; with the gateway's one-namespace-per-writer model that is a
# single namespace, and set semantics keep it order-independent and total.
approved_baseline_set := {entry |
	some _, ns in session_policies
	object.get(ns, "approval_recorded", false) == true
	some li in object.get(ns, "approved_line_items", [])
	entry := {
		"id": object.get(li, "id", ""),
		"item_id": object.get(li, "item_id", ""),
		"quantity": object.get(li, "quantity", 0),
	}
}

# The checkout id(s) the approval was recorded for, read with the same
# marker-carrying-namespace set semantics as the baseline.
approved_checkout_ids := {id |
	some _, ns in session_policies
	object.get(ns, "approval_recorded", false) == true
	id := object.get(ns, "approved_checkout_id", "")
}

# The completion targets exactly the checkout the approval was recorded for:
# one recorded id, equal to the submitted checkout's id. A degenerate session
# carrying two different recorded ids can never match and denies.
checkout_id_matches if {
	approved_checkout_ids == {submitted_checkout_id}
}

# Completion is for the approved checkout AND matches the approved baseline
# -> allow.
allow if {
	is_complete_checkout
	approval_on_file
	checkout_id_matches
	approved_baseline_set == normalized_submitted
}

# ---- reasons ----

reasons contains "Checkout completion does not match the cart the buyer approved. The submitted line items diverge from the approved baseline recorded at approval time." if {
	is_complete_checkout
	approval_on_file
	approved_baseline_set != normalized_submitted
}

# A completion that targets a different checkout than the approval was
# recorded for is denied even when the line items are identical: the approval
# is bound to the checkout id it was given on.
reasons contains msg if {
	is_complete_checkout
	approval_on_file
	not checkout_id_matches
	recorded := concat(", ", sort([id | some id in approved_checkout_ids]))
	msg := sprintf("Checkout completion is not bound to the recorded approval: the buyer's approval was recorded for checkout id %q, but this completion targets checkout id %q. An approval authorizes only the checkout it was given on; record a fresh approval for this checkout.", [recorded, submitted_checkout_id])
}

reasons contains "Checkout completion blocked: no live human-approved cart is on file for this session. Approvals are single-use and are consumed by a successful completion; approval must be recorded (update_checkout -> ready_for_complete) before each completion." if {
	is_complete_checkout
	not approval_on_file
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
