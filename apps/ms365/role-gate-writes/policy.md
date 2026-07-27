---
name: "Read-Only Baseline: Group-Gated Microsoft 365 Writes"
tags:
  - ms365
  - role-gate-writes
  - ingress
  - least-privilege
  - soc2
  - gdpr-ccpa
  - sox
publishedAt: 2026-07-12
description: |
  # ms365 / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — reads pass for everyone, writes only for the writer group
  **Package:** `ms365.ingress.role_gate_writes`

  ## What it does

  The least-privilege baseline for Microsoft 365 through the gateway: every tool
  call is allowed only if it is a **read**, or the caller's IdP token carries the
  write-authorized group (placeholder: `m365-writers`). Everything that is not
  recognizably a read — sends, creates, updates, deletes, uploads, shares,
  reactions, calendar responses, `graph-batch`, and any verb the policy has never
  seen — is treated as a write and denied for callers outside the group. When
  identity claims are absent the policy fails closed: no groups, no writes.

  The softeria `ms-365-mcp-server` (the primary policy target) also ships a
  server-side `--read-only` flag. This policy is the gateway-side equivalent,
  with two advantages: it is enforced even if the server flag is dropped or the
  server is redeployed without it, and it supports **per-user** gating — trusted
  users in `m365-writers` keep write access while everyone else gets a read-only
  tenant view over the same connector.

  ## Compliance alignment

  - **SOC 2 CC6.1 / CC6.3** — supports logical access security and role-based
    least privilege over the M365 estate on the agent channel: write capability
    is granted by role, not by connector possession. **CC6.2** — the grant rides
    on live IdP claims, so deprovisioning a user in the IdP revokes agent write
    access with no gateway change. **PI1.2** — only authorized principals can
    submit state-changing inputs.
  - **HIPAA §164.502(b)/§164.514(d)** (minimum necessary) and **§164.308(a)(4)**
    (information access management) — mailbox, drive, and Teams write surfaces
    are limited to a defined workforce role; **§164.312(a)(1)** — per-call,
    identity-bound access control on the MCP path; **§164.308(a)(3)** — supports
    termination effect via IdP-claim liveness.
  - **GDPR Art. 25** — data protection by default on the agent channel (the
    default posture is read-only); **Art. 29 / 32(4)** — supports processing
    only on the controller's instructions by stopping unauthorized principals
    from acting on personal data; **Art. 5(1)(b)** purpose limitation (partial).
    **CCPA §1798.100(e)** — reasonable security procedures (partial).
  - **SOX ITGC (access to programs and data)** — supports least-privilege access
    to financially relevant systems (Excel workbooks, SharePoint lists) reached
    through M365; **COSO P10 SoD** (partial) — read-everyone/write-few is the
    coarsest separation-of-duties cut.

  ## Tool name matching

  The softeria server names tools `verb-noun` (kebab-case), and the DTwo gateway
  prepends the configured MCP server name (observed live as `ms365-`, e.g.
  `ms365-list-mail-messages`). The policy therefore classifies by the **verb
  segment**, matched case-insensitively on `lower(input.resource.name)` as a
  whole hyphen-delimited segment — either at the start of the name (unprefixed
  deployments) or immediately after a `-` (prefixed deployments). Write verbs
  additionally match as the **final** segment of the name, so a trailing write
  verb can never hide behind a leading read verb:

  - **Read verbs:** `list-`, `get-`, `search-`, `download-`, `extract-`,
    `find-`, `parse-` (e.g. `ms365-get-drive-item`, `ms365-search-query`,
    `ms365-download-bytes`).
  - **Write verbs:** `create-`, `send-`, `update-`, `delete-`, `add-`,
    `remove-`, `upload-`, `move-`, `copy-`, `share-`, `reply-`, `forward-`,
    `set-`, `clear-`, `cancel-`, `format-`, `sort-`, `merge-`, `insert-`,
    `pin-`, `accept-`, `decline-`, `tentatively-`, `dismiss-`, `snooze-`,
    `unmerge-`, `unpin-`, `unset-`, `reauthorize-`.

  A name is a read only when a read verb matches **and no write verb matches
  anywhere in the name** — so `ms365-create-sharepoint-list-item` (which
  contains `-list-` as a noun fragment) resolves to the stricter write class.
  Names matching neither list (e.g. `ms365-graph-batch`) are writes. Segment
  matching also keeps noun fragments from triggering write verbs: `-pinned-`,
  `-settings`, `-shared-`, and `-sharepoint-` do not match `pin-`, `set-`, or
  `share-`.

  The `ms365-` prefix is a deployment choice, not a standard — verify the exact
  names your gateway sends with the dump-input debug technique before relying on
  this in production.

  ## Argument shape

  This policy inspects only the tool name and the caller's identity claims — it
  never reads `input.payload.args`. The writer grant checks for the literal
  string `"m365-writers"` in `object.get(input.subject, "claims", {}).groups`,
  which must be an **array** of strings (the common IdP shape) — the Rego
  enforces `is_array` explicitly, so an object- or string-shaped `groups` claim
  never grants. The match is exact and case-sensitive (`"M365-Writers"` does
  not grant). A missing `subject`, missing `claims`, missing `groups`, or a
  non-array `groups` value all resolve to "not a writer" — the policy fails
  closed for grants.

  ## Examples

  ### Allowed — read, no identity needed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-list-mail-messages", "type": "tool" },
      "payload": { "name": "ms365-list-mail-messages", "args": {} }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — write by a group member

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-send-mail", "type": "tool" },
      "subject": {
        "sub": "google-apps|pat@example.com",
        "claims": { "groups": ["engineering", "m365-writers"] }
      },
      "payload": { "name": "ms365-send-mail", "args": { /* ... */ } }
    }
  }
  ```

  `allow = true`.

  ### Denied — write without the group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-send-mail", "type": "tool" },
      "subject": {
        "sub": "google-apps|sam@example.com",
        "claims": { "groups": ["engineering"] }
      },
      "payload": { "name": "ms365-send-mail", "args": { /* ... */ } }
    }
  }
  ```

  `allow = false`, `reason = "This Microsoft 365 tool call is a write, which requires membership in the m365-writers IdP group (...)"`.

  ## Composition

  This is the app's baseline; membership in `m365-writers` is necessary for any
  write but **not sufficient** for the highest-risk ones. Destructive operations
  (`delete-*`, `remove-*`, `cancel-*`), directory and group mutations, mailbox
  persistence (`create-mail-rule`, `create-subscription`, mailbox settings), and
  external email/Teams sends remain subject to the stricter companion policies
  (`freeze-destructive-ops`, `freeze-identity-plane`, `guard-mailbox-persistence`,
  `guard-external-send`) even for group members — policies compose with AND, so
  the strictest attached policy wins. Pair it also with a `graph-batch` /
  raw-passthrough deny (`deny-escape-hatches` family): this policy classifies
  `graph-batch` as a write, but writer-group members could otherwise reach
  arbitrary Graph endpoints through it.

  ## Known limitations

  - **Group names are placeholders** — replace `m365-writers` with your IdP's
    group name at import time, and confirm your IdP actually emits a `groups`
    claim (Entra ID requires the groups claim to be configured on the app
    registration; Auth0 needs an Action or RBAC setup). The membership check is
    exact and case-sensitive — a claim of `"M365-Writers"` denies (fails
    closed), so copy the group name from your IdP verbatim.
  - **Verb-list drift.** New tools with unknown verbs deny by default for
    non-writers (fail closed). The residual risk is a future *write* tool whose
    **leading** verb is not in the write list but whose name contains a read
    verb as a later segment (no such tool exists in the verified softeria
    inventory today) — it would classify as a read. Trailing write verbs are
    covered (write verbs also match as the final segment), so only an
    unknown-leading-verb + embedded-read-verb name can slip. Re-check the lists
    when the upstream server adds tools.
  - **Verb false positives are conservative.** A few tools are writes by verb
    but read-like in effect — e.g. `create-drive-item-preview` (renders a
    preview, persists nothing). They deny for non-writers. Misclassification
    here only ever over-blocks; add a narrow exact-name allow rule if a
    specific one matters to your users.
  - **All ingress hook kinds are gated.** The policy does not filter on
    `input.action`, so `prompt_pre_fetch` and `resource_pre_fetch` events on
    the same pipeline are classified by the same verb rules and fail closed —
    non-writers are denied prompt/resource fetches whose names don't start
    with a read verb. The softeria server is tool-only, so this is theoretical
    there; on mixed servers, add an explicit allow for those hook kinds if
    read-equivalent.
  - **Softeria vocabulary only.** Single-tool passthrough servers
    (`merill/lokka`'s `Lokka-Microsoft`) and the Anthropic-hosted M365 connector
    (tool names unpublished, not gateway-routable) defeat name-based
    classification — for Lokka, gate on the `method` argument instead; the
    Anthropic connector is a coverage gap to flag, not a policy target.
  - **Reads are not harmless.** `download-bytes`, `search-query`, transcript
    reads, and `fetchAllPages` Excel reads bulk-export data yet pass this policy
    for everyone. Pair with the egress redaction and bulk-export-cap companions.
  - **Non-array `groups` claims fail closed** — an IdP that emits `groups` as a
    single string will deny all writes until the claim is mapped to an array (or
    the policy is adapted).

  > **Compliance note.** This policy supports alignment with the cited framework
  > controls **on the MCP path only**. No policy or bundle makes an organization
  > compliant with any framework; web-UI, native-API, and in-app access are
  > outside the gateway's reach by design. Validate against your own compliance
  > program before relying on it.
direction: ingress
apps:
  - ms365
industries: []
bundles:
  - soc2
  - gdpr-ccpa
  - sox
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package ms365.ingress.role_gate_writes

# Read-only baseline: reads pass for everyone, writes require the writer group.
default allow := false

# Verb segments that identify read-only Microsoft 365 tools (softeria
# ms-365-mcp-server vocabulary, verified from a live gateway deployment).
read_verbs := {
    "list",
    "get",
    "search",
    "download",
    "extract",
    "find",
    "parse",
}

# Verb segments that identify writes. A name matching any of these is a write
# even if it also contains a read verb deeper in the name (e.g.
# create-sharepoint-list-item contains "-list-" as a noun fragment) —
# ambiguity resolves to the stricter class.
write_verbs := {
    "create",
    "send",
    "update",
    "delete",
    "add",
    "remove",
    "upload",
    "move",
    "copy",
    "share",
    "reply",
    "forward",
    "set",
    "clear",
    "cancel",
    "format",
    "sort",
    "merge",
    "insert",
    "pin",
    "accept",
    "decline",
    "tentatively",
    "dismiss",
    "snooze",
    "unmerge",
    "unpin",
    "unset",
    "reauthorize",
}

# Case-insensitive tool name; missing fields resolve to "" (fail closed).
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# A verb matches only as a whole hyphen-delimited segment: at the start of the
# name (unprefixed deployment) or right after a "-" (gateway server-name
# prefix, e.g. "ms365-list-mail-messages"). This keeps noun fragments like
# "-pinned-", "-settings", or "-shared-" from matching "pin-"/"set-"/"share-".
verb_in_name(verb) if {
    startswith(tool_name, sprintf("%s-", [verb]))
}

verb_in_name(verb) if {
    contains(tool_name, sprintf("-%s-", [verb]))
}

matches_read_verb if {
    some verb in read_verbs
    verb_in_name(verb)
}

matches_write_verb if {
    some verb in write_verbs
    verb_in_name(verb)
}

# Write verbs additionally match as the final segment (no trailing hyphen), so
# a name with a leading read verb and a trailing write verb (hypothetical
# "get-chat-message-unpin") cannot classify as a read. Read verbs deliberately
# do NOT get final-segment matching: a trailing read noun (the "list" in
# "delete-todo-task-list") must not soften a write, and an unknown-verb name
# stays a write.
matches_write_verb if {
    some verb in write_verbs
    endswith(tool_name, sprintf("-%s", [verb]))
}

# A read is a read verb with no write verb anywhere in the name. Everything
# else — write verbs, both-class names, unknown verbs, missing names — is
# treated as a write.
is_read_tool if {
    matches_read_verb
    not matches_write_verb
}

# Writer grant: the IdP token must carry the m365-writers group. Placeholder —
# replace with your IdP's group name at import time. Missing subject, claims,
# or groups resolve to an empty list: no group claim, no grant.
caller_groups := object.get(
    object.get(object.get(input, "subject", {}), "claims", {}),
    "groups",
    []
)

is_writer if {
    is_array(caller_groups)
    some group in caller_groups
    group == "m365-writers"
}

# Reads pass for everyone.
allow if {
    is_read_tool
}

# Writers may call anything.
allow if {
    is_writer
}

reason := "This Microsoft 365 tool call is a write, which requires membership in the m365-writers IdP group; your identity token does not carry it. Read tools (list, get, search, download, extract, find, parse) remain available. Contact your InfoSec team for write access, or if this looks like a misclassified read." if not allow
```
