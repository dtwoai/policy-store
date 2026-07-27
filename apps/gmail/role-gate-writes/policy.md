---
name: "Gmail: Role-Gated Writes (Read-Only Default)"
tags:
  - gmail
  - role-gate-writes
  - access-control
  - least-privilege
  - ingress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # gmail / role-gate-writes

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny everything except verified read tools; writes require the writer group
  **Package:** `gmail.ingress.role_gate_writes`

  ## What it does

  Makes Gmail read-only by default on the MCP path. Verified read tools pass for everyone.
  Every other Gmail tool — all draft, send, label, filter, modify, and delete tools across
  the three common Gmail MCP vocabularies (`create_draft`, `draft_email`,
  `draft_gmail_message`, `create_label`, `update_label`, `get_or_create_label`,
  `label_thread`, `unlabel_thread`, `label_message`, `unlabel_message`, `modify_email`,
  `batch_modify_emails`, `modify_gmail_message_labels`, `batch_modify_gmail_message_labels`,
  `manage_gmail_label`, `manage_gmail_filter`, `create_filter`,
  `create_filter_from_template`, `send_email`, `send_gmail_message`, `delete_email`,
  `batch_delete_emails`, `delete_label`, `delete_filter`) — is denied unless the caller's
  IdP `groups` claim contains the placeholder group `mcp-gmail-writers`, failing closed when
  identity claims are absent.

  The policy is structured as a **read-suffix allowlist**, not a write blocklist. This is
  deliberate: the three Gmail MCP servers in real use diverge sharply in capability — the
  official Google/Claude connector is draft-only with no send and no delete, while the
  community servers (GongRzhe, taylorwilsdon) add send, permanent delete, filter creation
  (auto-forward persistence), and local-file attachment bridges. A tenant that swaps the
  Claude connector for a community server silently gains those write primitives; with a
  read-suffix allowlist, every tool the policy has never heard of — including all of those —
  is denied by default instead of slipping through.

  The check runs at ingress, before the call reaches the Gmail MCP server, so a denied
  write never executes and has no side effects.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets: a mailbox
    cannot be mutated over the agent channel without an explicit role grant. **CC6.3** —
    supports role-based access and least privilege: write capability is tied to a live IdP
    group, and removing the group in the IdP removes write access on the next call
    (supporting **CC6.2** credential de-provisioning on the MCP path).
  - **HIPAA §164.502(b) / §164.514(d)** — supports minimum-necessary, role-based limits
    where mailboxes carry ePHI (patient email is routine PHI): write authority is scoped to
    a role. **§164.308(a)(4)** — supports information access management;
    **§164.312(a)(1)** — supports technical access control with per-call identity from the
    caller's JWT; **§164.308(a)(3)** — supports workforce-security termination effect,
    since IdP group removal takes effect on the next call.
  - **PCI DSS 7.2.1 / 7.2.2** — supports a least-privilege access model for agent access to
    mailboxes that may carry cardholder data. **7.2.5** — supports application/system
    account least privilege: the agent's effective Gmail capability is narrowed to
    read-only regardless of the breadth of the underlying OAuth grant.
  - **GDPR Art. 25** — supports data protection by design/default on the agent channel: the
    default posture is read-only. **Art. 29 / Art. 32(4)** — supports processing only on
    the controller's instructions: unauthorized principals cannot alter or send personal
    data through the agent. **Art. 5(1)(b)** — supports purpose limitation by separating
    read-analysis use from mailbox mutation. **CCPA §1798.100(e)** — supports reasonable
    security procedures over consumers' personal information in email.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name (e.g.
  `gmail-mcp-search_threads`), and the prefix is not standardized — so matching is
  case-insensitive and by suffix. The read allowlist covers all three verified Gmail MCP
  vocabularies:

  1. **Google official remote server / Claude Gmail connector:** `search_threads`,
     `get_thread`, `list_drafts`, `list_labels`.
  2. **GongRzhe/Gmail-MCP-Server (archived but widely deployed):** `read_email`,
     `search_emails`, `list_email_labels`, `list_filters`, `get_filter`,
     `download_attachment`.
  3. **taylorwilsdon/google_workspace_mcp:** `search_gmail_messages`,
     `get_gmail_message_content`, `get_gmail_messages_content_batch`,
     `get_gmail_thread_content`, `get_gmail_threads_content_batch`,
     `get_gmail_attachment_content`, `list_gmail_labels`, `list_gmail_filters`.

  Anything that does not match one of those suffixes **at a name boundary** requires the
  writer group. Matching is boundary-anchored: a read suffix counts only when the tool name
  is exactly the suffix (bare) or the suffix follows a `-` (the gateway server-prefix
  separator) or `_` (a tool-name word separator). Note that `get_or_create_label` is
  correctly gated as a write despite its `get_` prefix — suffix matching does not confuse it
  with a read. Verify the exact names your gateway sends with
  the dump-input debug technique before relying on this in production; if your Gmail server
  exposes an additional genuinely read-only tool, add it to `read_suffixes` in `policy.md`.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`) and the caller's identity
  (`input.subject.claims.groups`). Tool arguments are not inspected, so the policy cannot
  be bypassed by unusual argument keys, nesting, or encodings — and it works identically
  whether or not a tool's argument schema is documented (the official `create_draft` field
  names, for example, are unverified).

  ## Identity

  Group membership is read fail-closed via
  `object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])`:
  a missing subject, missing claims, a missing `groups` claim, or a `groups` claim that is
  not an array all mean "not a writer", and every non-read call is denied. Reads are
  unaffected by identity.

  ## Examples

  ### Allowed — read tool, no identity required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-mcp-search_threads", "type": "tool" },
      "payload": { "name": "gmail-mcp-search_threads", "args": { "query": "from:billing" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — send tool, caller not in the writer group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "gmail-mcp-send_email", "type": "tool" },
      "subject": { "sub": "auth0|alice", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "gmail-mcp-send_email",
        "args": { "to": ["vendor@example.com"], "subject": "Q3", "body": "..." }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Gmail tool can change mailbox state (draft, send, label, filter, modify, or delete), so it is restricted to members of the 'mcp-gmail-writers' group ..."`.

  ## Composition

  This policy is the Gmail least-privilege baseline; it gates *who* may write, not *what*
  writers may do. Useful companions:

  - An external-send guard that inspects `to`/`cc`/`bcc` domains on `send_email` /
    `send_gmail_message`, so even authorized writers cannot mail outside the organization.
  - A destructive-op freeze that keeps `delete_email` / `batch_delete_emails` /
    `delete_label` / `delete_filter` denied for everyone (retention and evidence
    preservation), stricter than the writer group.
  - A mailbox-persistence guard denying filter creation (`create_filter`,
    `create_filter_from_template`, `manage_gmail_filter`) — auto-forward rules are a
    classic BEC exfiltration primitive that outlives the session.
  - An egress redaction policy on `get_thread` / `read_email` / `get_gmail_*_content*`
    responses (PANs, SSNs, reset links), since this policy leaves the read path open.
  - A bulk-read cap on the batch content tools and `maxResults` to throttle
    mass-harvesting through the open read path.

  ## Known limitations

  - **Group names are placeholders** — replace `mcp-gmail-writers` with your IdP's group
    name at import time. The policy expects `groups` to be an array claim in the caller's
    JWT; if your IdP emits roles under a different or namespaced claim (e.g.
    `https://acme.com/groups`), update `caller_groups` in `policy.md`.
  - **Exact per-gateway tool names are unverified.** The suffixes above are verified
    against vendor docs and source for the three servers, but the gateway's server-name
    prefix (and any tenant renames) must be confirmed with the dump-input technique before
    production use.
  - **Reads are open to everyone**, and Gmail reads are high-value egress: `get_thread`
    with `FULL_CONTENT`, `read_email`, and the batch content tools return raw email bodies
    that routinely contain PII, PHI, credentials, and reset links. Pair with egress
    redaction and, where needed, a group gate on body-reading tools.
  - **`download_attachment` is allowlisted as a read**, but on the GongRzhe server it
    writes the attachment to an arbitrary local path (`savePath`) on the host running the
    stdio server. If that local-file bridge matters in your deployment, remove it from
    `read_suffixes` so it requires the writer group.
  - **Suffix matching is boundary-anchored** to prevent over-match: a read suffix counts
    only when the tool name equals it exactly (bare) or the suffix follows a `-`/`_`
    separator. So a hypothetical write `forget_thread` (which ends in the read suffix
    `get_thread` but with no boundary before it) is correctly treated as a write and gated.
    A residual collision could still occur only if a genuine *write* tool's canonical name
    were itself exactly one of the read suffixes, or ended in `-`/`_` + a read suffix — no
    such case exists in the three verified vocabularies; re-check the boundary cases when
    adding a server.
  - **Everything non-read on the pipeline is gated**, including prompt/resource fetch
    hooks and any non-Gmail tools (management tools like `dtwo-*` included) sharing the
    pipeline. Attach this policy to a Gmail-scoped pipeline, or add an explicit
    passthrough `allow if` rule for your management prefix.
  - **Writers get every write.** The group grants label edits and permanent deletes alike;
    use the companion policies above to keep irreversible and externally visible actions
    behind stricter gates.

  > **Compliance note.** This policy supports alignment with the cited framework controls
  > **on the MCP path only**. No policy or bundle makes an organization compliant with any
  > framework; web-UI, native-API, and in-app access are outside the gateway's reach by
  > design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - gmail
