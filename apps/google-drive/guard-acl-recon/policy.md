---
name: Guard Drive ACL Reconnaissance
tags:
  - google-drive
  - guard-share-links
  - acl
  - sharing
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # google-drive / guard-acl-recon

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `google_drive.ingress.guard_acl_recon`

  ## What it does

  Denies Google Drive `get_file_permissions` tool calls unless the caller's IdP
  `groups` claim contains `infosec`. All other tool calls pass through unchanged.

  Agents rarely need ACL data, and the permissions response is ideal
  exfiltration-targeting reconnaissance: it enumerates collaborator email
  addresses (PII) plus a map of exactly which files are shared externally. This
  policy is the Google Drive instantiation of the `guard-share-links` family
  (PF-05): no current Drive MCP server exposes a permissions-*write* (sharing)
  tool, so on Drive the family gates the read-side share surface — ACL
  reconnaissance — instead of link creation.

  The check runs at ingress, before the call reaches the Drive MCP server, so
  denied callers never receive the ACL data.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement/removal
    of information: sharing-state maps and collaborator rosters stay off the
    agent channel except for the InfoSec group.
  - **SOC 2 P6.1** — supports controls over personal-information disclosure to
    third parties: collaborator email addresses (PI) are not enumerable by
    arbitrary agent sessions.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports security of processing by keeping
    collaborator email addresses and external-sharing state (personal data) off
    the agent channel except for the InfoSec group; **Art. 5(1)(c)** — supports
    data minimisation of the personal data returned in ACL responses. **CPRA
    §1798.121** — supports limiting disclosure of contact identifiers on the
    agent channel.

  ## Tool name matching

  The policy matches case-insensitively on the bare **`*permissions`** suffix.
  That single suffix catches every ACL-read shape seen or plausible on Drive:

  - `*get_file_permissions` — the verified tool name on the Google official
    Drive MCP server (`https://drivemcp.googleapis.com/mcp/v1`), and the
    reported name on the Anthropic-hosted Claude connector.
  - `*get_permissions` — the shorter variant the Claude connector may report
    (its suffixes are known to diverge from the Google server names, e.g.
    `get_metadata` vs `get_file_metadata`).
  - `*list_permissions` / `*list_file_permissions` / `*listPermissions` — the
    underlying Drive REST verb is `permissions.list`, so a community or future
    connector could just as plausibly expose the read under a `list`-style name.
    These are **unverified** alternate names, but the bare-`permissions` suffix
    denies them anyway, so an alternate verb can't sneak past the gate.

  No benign Drive tool across the surveyed servers ends in `permissions`, so
  gating the bare suffix closes the connector-name gap without over-matching.
  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `google-drive-mcp-get_file_permissions`), and that prefix is not
  standardized — suffix matching keeps the policy portable. Verify the exact
  name your gateway sends with the dump-input debug technique before relying on
  this in production. If your Drive MCP server exposes ACL reads under a name
  that does *not* end in `permissions`, add its suffix to `acl_read_suffixes`
  in `policy.md`.

  ## Identity gating

  The exemption reads `input.subject.claims.groups` and requires a group whose
  lowercased value equals `infosec`. The check fails closed: if `subject`,
  `claims`, or `groups` is missing — or `groups` is not an array — the caller
  is not exempt and the call is denied.

  ## Argument shape

  The policy decides on the tool name and the caller's identity only; it does
  not inspect arguments. Google does not publish per-tool parameter schemas for
  the Drive MCP server — the documented workflow implies `get_file_permissions`
  takes a file ID, but the exact field name is unverified and irrelevant to
  this policy's logic.

  ## Examples

  ### Allowed — unrelated Drive tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-drive-mcp-search_files", "type": "tool" },
      "payload": {
        "name": "google-drive-mcp-search_files",
        "args": { "query": "fullText contains 'roadmap'" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — InfoSec caller reading ACLs

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-drive-mcp-get_file_permissions", "type": "tool" },
      "subject": {
        "sub": "google-apps|sec@example.com",
        "claims": { "groups": ["engineering", "infosec"] }
      },
      "payload": {
        "name": "google-drive-mcp-get_file_permissions",
        "args": { "fileId": "1AbC..." }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — caller outside the infosec group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "google-drive-mcp-get_file_permissions", "type": "tool" },
      "subject": {
        "sub": "google-apps|dev@example.com",
        "claims": { "groups": ["engineering"] }
      },
      "payload": {
        "name": "google-drive-mcp-get_file_permissions",
        "args": { "fileId": "1AbC..." }
      }
    }
  }
  ```

  `allow = false`, `reason = "Reading Drive file permissions is restricted (...)"`.

  ## Composition

  This policy is single-purpose. Useful companions for a least-privilege Drive
  pipeline:

  - An egress PII/secret redaction policy on content-returning tools
    (`read_file_content`, `download_file_content`) so file bodies are also
    covered (PF-02). Extend it to `get_file_metadata` if your MCP server
    returns owner/sharing fields (see Known limitations) — that redacts the
    metadata-recon residual this ingress policy cannot reach.
  - An ingress bulk-export cap on `search_files` page sizes to slow mass
    enumeration (PF-08).
  - A write-gating policy on `create_file` / `copy_file` by IdP group (PF-12).

  ## Known limitations

  - **Group names are placeholders** — replace `infosec` with your IdP's group
    name at import time. The exemption only works if your IdP actually emits a
    `groups` array claim in the access token; many IdPs (including Auth0)
    require explicit configuration to do so. Until then the policy denies
    `get_file_permissions` for everyone — safe, but with no break-glass path.
  - **Argument shape unverified.** Google publishes no per-tool parameter
    schemas for the Drive MCP server; the assumed file-ID input is not relied
    on by this policy.
  - **Connector tool-name divergence.** Third-party write-ups of the Claude
    connector report slightly divergent suffixes for some tools (e.g.
    `get_metadata` vs `get_file_metadata`); the connector's names are not
    verified against official Anthropic docs. To stay ahead of this the policy
    gates the bare `permissions` suffix rather than a fixed `get_`-prefixed
    name, so `get_file_permissions`, `get_permissions`, and any `list`-style
    variant (`list_permissions` / `list_file_permissions` / `listPermissions`,
    all **unverified** but plausible given the `permissions.list` REST verb) are
    all denied. The only residual name gap is an ACL-read tool that does *not*
    end in `permissions` at all; confirm the exact name with the dump-input
    technique and add its suffix to `acl_read_suffixes` in `policy.md` if your
    traffic shows such a variant.
  - **Read-side only.** No current Drive MCP server exposes permission-editing
    or share-link-creation tools. If Google later ships them, this policy must
    be extended (or a companion added) to deny anonymous/public link creation
    per the PF-05 family spec — today that exfil path only exists via the web
    UI, outside the gateway's reach.
  - **String-valued `groups` claims deny.** If your IdP emits `groups` as a
    single string rather than an array, the exemption never fires (fail
    closed). Normalize the claim at the IdP or adapt
    `caller_is_acl_reviewer` in `policy.md`.
  - **Recon residual via file-resource projection (adjacent tools).** This
    policy gates only tools whose name ends in `permissions` — the dedicated
    ACL-read surface. But the Google Drive file resource itself carries
    `owners`, `sharingUser`, `shared`, and (when the caller selects the field)
    a `permissions[]` array, and **every tool that returns a file resource can
    project those fields** — not just `get_file_metadata` but also
    `search_files` and `list_recent_files` (both back onto Drive `files.list`,
    which accepts the same `fields` selector). So a non-InfoSec caller can
    recover the *same* collaborator emails and external-share state this policy
    withholds by asking `get_file_metadata`, `search_files`, or
    `list_recent_files` for the sharing fields. Whether a given MCP server
    actually forwards a `fields` selector and includes those fields is
    unverified (Google publishes no per-tool response schema), so these tools
    are deliberately allowed here rather than blanket-denied — denying
    `search_files` outright is the job of a separate bulk-export/enumeration
    brake (PF-08), not this policy. Close this residual with an egress
    redaction/field-stripping companion on all file-resource-returning tools
    (`get_file_metadata`, `search_files`, `list_recent_files`; see
    Composition); do not treat this ingress policy alone as sealing off ACL
    reconnaissance.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - google-drive
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package google_drive.ingress.guard_acl_recon

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder group name — replace with your IdP's group at import time.
acl_reviewer_group := "infosec"

# Drive ACL-read tools we gate. `get_file_permissions` is the verified name on
# the Google official Drive MCP server; the Claude connector is reported to use
# a slightly shorter variant (`get_permissions`). The underlying Drive REST verb
# is `permissions.list`, so an alternate server could just as plausibly expose
# the read as `list_permissions` / `list_file_permissions` / `listPermissions`.
# Rather than enumerate every prefix (get_/list_/…), we gate the bare
# `permissions` suffix: no benign Drive tool across the surveyed servers
# (search_files, list_recent_files, get_file_metadata, read_file_content,
# download_file_content, create_file, copy_file, gdrive_*, gsheets_*, and the
# piotr-agier camelCase set) ends in `permissions`, so this carries no
# false-positive risk within this app while catching every casing/verb variant.
# The gateway prefixes tool names with the configured MCP server name (e.g.
# `google-drive-mcp-`), so we match on the suffix to stay portable. Verify the
# exact name on your gateway with the dump-input debug technique.
acl_read_suffixes := ["permissions"]

is_acl_read_tool if {
    name := lower(input.resource.name)
    some suffix in acl_read_suffixes
    endswith(name, suffix)
}

# Allow any tool that isn't a Drive ACL read.
allow if {
    not is_acl_read_tool
}

# Allow ACL reads only for members of the reviewer group.
allow if {
    is_acl_read_tool
    caller_is_acl_reviewer
}

# Fail closed: missing subject, claims, or groups — or a non-array groups
# claim — means the caller is not exempt.
caller_is_acl_reviewer if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some group in groups
    lower(group) == acl_reviewer_group
}

reasons contains "Reading Drive file permissions is restricted: the response enumerates collaborator email addresses and which files are shared externally. Sharing-state review is an admin task — ask your Drive administrator to review the file's sharing settings, or ask your InfoSec team to add you to the infosec group if your role requires ACL access." if {
    is_acl_read_tool
    not caller_is_acl_reviewer
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
