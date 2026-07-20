---
name: Cap Asana Batch Task Mutations
tags:
  - asana
  - cap-bulk-export
  - batch-mutation
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # asana / cap-batch-mutation

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `asana.ingress.cap_batch_mutation`

  ## What it does

  Caps the blast radius of Asana's official V2 batch write tools. At ingress it:

  1. **Denies** any `create_tasks` or `update_tasks` call whose task array holds
     more than a configurable ceiling (default **10**) of task objects, and
  2. **Separately denies** any `update_tasks` batch that sets `completed: true`
     on more than the ceiling number of elements (mass-completion guard).

  Everything else — reads, single-record community tools, and batch calls within
  the ceiling — passes through unchanged.

  Asana's official V2 batch tools (`create_tasks`, `update_tasks`) accept **up to
  50 task objects per call**. A single injected prompt can therefore create,
  mutate, or mass-complete an entire project's worth of tasks in one invocation.
  Clamping the array size blunts that blast radius while leaving normal small
  batches working. The rule counts **array elements** and **`completed: true`
  flags** rather than assuming one record per call.

  ## Why ingress and not egress

  Batch task creation/mutation is a write with permanent side effects — once the
  call reaches Asana the tasks exist, assignees and followers have been notified,
  and completions have fired downstream automations. Egress can only mask the
  response, not undo the writes. Ingress denial is the only point at which the
  mass-mutation is actually prevented.

  ## Compliance alignment

  - **SOC 2 CC6.7 / PI1.5** — supports restricting the movement/removal of
    information and the integrity of stored records by capping how many task
    records a single agent call can create, mutate, or mass-complete, blunting the
    blast radius of a runaway or injected batch write on the agent channel.
  - **GDPR Art. 5(1)(d)** (accuracy) — supports the anti-mass-corruption posture
    by capping how many task records a single agent call can create or mutate,
    limiting the damage of a runaway or injected batch write.
  - **GDPR Art. 5(1)(c)** (data minimisation) — supports proportionate processing
    by bounding bulk write volume on the agent channel.
  - **CCPA/CPRA 11 CCR §7002** (proportionality) — supports processing that is
    reasonably necessary and proportionate by rejecting oversized bulk mutations.

  (Per the coverage matrix, these GDPR/CCPA rows map to policy family **PF-08**;
  this is the write-side blast-radius variant of `cap-bulk-export`.)

  ## Tool name matching

  Matching is **suffix-based** and case-insensitive, for portability across
  gateway server-name prefixes:

  - `*create_tasks` — official V2 batch create
  - `*update_tasks` — official V2 batch update

  The tool name is read from **both** the PARC field (`input.resource.name`) and
  the legacy alias (`input.payload.name`) via `object.get` chains, and the two
  are matched independently — a request that omits the `resource` block, or
  carries a non-string value in one field, still cannot skip the match
  (fail-closed hardening: a missing/non-string name resolves to `""` rather than
  leaving the suffix check undefined). Leading/trailing whitespace is stripped
  with `trim_space` before matching, so padding the verb with a trailing space,
  tab, or newline (`...create_tasks\n`) does not evade the suffix check.

  The community singular tools `asana_create_task` / `asana_update_task` end in
  `create_task` / `update_task` (no trailing `s`), so they are **not** matched —
  they mutate one record per call and are out of scope. Comment tools, previews,
  and reads are also unaffected.

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `asana-mcp-create_tasks`), and that prefix is not standardized. Verify the exact
  name your gateway sends with the dump-input debug technique before relying on
  this in production.

  ## Argument shape

  Each batch tool takes an **array of up to 50 task objects**. Asana does **not**
  publish the V2 per-parameter JSON schema on its docs page — per-parameter
  schemas are only visible via a live `tools/list` against a connected server —
  so the exact argument **key** that holds the array is **UNVERIFIED**. The policy
  therefore checks a small ordered list of candidate keys (`batch_keys` =
  `["tasks", "data", "items"]`) and uses `object.get` defensively:

  - If a candidate key holds an array, its length (and, for `update_tasks`, its
    count of `completed: true` elements) is checked against the ceiling.
  - If **no** candidate key holds an array on a batch call, the size cannot be
    verified and the call is **denied (fail closed)** rather than allowed through
    under a renamed key. Confirm the real key for your deployment and put it first
    in `batch_keys`.
  - If a candidate key holds an array **and** another top-level argument holds an
    array under an **unrecognized** key, the call is also **denied**. This closes
    a decoy-smuggling bypass: without it, a one-element array under `tasks` would
    satisfy the recognized-array check while the real oversized batch rode along
    under an unrecognized key (`oversize` only inspects the recognized arrays).

  Elements that are not objects are skipped by the `completed: true` count.

  ## Examples

  ### Allowed — batch within the ceiling

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-mcp-create_tasks", "type": "tool" },
      "payload": {
        "name": "asana-mcp-create_tasks",
        "args": { "tasks": [ { "name": "a" }, { "name": "b" } ] }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — community singular tool (out of scope)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-mcp-asana_create_task", "type": "tool" },
      "payload": { "name": "asana-mcp-asana_create_task", "args": { "name": "one task" } }
    }
  }
  ```

  `allow = true` — singular tools mutate one record and are never matched.

  ### Denied — oversized batch

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "asana-mcp-create_tasks", "type": "tool" },
      "payload": {
        "name": "asana-mcp-create_tasks",
        "args": { "tasks": [ /* 11 task objects */ ] }
      }
    }
  }
  ```

  `allow = false`, reason: "This Asana batch call requests 11 task objects, above
  the 10-task ceiling. …"

  ### Denied — mass completion

  An `update_tasks` batch that marks more than 10 tasks `completed: true` is
  denied with both the oversize reason and the bulk-completion reason (a batch
  with >10 completed elements necessarily has >10 elements).

  ### Denied — unrecognized array key (fail closed)

  A batch call whose array sits under a key not in `batch_keys` is denied because
  its size cannot be verified.

  ### Denied — decoy array smuggling

  A batch call that puts a tiny array under a recognized key (e.g. `tasks: [one]`)
  while carrying the real oversized batch under an unrecognized key (e.g.
  `custom: [50 objects]`) is denied: the presence of any array under an
  unrecognized key, alongside a recognized one, fails closed.

  ## Composition

  This policy is single-purpose. Useful companions on Asana:

  - A **protected-project write fence** (deny writes to HR/Legal/M&A project GIDs).
  - A **destructive-op freeze** (deny `*delete_task` and community delete tools).
  - An **egress PII redaction** policy on `get_task` / `search_tasks` responses.

  ## Known limitations

  - **Unverified argument key.** The batch array key is not published by Asana;
    `batch_keys` is a best-effort candidate list (`tasks`, `data`, `items`).
    Confirm the real key via a live `tools/list` and put it first. Until then,
    legitimate batch calls whose array sits under a different key are denied by
    the fail-closed rule — a deliberate trade-off favouring safety over silent
    bypass.
  - **Single ceiling.** Because the same ceiling bounds both total elements and
    `completed: true` elements, any batch that trips the completion guard also
    trips the size guard; the completion reason adds specificity for the
    mass-completion case. Raise `ceiling` (or split the two limits) if your
    workspace needs a different balance.
  - **Tool-inventory drift.** Asana's V2 tool set evolves; if a new batch tool
    ships with a different suffix, add it to the matching rules.
  - **Decoy guard is a superset deny.** The decoy-smuggling guard denies any batch
    call that carries a top-level array under an unrecognized key while a recognized
    key also holds an array. If a legitimate batch tool genuinely takes a second
    top-level array argument (not the task array — e.g. a top-level `options`/
    `followers` list), this rule would deny it as a false positive. Add that key to
    `batch_keys` (or split it out) once you confirm the real schema via `tools/list`.
    Arrays nested *inside* task objects (e.g. per-task `followers`) are not affected —
    only top-level `args` keys are scanned.
  - **Value-typed completion flag.** The mass-completion count matches only a JSON
    boolean `completed: true`; a non-boolean truthy value (e.g. the string
    `"true"`) is not counted by the completion-specific guard. This is not a bypass
    of the size cap: completing more than `ceiling` tasks still requires more than
    `ceiling` array elements, which the oversize guard denies regardless of the
    `completed` value type.
  - **No identity-based exemptions.** All callers are subject to the same ceiling.
    Add an `allow if` branch keyed on `input.subject.claims` (e.g. a placeholder
    `"asana-admins"` group — replace with your IdP's group name at import time) if
    you need a break-glass path for large legitimate batches.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - asana
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package asana.ingress.cap_batch_mutation

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Maximum task objects permitted in a single official batch call, and the
# maximum number of tasks a single update_tasks call may mark completed.
# Tune this for your workspace; Asana's V2 batch tools accept up to 50.
ceiling := 10

# Candidate argument keys that may hold the batch task array. Asana does NOT
# publish the V2 per-parameter schema on its docs page (schemas are only visible
# via a live `tools/list`), so the exact key is UNVERIFIED. Checked in order;
# confirm the real key for your deployment and put it first. If none of these
# keys holds an array on a batch call, the size cannot be verified and the call
# is denied (fail closed) rather than allowed through under a renamed key.
batch_keys := ["tasks", "data", "items"]

# --- Tool matching (suffix-based, case-insensitive, for portability) ---
# The gateway prefixes tool names with the configured MCP server name, so we
# match on the suffix. Official V2 batch tools are `create_tasks` /
# `update_tasks` (plural). The community singular tools `asana_create_task` /
# `asana_update_task` end in `create_task` / `update_task` (no trailing "s") and
# are NOT matched — they mutate one record per call and are out of scope.
#
# The name is read via object.get chains from BOTH the PARC field
# (input.resource.name) and the legacy alias (input.payload.name), coerced to a
# lowercased, whitespace-trimmed string. A missing OR non-string value resolves
# to "" rather than leaving the rule undefined (an undefined name would make the
# endswith checks undefined and skip matching — a fail-OPEN bypass). trim_space
# strips leading/trailing whitespace so a padded verb (`...create_tasks\n`)
# cannot slip past the suffix check. The two fields are matched independently so
# a malformed value in one cannot suppress a real batch suffix in the other.
name_of(key) := trim_space(lower(v)) if {
	v := object.get(object.get(input, key, {}), "name", "")
	is_string(v)
}

name_of(key) := "" if {
	v := object.get(object.get(input, key, {}), "name", "")
	not is_string(v)
}

resource_name := name_of("resource")

payload_name := name_of("payload")

is_create_batch if { endswith(resource_name, "create_tasks") }

is_create_batch if { endswith(payload_name, "create_tasks") }

is_update_batch if { endswith(resource_name, "update_tasks") }

is_update_batch if { endswith(payload_name, "update_tasks") }

is_batch_tool if { is_create_batch }

is_batch_tool if { is_update_batch }

# --- Batch array discovery ---
# args is read through an object.get chain so a missing payload or args block
# yields {} (never leaves a reference undefined). Every candidate key whose
# value is actually an array is collected; object.get(..., null) means a missing
# key is skipped, not counted as an empty [].
args := object.get(object.get(input, "payload", {}), "args", {})

candidate_arrays contains arr if {
	is_batch_tool
	some key in batch_keys
	arr := object.get(args, key, null)
	is_array(arr)
}

array_recognized if {
	count(candidate_arrays) > 0
}

# Number of elements in a candidate array that set completed: true.
completed_in(arr) := count([t |
	some t in arr
	is_object(t)
	object.get(t, "completed", false) == true
])

# --- Violation conditions ---
# The batch array exceeds the element ceiling (create_tasks or update_tasks).
oversize if {
	some arr in candidate_arrays
	count(arr) > ceiling
}

# An update_tasks batch marks more than `ceiling` tasks completed in one call.
too_many_completed if {
	is_update_batch
	some arr in candidate_arrays
	completed_in(arr) > ceiling
}

# A batch call whose task array we cannot locate under any known key — size
# cannot be verified, so deny (fail closed) rather than let an unbounded batch
# through under a renamed argument.
unrecognized_batch if {
	is_batch_tool
	not array_recognized
}

# Decoy-smuggling guard. A caller could satisfy array_recognized with a tiny
# "decoy" array under a recognized key (e.g. tasks: [one object]) while carrying
# the real, oversized batch under an UNRECOGNIZED key (e.g. custom: [50 objects]).
# oversize only inspects candidate_arrays, so it would miss the smuggled array and
# the call would pass. When a recognized array IS present but there is ALSO a
# top-level array under a key we do not recognize, we cannot be sure we are sizing
# the real batch — so we fail closed. (Gated on array_recognized so the pure
# renamed-key case with no decoy is still reported by unrecognized_batch alone,
# not double-counted here.)
unknown_key_array if {
	is_batch_tool
	array_recognized
	some key, val in args
	is_array(val)
	not key in batch_keys
}

# --- Allow rules ---
# Anything that isn't an official batch tool passes untouched (this includes the
# community singular create/update tools and all read tools).
allow if {
	not is_batch_tool
}

# A batch call passes when we can see its array and it is within both ceilings,
# and there is no array smuggled under an unrecognized key (decoy guard).
allow if {
	is_batch_tool
	array_recognized
	not oversize
	not too_many_completed
	not unknown_key_array
}

# --- Deny reasons ---
reasons contains msg if {
	oversize
	n := max([count(arr) | some arr in candidate_arrays])
	msg := sprintf("This Asana batch call requests %d task objects, above the %d-task ceiling. Split it into smaller batches of %d or fewer tasks per call. If a larger batch is genuinely required, ask your workspace admin to raise the ceiling.", [n, ceiling, ceiling])
}

reasons contains msg if {
	too_many_completed
	m := max([completed_in(arr) | some arr in candidate_arrays])
	msg := sprintf("This update_tasks call marks %d tasks completed in a single call, above the %d-task bulk-completion ceiling. Complete tasks in smaller batches, or ask your workspace admin to raise the ceiling.", [m, ceiling])
}

reasons contains msg if {
	unrecognized_batch
	msg := sprintf("This Asana batch call did not expose a recognizable task array (checked keys: %s), so its size cannot be verified; it is denied by default. Confirm the batch argument key for your Asana MCP deployment and add it to batch_keys in this policy. Contact your workspace admin if this blocks a legitimate call.", [concat(", ", batch_keys)])
}

reasons contains msg if {
	unknown_key_array
	msg := sprintf("This Asana batch call carries a task array under an unrecognized argument key alongside a recognized one (recognized keys: %s), so its true batch size cannot be verified; it is denied to prevent a small decoy array masking a larger smuggled batch. Put the full task array under a single recognized key, or add the real key to batch_keys in this policy. Contact your workspace admin if this blocks a legitimate call.", [concat(", ", batch_keys)])
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
