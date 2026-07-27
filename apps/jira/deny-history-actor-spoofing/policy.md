---
name: "JIRA: Block Change-History Actor Spoofing"
tags:
  - jira
  - atlassian
  - freeze-destructive-ops
  - audit-integrity
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # jira / deny-history-actor-spoofing

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `jira.ingress.deny_history_actor_spoofing`

  ## What it does

  Blocks any official Jira write call — `transitionJiraIssue`, `editJiraIssue`,
  or `createJiraIssue` — that carries a `historyMetadata` block, before it reaches
  the Atlassian MCP server. Per the verified official-connector schema,
  `transitionJiraIssue` accepts a free-text `historyMetadata` object (`actor`,
  `cause`, `generator`, each with `displayName` / `avatarUrl`) that is stamped
  directly onto Jira's issue change history; the same `historyMetadata` field is
  part of Jira's REST edit-issue and create-issue request bodies, so the
  edit/create tools are an equivalent route to the same change log (see Known
  limitations for the verification status). An agent — or a prompt injection
  driving it — can use that field to **forge who changed an issue**, decorating
  the change log with a fabricated actor and corrupting the audit trail of the
  automated actor.

  Every write **without** `historyMetadata` passes through unchanged, so normal
  workflow automation and legitimate transitions/edits/creates are unaffected.
  The decision is made on the tool suffix plus the presence of the
  `historyMetadata` key anywhere in the arguments object (top level or nested
  inside the connector's open objects — see Argument shape); a malformed
  arguments object fails closed (deny).

  This is an **audit-integrity specialization** of the record-protection family
  (PF-06, `freeze-destructive-ops`), distinct from a plain
  `freeze-destructive-ops` policy: it protects the integrity of the *record of
  what the agent did* (the change history) rather than the record content
  itself.

  ## Compliance alignment

  - **SOC 2 PI1.5** — supports the integrity of stored records by denying
    agent-forged change-history entries, keeping the record of who transitioned
    an issue trustworthy.
  - **HIPAA §164.312(c)** — supports the integrity (anti-alteration) safeguard
    for the change-history record; **§164.312(b)** — supports audit controls by
    preventing the agent from fabricating audit-relevant actor metadata.
  - **GDPR Art. 5(1)(d)** — supports accuracy: the change history must not record
    a fabricated actor; **Art. 5(2) / Art. 24** — supports accountability by
    keeping the actor record demonstrably genuine.

  ## Why ingress and not egress

  A transition/edit/create is a write with a permanent side effect — once the
  call reaches Jira the change-history entry (including any spoofed
  `historyMetadata`) is written and immutable through the MCP path. Egress could
  only mask the response, not un-write the forged history. Ingress denial is the
  only placement that actually prevents the audit-trail corruption.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `atlassian-transitionjiraissue`, `atlassian-jira-mcp-transitionjiraissue`),
  and that prefix is not standardized. The policy matches the **suffixes**
  `transitionjiraissue`, `editjiraissue`, and `createjiraissue`
  case-insensitively on `lower(input.resource.name)`, so it stays portable across
  gateway server names. Verify the exact tool names your gateway emits with the
  dump-input debug technique before relying on this in production.

  `historyMetadata` is a verified field on the official Rovo/connector
  `transitionJiraIssue` tool and is part of Jira's REST edit-issue and
  create-issue request bodies, so the rule covers all three official write tools.
  The community `sooperset/mcp-atlassian` write tools (`jira_transition_issue`,
  `jira_update_issue`, `jira_create_issue`) do **not** end with any of those
  suffixes and their `historyMetadata` support is unverified — see Known
  limitations.

  ## Argument shape

  The policy reads `input.payload.args` with `object.get` (defaulting to `{}`)
  and looks for the `historyMetadata` key **at any depth** of the arguments
  object:

  - Any **non-null** `historyMetadata` value (object, empty object, or even a
    bare string) is treated as present and denies the call — presence signals
    intent to decorate the change history.
  - The scan is deep, not just top-level: these write tools carry **open
    objects** (`transitionJiraIssue`'s `fields`/`update`, `editJiraIssue`'s
    `fields`, `createJiraIssue`'s `additional_fields`) whose merge into the
    REST request body is connector-defined, so a `historyMetadata` key nested
    inside any of them is denied too. Only object **keys** named exactly
    `historyMetadata` match — a string *value* containing the word (e.g. in a
    description) never trips the rule.
  - `historyMetadata: null` is treated as absent (it stamps nothing) and the
    write is allowed, at any depth.
  - If `args` is **not an object** (malformed payload), the write-allow branch
    cannot fire, so the call falls through to the default deny (fail-closed).

  ## Examples

  ### Allowed (transition with no historyMetadata)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-transitionjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-transitionjiraissue",
        "args": { "issueIdOrKey": "DEV-7", "transition": { "id": "31" } }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied (transition with a spoofed actor)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-transitionjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-transitionjiraissue",
        "args": {
          "issueIdOrKey": "DEV-7",
          "transition": { "id": "31" },
          "historyMetadata": {
            "actor": { "displayName": "Jane Approver", "avatarUrl": "https://x/y.png" },
            "cause": { "displayName": "quarterly review" }
          }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Jira write call includes a historyMetadata block ..."`.

  ### Denied (edit-issue route to the same change log)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-editjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-editjiraissue",
        "args": {
          "issueIdOrKey": "DEV-7",
          "fields": { "summary": "updated" },
          "historyMetadata": { "actor": { "displayName": "Jane Approver" } }
        }
      }
    }
  }
  ```

  `allow = false` — the edit-issue tool is an equivalent route to the change log,
  so it is blocked too.

  ### Denied (nested smuggling via an open object)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createjiraissue", "type": "tool" },
      "payload": {
        "name": "atlassian-createjiraissue",
        "args": {
          "projectKey": "DEV",
          "summary": "New issue",
          "additional_fields": {
            "historyMetadata": { "actor": { "displayName": "Jane Approver" } }
          }
        }
      }
    }
  }
  ```

  `allow = false` — the deep scan catches `historyMetadata` nested inside the
  connector's open `additional_fields` object.

  ## Composition

  This policy is single-purpose — it protects change-history integrity on
  transitions. Useful companions in the same
  [`atlassian`](../../../bundles/atlassian/README.md) bundle:

  - [`deny-write-sensitive-projects`](../deny-write-sensitive-projects/policy.md) —
    fences writes (including transitions) to designated sensitive projects.
  - [`deny-view-search-sensitive-projects`](../deny-view-search-sensitive-projects/policy.md) —
    read/search restriction for the same projects.
  - [`redact-sensitive-info`](../redact-sensitive-info/policy.md) — egress
    redaction of PII/secrets in returned issue content.

  ## Known limitations

  - **Official write tools only; edit/create honoring is unverified.** The rule
    covers the three official write tools that carry a `historyMetadata` body
    field: `transitionJiraIssue` (verified in the landscape note), `editJiraIssue`,
    and `createJiraIssue` (part of Jira's REST edit-issue and create-issue request
    bodies, but **not independently verified** on the connector — blocked
    defensively because the presence of a spoofing-shaped field on a write is the
    thing being prevented, and no legitimate agent sets it). If your connector
    turns out **not** to honor `historyMetadata` on edit/create, the only cost is
    that a call carrying that inert field is denied rather than silently stripped.
    Was previously discovered as a red-team bypass: an agent could spoof the
    change-history actor via `editJiraIssue`/`createJiraIssue` while sidestepping a
    transition-only rule.
  - **Nested smuggling is covered (red-team fix).** A red-team pass found that a
    top-level-only key check could be sidestepped by nesting `historyMetadata`
    inside the connector's open objects (`transitionJiraIssue`'s
    `fields`/`update`, `editJiraIssue`'s `fields`, `createJiraIssue`'s
    `additional_fields`), whose merge into the REST body is connector-defined
    and unverified. The rule now scans the whole arguments object for the key at
    any depth, so that route is closed; the residual cost is only that an inert
    nested key is denied rather than ignored.
  - **Community server tools are out of scope.** The community
    `sooperset/mcp-atlassian` write tools (`jira_transition_issue`,
    `jira_update_issue`, `jira_create_issue`, and the batch route
    `jira_batch_create_issues`) do not match any official suffix, and
    whether they accept `historyMetadata` is **unverified**; if you run the
    community server and confirm it honors the field, add its suffixes to
    `history_write_suffixes`.
  - **Exact-key reliance.** Detection looks for the `historyMetadata` key by
    name. Jira's REST API honors only that exact key, so an alternate-cased or
    misspelled key (`historymetadata`, `history_metadata`) is inert — the
    upstream API ignores it and no actor is stamped — and is therefore allowed
    through. This is not an exploitable bypass: a key the API ignores cannot
    corrupt the change history.
  - **Presence-based, not value-validated.** The policy denies on the mere
    presence of a non-null `historyMetadata`; it does not attempt to distinguish
    a "benign" actor from a spoofed one, because on the agent channel there is no
    trustworthy actor to record other than the real caller Jira already logs.
  - **No identity-based exemptions — by design.** All callers are treated the
    same; there is no break-glass group, because a legitimate need to set custom
    change-history metadata belongs to a vetted server-side integration, not an
    interactive agent. If you must exempt one, add an `allow if` branch gated on
    `input.subject.claims`.
  - **MCP path only.** A transition/edit/create performed via the Jira web UI or
    native API is outside the gateway's reach.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - jira