industries: []
bundles:
  - soc2
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package gmail.ingress.role_gate_writes

# Deny-by-default: verified read tools are explicitly allowed below; every
# other tool — known writes and anything unknown or future — requires
# membership in the writer group. The allowlist shape is deliberate: Gmail MCP
# servers diverge sharply in write capability (the official connector is
# draft-only; community servers add send/delete/filters), so unknown tools
# must fail closed.
default allow := false

# Placeholder IdP group permitted to perform Gmail writes.
# Replace "mcp-gmail-writers" with your IdP's group name at import time.
writer_group := "mcp-gmail-writers"

# Lowercased tool name. The gateway prefixes tool names with the configured
# MCP server name (e.g. `gmail-mcp-search_threads`), so matching below is
# case-insensitive and suffix-based to stay portable.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim
# that is not an array all yield "not a writer" — non-read calls then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

caller_is_writer if {
    some group in caller_groups
    group == writer_group
}

# --- Read-tool allowlist ---
# Verified read-only tools across the three Gmail MCP vocabularies. Anything
# not matching one of these suffixes at a name boundary is treated as a write.
read_suffixes := [
    # Google official remote server / Claude Gmail connector
    "search_threads",
    "get_thread",
    "list_drafts",
    "list_labels",
    # GongRzhe/Gmail-MCP-Server (archived March 2026, still widely deployed)
    "read_email",
    "search_emails",
    "list_email_labels",
    "list_filters",
    "get_filter",
    "download_attachment",
    # taylorwilsdon/google_workspace_mcp
    "search_gmail_messages",
    "get_gmail_message_content",
    "get_gmail_messages_content_batch",
    "get_gmail_thread_content",
    "get_gmail_threads_content_batch",
    "get_gmail_attachment_content",
    "list_gmail_labels",
    "list_gmail_filters",
]

