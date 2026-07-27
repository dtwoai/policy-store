---
name: Salesforce Guard Opportunity Pipeline Fields
tags:
  - salesforce
  - opportunity
  - pipeline
  - revenue
  - human-approval
  - access-control
  - governance
  - ingress
publishedAt: 2026-07-12
description: |
  # salesforce / guard-opportunity-pipeline

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `salesforce.ingress.guard_opportunity_pipeline`

  ## What it does

  Keeps revenue-pipeline moves human-approved. It denies Salesforce update calls
  that modify the `Opportunity` pipeline fields — `StageName`, `Amount`, and
  `CloseDate` — unless the caller's IdP groups include `sales-managers`. The
  agent can still do useful Opportunity hygiene (notes, next steps,
  `Description`); it just cannot advance the stage, resize the deal, or slip the
  close date. A human consummates the move.

  Because one generic Salesforce tool fronts every object, this policy is
  **argument-shaped, not tool-shaped** — it matches the update tool by name, then
  keys on its arguments to find the object and the fields being written:

  - **Salesforce Hosted** (`updateSobjectRecord`, `updateRecord`,
    `updateSobjectRecordByRelationship`): reads the `sobject-name` argument and,
    when it is `Opportunity` (case-insensitive), scans the `body` field map.
  - **tsmztech** (`salesforce_dml_records`): applies only when `operation` is
    `update` or `upsert` (compared case-insensitively and with surrounding
    whitespace stripped); reads `objectName` and scans each entry of `records[]`.
  - **smn2gnt** (`update_record`, `bulk_update_records`): reads `object_type` and
    scans `data` (a single field map or an array of them).

  Updates to any other object, and updates to other Opportunity fields, pass
  through unchanged. A matched update whose object name is missing — or an
  Opportunity update whose body is missing or unstructured — **fails closed**
  (denied), because the gateway cannot then confirm the write leaves pipeline
  fields untouched.

  ## Compliance alignment

  - **SOX — SoD / COSO Principle 10 & Rule 13a-15(f)(2)(ii)** — separation of
    "initiate" from "approve" and transaction authorization: an autonomous agent
    can prepare an Opportunity but cannot itself authorize the stage/amount/close
    move that drives revenue recognition; a human in `sales-managers` does.
  - **SOX — PCAOB AI human-in-the-loop** — supports a draft-only posture for the
    agent on revenue-affecting records.
  - **SOC 2 CC6.3** — supports role-based access, least privilege, and
    segregation of duties by fencing pipeline mutation behind an IdP group.
  - **GDPR Art. 22 / CCPA-CPRA 11 CCR §7200 (ADMT)** — supports keeping a
    human in the loop for a commercially significant automated decision (moving a
    deal's stage/value) rather than letting the agent finalize it unattended.

  ## Why ingress

  Field updates are writes with permanent, externally visible side effects — an
  Opportunity stage or amount change feeds revenue reporting and can trigger
  Flow automations (customer emails, Slack posts, ERP syncs). The violation is
  fully determined by the request arguments, so denying at ingress stops the
  change before it reaches Salesforce.

  ## Tool name matching

  Tool names are matched on the (lowercased) **suffix**, because the DTwo gateway
  prefixes each tool with the configured MCP server name and that prefix is not
  standardized:

  - Hosted: `*-updatesobjectrecord`, `*-updaterecord`,
    `*-updatesobjectrecordbyrelationship`
  - tsmztech: `*salesforce_dml_records` (gated on `operation ∈ {update, upsert}`)
  - smn2gnt: `*-update_record`, `*-bulk_update_records`

  The camelCase hosted names and the community tool names above are the GA /
  published names from the app landscape note; confirm the exact strings against
  your deployed server's `tools/list` with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  - Hosted: object under `sobject-name`, fields under `body` (a field map).
  - tsmztech: object under `objectName`, operation under `operation`, records
    under `records` (an array of field maps).
  - smn2gnt: object under `object_type`, fields under `data` (a field map, or an
    array of them for `bulk_update_records`).

  Field-key matching is case-insensitive **and** whitespace-insensitive, so
  `stagename`, `StageName`, `STAGENAME`, and `"StageName "` are all caught. The
  operation gate (tsmztech) and the object name are matched case- **and**
  whitespace-insensitively (leading/trailing spaces, tabs, and newlines are
  stripped before comparison), so `"Opportunity "` or `"opportunity\n"` cannot be
  used to dodge the `Opportunity` match.

  The `body`/`sobject-name` key names above are verified for the hosted
  `sobject-all` server; the sibling `sobject-mutations` `updateRecord` arg shape
  is not separately verified in the landscape note. If a variant delivers the
  object under a different key, this policy sees no object name and **fails
  closed** (denies) rather than passing — confirm the shape against your server's
  schema.

  ## Examples

  ### Allowed (non-pipeline Opportunity field)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-updatesobjectrecord", "type": "tool" },
      "payload": {
        "name": "salesforce-updatesobjectrecord",
        "args": {
          "sobject-name": "Opportunity",
          "id": "006xx0000000001",
          "body": { "Description": "Left VM; following up Friday", "NextStep": "Send pricing" }
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (pipeline move, non-manager)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "salesforce-updatesobjectrecord", "type": "tool" },
      "payload": {
        "name": "salesforce-updatesobjectrecord",
        "args": {
          "sobject-name": "Opportunity",
          "id": "006xx0000000001",
          "body": { "StageName": "Closed Won", "Amount": 250000 }
        }
      }
    },
    "subject": { "claims": { "groups": ["sales-reps"] } }
  }
  ```

  `allow = false`, reason names the offending fields (`amount, stagename`).

  ### Allowed (same call, caller is a sales manager)

  The identical call with `"groups": ["sales-managers"]` in `subject.claims`
  is allowed — managers may move pipeline.

  ## Composition

  Companion Salesforce policies (see [`bundles/crm`](../../../bundles/crm/README.md)):

  - **`protect-contact-fields`** — the same object-scoped write guard for the
    `Contact` object (ownership, PII, consent). No overlap: this policy governs
    only `Opportunity` pipeline fields.
  - **`deny-escape-hatches`** — blocks `apex_execute` / `restful` /
    `tooling_execute` / `salesforce_execute_anonymous`, which could otherwise
    move pipeline via raw DML and bypass this argument-level check.
  - **`freeze-record-deletes`** — the delete-side companion.
  - **`role-gate-writes`** — the per-app least-privilege baseline.

  ## Known limitations

  - **Escape hatches bypass this check.** Raw-code / raw-API tools
    (`salesforce_execute_anonymous`, `apex_execute`, `tooling_execute`,
    `restful`) can write Opportunity fields without going through a matched
    update tool. Pair with `deny-escape-hatches`.
  - **Hosted `updateRelatedRecord` (sobject-mutations) not covered.** Like
    `protect-contact-fields`, this policy matches the three named hosted update
    tools; the relationship-scoped `updateRelatedRecord` variant does not carry a
    directly-identifiable object argument and is not inspected.
  - **Record *creation* is out of scope — this is an update-only guard.** The
    policy only inspects update/upsert calls; it does **not** cover the create
    tools, so an agent can create a brand-new Opportunity with `StageName`,
    `Amount`, and `CloseDate` already set (e.g. a Closed-Won deal born at
    creation). This affects every family: hosted `createSobjectRecord` /
    `createRecord`, smn2gnt `create_record` / `bulk_create_records`, and tsmztech
    `salesforce_dml_records` with `operation: "insert"`. Creation belongs to
    `role-gate-writes` / an object-allowlist policy, not to pipeline-move
    control — pair with those to fence Opportunity creation. Relatedly, a
    `salesforce_dml_records` call that omits `operation` entirely is treated as
    out of scope and passes; the tsmztech server itself requires the field, but
    do not treat this policy as the enforcement point for it.
  - **Structured arguments only.** If a server delivers the body/records as an
    opaque or stringified value rather than a JSON object/array, the field scan
    cannot read it. For that reason an Opportunity-targeted update whose body is
    present but unstructured **fails closed** (denied) rather than passing.
  - **Suffix tool-name match.** Any tool ending in one of the matched suffixes is
    inspected; if a non-Salesforce server exposed a colliding suffix it would be
    caught too. Narrow the match if that is a concern.
  - **Group names are placeholders — replace `sales-managers` with your IdP's
    group name at import time.** Missing/empty claims fail closed for the grant:
    a caller with no groups is never treated as a sales manager.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - salesforce
industries: []
bundles:
  - crm
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package salesforce.ingress.guard_opportunity_pipeline

# Deny-by-default: only the explicit allow rules below permit a request. Every
# tool that is not one of the recognised Salesforce update tools is allowed by
# the first allow rule, so this "default deny" governs only matched update calls.
default allow := false

# Opportunity fields whose modification moves the revenue pipeline (compared
# case-insensitively).
protected := {"stagename", "amount", "closedate"}

# Lowercased tool name; safe if resource/name is absent.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Tool arguments; safe if payload/args is absent.
args := object.get(object.get(input, "payload", {}), "args", {})

# --- Tool-family detection ---------------------------------------------------
# One generic tool fronts every object, so we match the tool name then key on
# its arguments (argument-shaped, not tool-shaped).

# Salesforce Hosted update tools (sobject-name + body).
is_hosted_update if endswith(tool_name, "-updatesobjectrecord")

is_hosted_update if endswith(tool_name, "-updatesobjectrecordbyrelationship")

is_hosted_update if endswith(tool_name, "-updaterecord")

# tsmztech generic DML tool — in scope only for record-modifying operations.
is_tsmztech_update if {
	endswith(tool_name, "salesforce_dml_records")
	# Operation compared case-insensitively AND whitespace-trimmed, so
	# "update", "UPDATE", and "update " (trailing space) all count as in-scope —
	# a server that trims the enum before calling Salesforce cannot dodge the gate.
	lower(trim_space(object.get(args, "operation", ""))) in {"update", "upsert"}
}

# smn2gnt update tools (object_type + data).
is_smn2gnt_update if endswith(tool_name, "-update_record")

is_smn2gnt_update if endswith(tool_name, "-bulk_update_records")

is_matched_update if is_hosted_update

is_matched_update if is_tsmztech_update

is_matched_update if is_smn2gnt_update

# --- Normalised object name + body across the three argument shapes ----------

# Raw object-name argument, read from whichever key the matched family uses.
obj_raw := object.get(args, "sobject-name", "") if is_hosted_update

obj_raw := object.get(args, "objectName", "") if is_tsmztech_update

obj_raw := object.get(args, "object_type", "") if is_smn2gnt_update

# Object name compared case- AND whitespace-insensitively, so " Opportunity ",
# "opportunity", and "Opportunity\n" are all recognised as Opportunity — a
# server that trims before calling Salesforce cannot slip past an exact match.
obj_name := lower(trim_space(obj_raw))

# Present only when the (trimmed) object name is a non-empty string; a missing
# key or a whitespace-only value is treated as "object unknown" -> fails closed.
obj_present if trim_space(obj_raw) != ""

body_val := object.get(args, "body", null) if is_hosted_update

body_val := object.get(args, "records", null) if is_tsmztech_update

body_val := object.get(args, "data", null) if is_smn2gnt_update

targets_opportunity if obj_name == "opportunity"

# --- Field extraction --------------------------------------------------------
# The body may be a single field map (hosted body, smn2gnt single) or an array
# of field maps (tsmztech records[], smn2gnt bulk data[]).

# Field keys are lowercased AND whitespace-trimmed before comparison, so
# "StageName", "STAGENAME", and "StageName " (trailing space) all resolve to the
# protected key — mirroring the object-name normalisation so neither dimension
# can be slipped past with surrounding whitespace.
body_keys(b) := {lower(trim_space(k)) | some k in object.keys(b)} if is_object(b)

body_keys(b) := {lower(trim_space(k)) |
	some e in b
	is_object(e)
	some k in object.keys(e)
} if is_array(b)

body_keys(b) := set() if {
	not is_object(b)
	not is_array(b)
}

body_is_structured if is_object(body_val)

body_is_structured if is_array(body_val)

# Protected pipeline fields present in the update body.
offending := {f | some f in body_keys(body_val); protected[f]}

# --- Identity gate (placeholder group — replace at import time) --------------

caller_is_sales_manager if {
	subject := object.get(input, "subject", {})
	claims := object.get(subject, "claims", {})
	groups := object.get(claims, "groups", [])
	"sales-managers" in groups
}

# --- Decision ----------------------------------------------------------------

# Pass through everything that is not a matched Salesforce update tool.
allow if not is_matched_update

# Sales managers may move pipeline; they are exempt from this policy.
allow if {
	is_matched_update
	caller_is_sales_manager
}

# Everyone else: allow a matched update only when it is neither a pipeline move
# nor a call we cannot verify as pipeline-safe.
allow if {
	is_matched_update
	not caller_is_sales_manager
	not blocked
}

blocked if pipeline_move

blocked if malformed

# A pipeline move: an Opportunity update that touches a protected field.
pipeline_move if {
	is_matched_update
	targets_opportunity
	count(offending) > 0
}

# Fail closed: a matched update whose object cannot be determined, or an
# Opportunity update whose body is missing or unstructured (so we cannot confirm
# it leaves pipeline fields untouched).
malformed if {
	is_matched_update
	not obj_present
}

malformed if {
	is_matched_update
	obj_present
	targets_opportunity
	not body_is_structured
}

# --- Reasons -----------------------------------------------------------------

reasons contains msg if {
	not caller_is_sales_manager
	pipeline_move
	msg := sprintf("Moving an Opportunity's pipeline is restricted: this update changes %s. Route revenue-pipeline changes through a sales manager (IdP group \"sales-managers\") or complete the stage move in the Salesforce UI approval flow.", [concat(", ", sort([f | some f in offending]))])
}

reasons contains msg if {
	not caller_is_sales_manager
	malformed
	msg := "This Salesforce update could not be verified as pipeline-safe (missing object name or unstructured field body) and was denied. Resend the update with an explicit object name and a structured field body, or route the change through a sales manager or the Salesforce UI."
}

reason := concat("; ", sort([r | some r in reasons])) if count(reasons) > 0
```
