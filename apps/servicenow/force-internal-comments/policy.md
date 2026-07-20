---
name: Force ServiceNow Comments to Internal Work Notes
tags:
  - servicenow
  - force-internal-comments
  - comments
  - work-notes
  - ingress
  - soc2
  - finra
publishedAt: 2026-07-12
description: |
  # servicenow / force-internal-comments

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow with transform (transform-only, no deny branch)
  **Package:** `servicenow.ingress.force_internal_comments`

  ## What it does

  Keeps agent-drafted ServiceNow comments off the customer/employee-visible journal by rewriting `add_comment` calls to internal work notes.

  ServiceNow's `add_comment` tool takes an `is_work_note` boolean that **defaults to `false`** — a `false` (or omitted) value posts the text as an *additional comment*, which is visible to the end customer/employee on the record and in portal/notification emails. `is_work_note: true` posts the same text to the internal **Work notes** journal, visible only to fulfillers.

  This policy:

  - **Transforms** `add_comment` to set `is_work_note: true` when the caller is **not** in the placeholder `service-desk` IdP group. The rewrite fires both when `is_work_note` is **absent** and when it is **explicitly `false`** (or any non-`true` value), so an agent cannot opt out of the internal-only posture simply by omitting the field or sending `false`.
  - **Passes through unmodified** for callers who *are* in the `service-desk` group — those users are expected to post customer-facing replies as part of their job.
  - **Passes through unmodified** any call that already sets `is_work_note: true` (nothing to fix) and every tool other than `add_comment`.

  The check runs at ingress, before the call reaches the ServiceNow MCP server, so a would-be customer-visible comment is rewritten to an internal note before it is ever written to the record. This is a *visibility* control only — it never denies the comment, it only changes where the text lands.

  ## Compliance alignment

  - **SOC 2 C1.1 (Confidentiality)** — supports maintaining and protecting
    confidential information on the MCP path: agent-drafted text is confined to
    the internal Work notes journal instead of the customer/employee-visible
    comment journal, so internal commentary is not published to a customer-facing
    channel unless it originates from a supervised service-desk role.
  - **FINRA Rule 3110(a)/(b)(4), 3110.09 / 4511** — supports alignment with the supervision-and-retention-of-communications controls (Partial, MCP path) by keeping agent-generated text out of the customer-facing communication channel unless it originates from a supervised service-desk role; agent commentary is routed to the internal work-notes journal rather than being published to the customer as an unsupervised retail communication.
  - **FINRA Rule 2210(b)(1)** — supports alignment with the principal-pre-approval-of-retail-communications control (Partial, MCP path): by default an agent's text is confined to internal work notes, so it does not reach a customer as a retail communication without a supervised (service-desk) human in the loop.

  Beyond the SOC 2 C1.1 confidentiality alignment above, this policy also supports the FINRA financial-services-communications controls (PF-26). FINRA has no bundle slug in this phase, so only the `soc2` bundle tag is claimed.

  ## Why ingress and not egress

  Posting a comment is a write with an immediate, externally visible side effect — once `add_comment` reaches ServiceNow with `is_work_note: false`, the text is on the customer-visible journal and may already have been syndicated to notification emails. Egress redaction would only mask the *response* the agent sees, not the journal entry itself. Rewriting `is_work_note` at ingress, before the call executes, is the only placement that actually keeps the text off the customer-visible journal.

  ## Tool name matching

  Matches by suffix, case-insensitively:

  - `*add_comment`

  `add_comment` is the verified tool name in both community servers that expose it — echelon-ai-labs/servicenow-mcp and michaelbuckner/servicenow-mcp (both `verb_noun` snake_case, no vendor prefix). The DTwo gateway prefixes tool names with the configured MCP server name (e.g. `servicenow-mcp-add_comment`), and that prefix is not standardized across deployments, so suffix matching keeps the policy portable. Verify the exact name your gateway sends with the dump-input debug technique before relying on this in production.

  The suffix is tested against **both** `input.resource.name` (the canonical PARC field) **and** the legacy `input.payload.name` alias, each read through an `object.get` chain. Both are populated on tool hooks and carry the same value, so the second branch is defense-in-depth: it ensures that a call which arrived with an absent or empty `resource.name` still matches via `payload.name` rather than passing the comment through customer-visible (a fail-open leak on this visibility control), and it means a missing `resource` object cannot error the rule.

  The official ServiceNow MCP Server (MCP Server Console) has **no fixed tool inventory** — tool names are instance-defined by the admin who publishes each skill/subflow/API. This policy does not attempt to match official-server CSM/case-comment tools; pair it with a per-tenant `default-deny-unknown-tools` policy on that server (see Composition).

  ## Argument shape

  Verified from `echelon-ai-labs/servicenow-mcp` (`src/servicenow_mcp/tools/incident_tools.py`):

  - `add_comment`: `incident_id` (req), `comment` (req), `is_work_note` (bool, **default `false` → customer-visible** journal entry).

  All fields are read via `object.get` chains. `is_work_note` is treated as "needs rewrite" whenever it is not exactly the boolean `true` — an absent field, an explicit `false`, or any non-boolean value (e.g. the string `"false"`) all resolve to a rewrite. The rewrite merges `{"is_work_note": true}` over the caller's `args`, so `comment`, `incident_id`, and any other supplied fields are preserved.

  ## Examples

  ### Transformed (non-service-desk caller, is_work_note omitted)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-add_comment", "type": "tool" },
      "subject": { "sub": "agent@example.com", "claims": { "groups": ["staff"] } },
      "payload": {
        "name": "servicenow-mcp-add_comment",
        "args": { "incident_id": "INC0010001", "comment": "Investigating now." }
      }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload` becomes `{ "incident_id": "INC0010001", "comment": "Investigating now.", "is_work_note": true }`.

  ### Transformed (non-service-desk caller trying to opt out with is_work_note: false)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-add_comment", "type": "tool" },
      "subject": { "sub": "agent@example.com", "claims": { "groups": ["staff"] } },
      "payload": {
        "name": "servicenow-mcp-add_comment",
        "args": { "incident_id": "INC0010001", "comment": "hi", "is_work_note": false }
      }
    }
  }
  ```

  `allow = true`; `is_work_note` is forced from `false` to `true`.

  ### Passed through (service-desk caller)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "servicenow-mcp-add_comment", "type": "tool" },
      "subject": { "sub": "desk@example.com", "claims": { "groups": ["service-desk"] } },
      "payload": {
        "name": "servicenow-mcp-add_comment",
        "args": { "incident_id": "INC0010001", "comment": "Your issue is resolved." }
      }
    }
  }
  ```

  `allow = true`, no transform — a service-desk member may post a customer-visible reply.

  ## Composition

  This policy is single-purpose — it controls comment **visibility** only, not whether the caller may comment at all. Useful companions:

  - **`role-gate-writes`** (PF-12) — decides whether the caller may call `add_comment` (or any write) in the first place. This policy composes cleanly on top: role-gate-writes admits the write, force-internal-comments confines its visibility.
  - **`default-deny-unknown-tools`** (PF-28) — mandatory for the official ServiceNow MCP Server, whose CSM/case-comment tools are instance-named and not matched here.
  - A secrets/DLP ingress policy on the `comment` body if you also want to block credentials or PII from being written to the journal at all.

  ## Known limitations

  - **Group name is a placeholder — replace at import time.** The exemption group ships as `service-desk`; replace it with your IdP's group name. Group names are placeholders — replace `service-desk` with your IdP's group name at import time. The `groups` claim is assumed to be an array of strings; if your IdP emits a single string or a namespaced claim, adapt `is_service_desk`. A caller with no `groups` claim (or no `subject` at all) is treated as **not** service-desk and is rewritten — the exemption fails closed toward the internal-only posture.
  - **`add_work_notes` is left untouched — by design.** michaelbuckner/servicenow-mcp exposes a separate `add_work_notes` tool that is already internal-only; it needs no rewrite and this policy does not match it.
  - **`update_incident` and official-server CSM case tools are not covered.** `update_incident` (echelon) can set `work_notes` and `close_notes` — those are internal journal fields, so no rewrite is needed there — **but** `update_incident` and the official ServiceNow MCP Server's CSM/case tools may expose *other* customer-visible fields (e.g. a customer-facing `comments`/`additional comments` field, case correspondence, or a public reply action) that this policy does **not** inspect or rewrite. If your deployment uses those surfaces, add companion policies for them; do not assume this single policy makes every ServiceNow write internal-only.
  - **Generic / natural-language write tools are an uncovered escape hatch — pair with a default-deny policy.** The michaelbuckner server ships `natural_language_update` (a write driven by free text, with no structured, inspectable `is_work_note` field diff) plus generic `perform_query`/`update_script` tools. An agent could post customer-visible comment text through `natural_language_update` (e.g. "add a comment to INC0010001 that the customer can see …") without ever invoking `add_comment`, and this policy would **not** intercept it — there is no boolean field to force. This is a residual bypass by design: a single-purpose visibility transform cannot safely rewrite an unstructured NL write. Do **not** deploy this policy on a server that exposes free-text/generic-write tools without also attaching `default-deny-unknown-tools` (PF-28) and/or a policy that denies `natural_language_update`/`perform_query` outright (see Composition).
  - **Tool-name ordering divergence (`noun_verb` servers) is not matched.** The suffix match `add_comment` covers the two `verb_noun` community servers (echelon, buckner) and their gateway-prefixed forms. Servers that order names `noun_verb` (e.g. LokiMCPUniverse's `incident_create` style) would expose a comment tool as something like `comment_add`, which `endswith(…, "add_comment")` does **not** catch. The landscape note does not verify that such a server actually ships a comment tool or an `is_work_note`-equivalent field, so — per the no-invented-tool-names rule — this policy does not add a speculative suffix. If your gateway front-ends a `noun_verb` server, confirm the real comment tool name with the dump-input debug technique and add its suffix to `is_add_comment_call` before relying on this policy there.
  - **Non-boolean `is_work_note` values.** A non-`true` value of any type triggers the rewrite (forced to `true`), which is the safe direction. A value that is already the boolean `true` is passed through untouched. A caller who supplies the flag under a *differently-cased* key (e.g. `Is_Work_Note: false`) does **not** suppress the rewrite: JSON keys are case-sensitive, so the lowercase `is_work_note` is absent, the rewrite fires, and `object.union` adds the canonical lowercase `is_work_note: true` (which the Python community servers read) alongside the caller's ignored mixed-case key.
  - **Malformed (non-object) `args` are passed through unmodified.** The rewrite only fires when `args` is a JSON object. If a caller sends `args` as a string or array, `object.get(args, "is_work_note", …)` is undefined, so `needs_internal_rewrite` never holds and no transform is applied — the malformed call passes through untouched. This is a residual fail-open, but a non-object `args` cannot carry a valid `comment`/`incident_id` through the echelon or michaelbuckner servers (both expect a dict), so such a call fails at the server rather than posting a customer-visible comment. If you want malformed writes rejected outright rather than passed through, pair this with `role-gate-writes` or a schema-validation ingress policy.
  - **Visibility only, never a deny.** This policy never blocks a comment; it only relocates the text to the internal journal. Pair it with `role-gate-writes` if some callers should not be able to comment at all.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - servicenow
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package servicenow.ingress.force_internal_comments

# Transform-only policy: allow everything, and rewrite add_comment calls so
# agent-drafted text lands on the internal work-notes journal instead of the
# customer/employee-visible comment journal. Never denies.
default allow := true

# ---------------------------------------------------------------------------
# Configuration placeholder — replace at import time
# ---------------------------------------------------------------------------

# IdP group whose members may post customer-visible comments (their calls pass
# through unmodified). PLACEHOLDER: replace with your IdP's group name.
service_desk_group := "service-desk"

# ---------------------------------------------------------------------------
# Shared accessors — every possibly-missing field is read via object.get
# ---------------------------------------------------------------------------

args := object.get(object.get(input, "payload", {}), "args", {})

# add_comment tool. echelon-ai-labs and michaelbuckner both name it
# `add_comment` (verb_noun snake_case, no vendor prefix); the gateway prefixes
# the server name, so match by suffix for portability. Case-insensitive so a
# mixed-case tool name can't slip past. We match on resource.name OR the legacy
# payload.name alias (both are populated on tool hooks and carry the same value):
# a call that arrived with an absent/empty resource.name would otherwise miss the
# match and pass the comment through customer-visible — a fail-open leak. Reading
# both via object.get also means a missing `resource` object can't error the rule.
is_add_comment_call if {
    input.action == "tool_pre_invoke"
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), "add_comment")
}

is_add_comment_call if {
    input.action == "tool_pre_invoke"
    endswith(lower(object.get(object.get(input, "payload", {}), "name", "")), "add_comment")
}

# True when the caller is in the service-desk exemption group. Missing claims /
# missing subject fail closed (no group -> not exempt -> comment is rewritten).
is_service_desk if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    some g in object.get(claims, "groups", [])
    g == service_desk_group
}

# The comment is customer-visible unless is_work_note is exactly boolean true.
# Absent field (default false), explicit false, or any non-true value all mean
# the text would land on the visible journal and must be rewritten. An agent
# therefore cannot opt out by omitting is_work_note or sending false.
needs_internal_rewrite if {
    object.get(args, "is_work_note", false) != true
}

# ---------------------------------------------------------------------------
# Transform: force is_work_note := true for non-service-desk callers
# ---------------------------------------------------------------------------

transform := {"transformed_payload": object.union(args, {"is_work_note": true})} if {
    is_add_comment_call
    not is_service_desk
    needs_internal_rewrite
}
```