# A read suffix matches only at a name boundary: either the tool name is
# exactly the suffix (bare, unprefixed) or the suffix follows a separator
# ('-' between the gateway server-prefix and the tool, or '_' between tool
# name words). This prevents suffix over-match, where an unrelated word merely
# ends in a read name — e.g. a hypothetical write `forget_thread` ends in the
# read suffix `get_thread` but is NOT preceded by a boundary, so it is treated
# as a write and gated. Every verified read arrives as `<server>-<tool>` (or
# bare), so real reads always match; only over-match collisions are excluded.
read_suffix_match(name, suffix) if {
    name == suffix
}

read_suffix_match(name, suffix) if {
    endswith(name, concat("", ["-", suffix]))
}

read_suffix_match(name, suffix) if {
    endswith(name, concat("", ["_", suffix]))
}

is_read_tool if {
    some suffix in read_suffixes
    read_suffix_match(tool_name, suffix)
}

# --- Decision ---

# Verified read tools pass for everyone.
allow if {
    is_read_tool
}

# Everything else — every draft/send/label/filter/modify/delete tool and any
# unknown or future tool — passes only for members of the writer group.
allow if {
    not is_read_tool
    caller_is_writer
}

reasons contains msg if {
    not is_read_tool
    not caller_is_writer
    msg := sprintf("This Gmail tool can change mailbox state (draft, send, label, filter, modify, or delete), so it is restricted to members of the '%s' group — this account has read-only Gmail access through the gateway. Ask your identity admin to add you to '%s', or hand this step to a teammate with Gmail write access. If this tool is actually read-only, contact your InfoSec team to add it to the policy's read allowlist.", [writer_group, writer_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
