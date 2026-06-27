---
name: Cumulative Spend Ceiling Across a Session
tags:
  - session-state
  - spend-control
  - checkout
  - budget
  - ingress
  - agentic-commerce
publishedAt: 2026-06-27
description: |
  Enforce a running spend ceiling across every `complete_checkout` an agent
  performs within a session. On each `complete_checkout`, the policy adds this
  checkout's grand total to the running total committed by prior checkouts in
  the same session; if the projected total would exceed the org budget, it
  DENIES; otherwise it allows and emits a session write that advances the
  running total. This is buyer-side egress governance — you govern the agents
  *you* run. It is impossible without cross-call memory: UCP is stateless on
  the wire and carries no budget or running-total field, so both the ceiling
  (`input.context.mandate.session_budget`) and the accumulated state
  (`input.context.session`) are DTwo-supplied policy inputs, not UCP fields.
direction: ingress
apps:
  - shopify
industries:
  - retail
bundles:
  - agentic-commerce
schemaVersion: "1.0.0"
minimumGatewayVersion: "session-state"
---

```rego
package shopify.ingress.cumulative_spend_ceiling

import rego.v1

# Self-reference for this policy's own write namespace under
# input.context.session.policies. A policy CANNOT hardcode its real
# writer_id — the gateway derives writer_id server-side from the OPA URL
# and the SOTW config, then auto-namespaces this policy's writes under
# policies.<writer_id>. The literal below is the authoring-time alias the
# deploy pipeline aligns with the resolved writer_id; correctness depends
# on policy uids being immutable and non-reusable. See README
# "Why this needs session state" and "Honest scope".
writer_id := "shopify.ingress.cumulative_spend_ceiling"

# --- tool gate ---------------------------------------------------------------
# Tool name comes from input.resource.name (lowercased). The gateway prepends
# a non-standard server prefix, so suffix-match the OpenRPC op name.
tool_name := lower(object.get(input.resource, "name", ""))

is_complete_checkout if endswith(tool_name, "complete_checkout")

# --- this checkout's grand total --------------------------------------------
# Tool args live at input.payload.args (canonical). The checkout's grand total
# is the totals[] entry where type == "total"; amount is a SIGNED INTEGER in
# the currency minor unit (cents). There is no totals.grand_total field.
checkout := object.get(input.payload.args, "checkout", {})

totals := object.get(checkout, "totals", [])

grand_total := t.amount if {
	some t in totals
	t.type == "total"
}

# --- prior running total from committed session pre-state -------------------
# Across requests in the same session, the gateway injects this policy's prior
# committed writes under policies.<writer_id>. Within THIS evaluation that is
# pre-state only (no read-your-own-writes). Default 0 for the first
# checkout of a session.
prior_total := object.get(
	object.get(
		object.get(input.context.session, "policies", {}),
		writer_id,
		{},
	),
	"running_total",
	0,
)

# --- org budget (DTwo-supplied policy input, NOT a UCP field) ---------------
# The buyer's budget does not exist as a UCP field — it lives only inside the
# opaque AP2 mandate. The gateway surfaces the ceiling as policy input at
# input.context.mandate.session_budget (minor units), same currency as totals.
session_budget := object.get(
	object.get(input.context, "mandate", {}),
	"session_budget",
	null,
)

projected_total := prior_total + grand_total

# --- decision ----------------------------------------------------------------
default allow := true

# Deny only an over-ceiling complete_checkout. When no budget is supplied the
# policy does not gate (fail-open on missing mandate); see README "Honest scope".
allow := false if {
	is_complete_checkout
	session_budget != null
	projected_total > session_budget
}

reasons contains reason if {
	is_complete_checkout
	session_budget != null
	projected_total > session_budget
	reason := sprintf(
		"session spend ceiling exceeded: prior=%d + this=%d = %d > budget=%d (minor units)",
		[prior_total, grand_total, projected_total, session_budget],
	)
}

# Surface a single human-readable denial message in the conventional `reason`
# field the gateway renders (aggregated from `reasons`, undefined on allow).
reason := joined if {
	count(reasons) > 0
	joined := concat("; ", sort([r | some r in reasons]))
}

# --- session write: advance the running total on an allowed checkout --------
# Partial-object idiom so the write is independent of the allow path. Emitted
# only for an allowed complete_checkout with a resolvable grand total. The
# gateway auto-namespaces it under policies.<writer_id>.running_total and
# validates it against the writable-key schema (running_total: integer).
session_writes["running_total"] := projected_total if {
	is_complete_checkout
	allow
	grand_total != null
}
```
