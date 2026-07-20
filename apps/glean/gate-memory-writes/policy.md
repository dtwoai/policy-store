---
name: "Glean: Gate Memory Writes (Read-Only Default)"
tags:
  - glean
  - gate-memory-writes
  - role-gate-writes
  - memory
  - access-control
  - least-privilege
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # glean / gate-memory-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny memory writes unless the caller is in the pilot group; allow memory reads and every other tool
  **Package:** `glean.ingress.gate_memory_writes`

  ## What it does

  Gates mutating calls to Glean's long-term **memory** surface — the built-in tool exposed as
  `memory` (and as `read_memory` in Glean's own client guide). A call to that tool is denied when
  its `action` argument is anything other than `"read"` — i.e. `add`, `update`, or `delete`, or a
  missing/empty action — **unless** the caller's IdP `groups` claim contains the placeholder pilot
  group `glean-memory-pilot`. Memory reads (`action:"read"`) always pass, and every other Glean
  tool (`search`, `chat`, `read_document`, `employee_search`, `memory_schema`, the
  `knowledge_graph_*` introspection tools, etc.) passes untouched.

  Memory is Glean's only built-in write and a cross-session persistence channel. Since the March
  2026 release, any connected MCP host can add, update, or delete a user's memories. A
  prompt-injected agent could plant durable instructions (`category:"ConstraintsAndGuardrails"`)
  that survive across sessions, or erase a user's context with `action:"delete"`. Gating writes at
  ingress blocks memory-poisoning and unauthorized deletion from connected hosts while leaving
  retrieval-only use unaffected.

  The check runs at ingress, before the call reaches the Glean MCP server, so a denied memory
  write never executes and has no persistent side effect.

  ## Compliance alignment

  This policy is the Glean instance of policy family **PF-12 (role-gate-writes)** on the memory
  surface. It supports alignment with the following controls on the MCP path:

  - **SOC 2 CC6.1** — supports logical access security over protected assets: Glean memory cannot
    be mutated over the agent channel without an explicit role grant. **CC6.3** — supports
    role-based access and least privilege; write capability is bound to a live IdP group, so
    removing the group in the IdP removes memory-write access on the next call.
  - **HIPAA §164.308(a)(4)** — supports information access management: memory-write authorization
    is role-scoped. **§164.312(a)(1)/(a)(2)(i)** — supports technical access control and unique
    user identification, using the per-call identity from the caller's JWT.
  - **GDPR Art. 25** — supports data protection by design/default on the agent channel: the
    default posture is read-only. **Art. 29 / 32(4)** — supports processing only on the
    controller's instructions; an unauthorized principal cannot alter or delete stored personal
    context through the agent.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `glean-default-memory`), and that prefix is not standardized — so matching is case-insensitive
  and by **suffix**:

  - Admin docs name the tool `memory`; Glean's own client guide surfaces it as `read_memory`.
    Both names end in `memory`, so a single `endswith(..., "memory")` match covers both suffixes.
  - The read-only introspection tools `memory_schema`, `knowledge_graph_query`, and
    `knowledge_graph_schema` do **not** end in `memory`, so they are never matched by this policy.

  Verify the exact name your gateway sends with the dump-input debug technique before relying on
  this in production. Glean's remote server uses generic snake_case names, so if you attach this
  policy to a pipeline that also fronts a *different* MCP server that happens to expose a tool
  whose name ends in `memory`, that tool would also be gated — attach it to a Glean-scoped
  pipeline, or narrow the match.

  ## Argument shape

  The decision reads the action from `object.get(input.payload.args, "action", "")` and the
  caller's identity from `input.subject.claims.groups`. The comparison against `"read"` is exact
  and case-sensitive to match Glean's `action` enum (`read` | `add` | `update` | `delete`): any
  other value — including a wrong-case `"READ"`, an unknown verb, or a missing/empty action — is
  treated as a **write** and denied for non-pilot callers (fail closed). No other argument
  (`category`, `query`, `read_filters`, ...) is inspected, so the gate cannot be bypassed by
  unusual argument nesting or encodings.

  ## Identity

  Group membership is read fail-closed from
  `object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])` — i.e.
  the `groups` claim inside `object.get(input.subject, "claims", {})`. A missing subject, missing
  claims, a missing `groups` claim, or a `groups` claim that is not an array all mean "not a
  pilot", and the memory write is denied. Memory reads and non-memory tools are unaffected by
  identity.

  ## Examples

  ### Allowed — memory read, no pilot group required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-default-memory", "type": "tool" },
      "subject": { "sub": "auth0|alice", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "glean-default-memory",
        "args": { "action": "read", "query": "my active projects" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — memory write by a pilot-group member

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-default-memory", "type": "tool" },
      "subject": { "sub": "auth0|alice", "claims": { "groups": ["glean-memory-pilot"] } },
      "payload": {
        "name": "glean-default-memory",
        "args": { "action": "add", "category": "ActiveProjects", "content": "Q3 launch" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — memory write by a non-pilot caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "glean-default-read_memory", "type": "tool" },
      "subject": { "sub": "auth0|bob", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "glean-default-read_memory",
        "args": { "action": "delete", "memory_id": "m-123" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Glean memory writes (add, update, delete) are restricted to members of the 'glean-memory-pilot' group ..."`.

  ## Composition

  This policy gates *who* may write to Glean memory; it does not inspect *what* is written. Useful
  companions:

  - **`apps/glean/default-deny-unknown-tools`** — Glean's tool inventory is admin-mutable
    (agents-as-tools, gateway-proxied writes). Pair this with a default-deny allowlist so new
    write surfaces do not appear unreviewed.
  - **`apps/glean/fence-datasource-scope`** and an egress PII-redaction policy on `search` /
    `read_document` / `chat` responses, since this policy leaves Glean's (extensive) read path
    open.
  - A `meeting_lookup` transcript guard for the other high-sensitivity Glean surface.

  ## Known limitations

  - **Pilot group name is a placeholder** — replace `glean-memory-pilot` with your tenant's IdP
    group name at import time. The policy expects `groups` to be an array claim in the caller's
    JWT; if your IdP emits groups under a different or namespaced claim (e.g.
    `https://acme.com/groups`), update `caller_groups` in `policy.md`.
  - **`args` vs `arguments` key is unverified.** This policy reads the action from
    `input.payload.args.action`, per the DTwo gateway's documented payload shape. Glean's own
    tool reference describes the parameter under `arguments`. If your gateway forwards Glean's
    arguments under a different key, `action` reads as empty and *every* memory call fails closed
    (denied for non-pilot callers) — verify the live payload shape with the dump-input technique
    before production and adjust the `object.get` path if needed.
  - **Reads are open to everyone**, including reads of memories that hold sensitive context. This
    policy protects integrity/persistence (writes), not confidentiality of the read path — pair
    with an egress redaction policy if memory contents are sensitive in your tenant.
  - **Suffix over-match on shared pipelines.** Because matching is by the `memory` suffix, a
    non-Glean tool on the same pipeline whose name ends in `memory` would also be gated. Attach to
    a Glean-scoped pipeline or narrow the match.
  - **Suffix match ignores hook type.** The gate keys on the tool-name suffix alone, so a *prompt*
    or *resource* whose name ends in `memory` (e.g. a `prompt_pre_fetch` for `session_memory`) is
    gated as if it were the memory write tool and denied for non-pilot callers. This is a benign,
    fail-*closed* over-block — a prompt/resource fetch cannot mutate memory, so nothing leaks; the
    only cost is a confusing memory-write denial on an unrelated hook. It is deliberate: keying on
    the suffix alone means a missing or unexpected `resource.type`/`action` field can never cause a
    real memory write to slip through un-gated (fail open). If the confusing message matters in
    your tenant, add a `resource.type == "tool"` guard — but only after confirming your gateway
    reliably populates `resource.type`, since gating on it makes a missing value fail open.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the
  > MCP path only**. No policy or bundle makes an organization compliant with any framework;
  > web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate
  > against your own compliance program before relying on it.
direction: ingress
apps:
  - glean
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package glean.ingress.gate_memory_writes

# Deny-by-default: memory reads and every non-memory tool are explicitly allowed
# below; every memory *write* requires membership in the pilot group.
default allow := false

# Placeholder IdP group permitted to perform Glean memory writes.
# Replace "glean-memory-pilot" with your tenant's IdP group name at import time.
pilot_group := "glean-memory-pilot"

# Lowercased tool name. The gateway prefixes tool names with the configured MCP
# server name (e.g. `glean-default-memory`), so matching is case-insensitive and
# by suffix to stay portable across server-name prefixes.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Glean's long-term memory surface. Admin docs list it as `memory`; Glean's own
# client guide surfaces it as `read_memory`. Both names end in `memory`, so a
# single suffix match covers both. The read-only introspection tools
# (`memory_schema`, `knowledge_graph_*`) do not end in `memory` and are unaffected.
is_memory_tool if {
    endswith(tool_name, "memory")
}

# The memory tool's `action` argument: "read" | "add" | "update" | "delete".
# Read via object.get so a missing args object or missing action key yields "".
memory_action := object.get(object.get(object.get(input, "payload", {}), "args", {}), "action", "")

# Only the exact value "read" is a read. Case-sensitive to match Glean's enum:
# any other value (add/update/delete/unknown/empty) is treated as a write, so a
# missing or empty action fails closed.
is_read if {
    memory_action == "read"
}

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim that
# is not an array all yield "not a pilot" — memory writes then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# The is_array guard is load-bearing: `some g in caller_groups` iterates the
# *values* of an object, so a groups claim shaped as {"role":"glean-memory-pilot"}
# would otherwise match and fail OPEN. Requiring an array keeps every non-array
# shape (object, string, number) fail-closed.
caller_is_pilot if {
    is_array(caller_groups)
    some g in caller_groups
    g == pilot_group
}

# --- Decision ---

# Any tool that is not the memory surface passes untouched.
allow if {
    not is_memory_tool
}

# Memory reads always pass — retrieval-only use is unaffected.
allow if {
    is_memory_tool
    is_read
}

# Memory writes pass only for members of the pilot group.
allow if {
    is_memory_tool
    not is_read
    caller_is_pilot
}

reasons contains msg if {
    is_memory_tool
    not is_read
    not caller_is_pilot
    msg := sprintf("Glean memory writes (add, update, delete) are restricted to members of the '%s' group — this account can read Glean memory but not modify it through the gateway. Ask your identity admin to add you to '%s', or use action \"read\" for retrieval only. If this was meant to be a read, confirm the call sends action \"read\"; contact your InfoSec team if the policy needs adjusting.", [pilot_group, pilot_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