industries: []
bundles:
  - atlassian
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.ingress.deny_history_actor_spoofing

# Deny-by-default: only the explicit allow rules below permit a request, so any
# ambiguous or malformed write falls through to deny (fail-closed).
default allow := false

# Lowercased tool name, fetched with object.get so a missing resource/name
# yields "" (a clean non-match) instead of a silent rule failure.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# The arguments object, defaulted to {} when payload/args is missing. Kept as a
# named value so the allow rule can assert it really is an object before
# treating a write as safe.
args := object.get(object.get(input, "payload", {}), "args", {})

# Official Jira write tools whose REST request body carries a historyMetadata
# block (change-history actor metadata). transitionJiraIssue is verified in the
# landscape note; editJiraIssue and createJiraIssue accept historyMetadata per
# Jira's REST write-issue body schema — unverified in the landscape note, so they
# are blocked defensively (see Known limitations). Matched by suffix so the policy
# stays portable across gateway server-name prefixes (atlassian-,
# atlassian-jira-mcp-, ...).
history_write_suffixes := {"transitionjiraissue", "editjiraissue", "createjiraissue"}

is_history_write_tool if {
    some suffix in history_write_suffixes
    endswith(tool_name, suffix)
}

# historyMetadata is present when the args object carries a non-null value under
# that exact key at ANY depth. Any non-null value (object, {}, or bare string)
# counts — presence signals intent to decorate the change history. Top-level is
# the documented REST placement; the deep scan (walk) also catches the key
# smuggled inside the connector's open objects (transition `fields`/`update`,
# edit `fields`, create `additional_fields`), whose merge into the REST body is
# unverified — and no legitimate Jira write nests a field named historyMetadata,
# so the deep match costs nothing. Guarded by is_object so a non-object args
# cannot be probed here (it fails closed via the allow rule below instead).
has_history_metadata if {
    is_object(args)
    walk(args, [path, value])
    count(path) > 0
    path[count(path) - 1] == "historyMetadata"
    value != null
}

# Allow anything that is not a scoped Jira write call.
allow if {
    not is_history_write_tool
}

# Allow a scoped write only when args is a well-formed object with no
# historyMetadata block. A malformed (non-object) args fails is_object here, so
# the call falls through to the default deny.
allow if {
    is_history_write_tool
    is_object(args)
    not has_history_metadata
}

# Reason: spoofing attempt (historyMetadata present).
reasons contains "This Jira write call includes a historyMetadata block, which lets the caller stamp a fabricated actor, cause, or generator onto the issue's change history and forge who performed the change. Remove the historyMetadata field and retry so Jira records the real actor. Contact your admin if a vetted integration must set change-history metadata." if {
    is_history_write_tool
    has_history_metadata
}

# Reason: malformed write payload (fail-closed deny).
reasons contains "This Jira write call has a malformed arguments object and cannot be checked for change-history actor spoofing, so it is denied. Resend the request with a well-formed arguments object and no historyMetadata block." if {
    is_history_write_tool
    not is_object(args)
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
