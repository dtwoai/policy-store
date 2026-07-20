---
name: Block Public Dropbox Share, Download, and File-Request Links
tags:
  - dropbox
  - guard-share-links
  - sharing
  - external-sharing
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # dropbox / guard-share-links-external

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `dropbox.ingress.guard_share_links_external`

  ## What it does

  Denies, by default, the Dropbox tools that turn an internal file into an
  internet-visible resource in a single call — before the request ever reaches
  Dropbox:

  - **Public share links** — `CreateSharedLink` (official server) and its
    community equivalents `get_sharing_link` (`dbx-mcp-server`) and
    `dropbox_create_shared_link` (`ngs`). A Dropbox shared link defaults to
    *anyone with the link*: a public, anonymous URL.
  - **Single-use download URLs** — `DownloadLink` (official), a temporary public
    download URL.
  - **External upload endpoints** — `CreateFileRequest` (official), an
    externally-reachable upload URL.

  These are the highest-risk writes on the Dropbox MCP surface and are
  effectively irreversible once the URL has been fetched, so the policy fails
  closed (`default allow := false`) and permits them **only** when the caller's
  IdP groups (`input.subject.claims.groups`) include the placeholder
  `dropbox-sharing` group. Every read tool and every non-sharing write passes
  through untouched.

  Matching is case-insensitive and **by substring** (`contains`), so it survives
  the gateway's configured server-name prefix (e.g. `dropbox-CreateSharedLink`),
  the PascalCase/snake_case divergence between the official and community
  servers, **and** any trailing API-style token — a variant such as
  `CreateSharedLinkWithSettings` or `create_shared_link_with_settings` (the real
  Dropbox v2 endpoint name) is still caught, where a pure suffix match would have
  let it through.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission, movement, and
    removal of confidential information by stopping an agent from minting public
    share links, download URLs, and external upload endpoints on the MCP path.
  - **SOC 2 P6.1** — supports limiting disclosure of personal information to
    third parties: files commonly kept in Dropbox (HR records, contracts,
    financial statements) cannot be exposed to the open internet by an agent
    without an explicitly authorized group.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports the security-of-processing and
    confidentiality principle by stopping agent-initiated movement of
    personal-data files to anonymous public URLs or external upload endpoints on
    the MCP path; **Arts. 44/46** — supports the restriction on cross-border
    transfers by denying public share links an agent cannot otherwise scrutinize.
    **CCPA/CPRA §1798.121** — supports limiting the disclosure of sensitive
    personal information by keeping SPI-bearing files off internet-visible links.
  - **HIPAA §164.308(a)(4)** — supports information access management by keeping
    an agent from exposing PHI-bearing Dropbox files to external parties;
    **§164.502(e)** — supports the business-associate disclosure limit by
    blocking public share links, download URLs, and file requests, which would
    place PHI with parties that may hold no BAA.

  ## Tool name matching

  All matching is case-insensitive on `lower(input.resource.name)` and by
  substring (`contains`), because the DTwo gateway prefixes tool names with the
  configured MCP server name (e.g. `dropbox-CreateSharedLink`,
  `dropbox-mcp-get_sharing_link`) and an upstream server may append a trailing
  token (`...WithSettings`, `...V2`). The matched stems cover the three Dropbox
  dialects:

  **Public share-link creation**
  - Official remote server (`mcp.dropbox.com`): `*createsharedlink`
  - Community `amgadabdelhafez/dbx-mcp-server`: `*get_sharing_link`
  - Community `ngs/dropbox-mcp-server`: `*create_shared_link`
    (matches `dropbox_create_shared_link`)

  **External download / upload URL minters (official)**
  - `*downloadlink` (`DownloadLink`)
  - `*createfilerequest` (`CreateFileRequest`)

  Read-only sharing tools (`ListSharedLinks`, `GetSharedLinkMetadata`,
  `ListFileRequests`, `GetFileRequest`) and the `ngs`
  `dropbox_revoke_shared_link` revocation tool are intentionally **not** matched
  — this policy guards the *creation* of external exposure, not its enumeration
  or removal. Verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  This policy inspects **no arguments** — the decision is made purely on the tool
  identity and the caller's group membership. That is deliberate: Dropbox does
  not publish the JSON schemas for its MCP tools, so the invitee-email and
  link-audience argument names are unverified (see the landscape note). Narrowing
  a share to a specific audience or corporate-domain invitee set belongs to a
  **companion transform** authored once a live `tools/list` pins the real
  argument names — not to this default-deny policy, which would otherwise fail
  open on any argument shape it guessed wrong.

  ## Identity

  Group membership is read from `input.subject.claims.groups` via `object.get`
  chains, so a missing `subject`, missing `claims`, or missing/empty/non-array
  `groups` claim never grants access — the sharing tools fail closed. Group names
  are compared case-insensitively.

  ## Examples

  ### Allowed — read tool passes through

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-GetFileContent", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "dropbox-GetFileContent",
        "args": { "path": "/Projects/roadmap.pdf" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Allowed — sharing-group member creates a share link

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-CreateSharedLink", "type": "tool" },
      "subject": { "sub": "google-apps|ops@example.com", "claims": { "groups": ["dropbox-sharing"] } },
      "payload": {
        "name": "dropbox-CreateSharedLink",
        "args": { "path": "/Projects/roadmap.pdf" }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — public share link, caller not in the sharing group

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "dropbox-CreateSharedLink", "type": "tool" },
      "subject": { "sub": "google-apps|dev@example.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "dropbox-CreateSharedLink",
        "args": { "path": "/Finance/2026/payroll.xlsx" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Creating a public Dropbox share link, download link, or file request (...)"`.

  ## Composition

  This policy is single-purpose — it blocks *creation* of external Dropbox
  surfaces by default. Useful companions:

  - A **companion transform** on `CreateSharedLink` that, once a live
    `tools/list` pins the real argument names, downgrades `audience: public →
    team` and strips non-corporate-domain invitees, so authorized sharing-group
    members are still constrained. That argument narrowing is deliberately left
    out of this policy (see Argument shape).
  - [`fence-sensitive-paths`](../fence-sensitive-paths/policy.md) — gates reads,
    listings, moves, copies, and search of fenced Dropbox trees by IdP group, so
    an unauthorized caller cannot even read the content this policy stops them
    from sharing outward.
  - An egress DLP/redaction policy on `GetFileContent` / `download_file`
    responses.

  ## Known limitations

  - **No argument inspection — audience and invitees are not narrowed here.**
    Because Dropbox publishes no MCP JSON schemas, the link-audience and
    invitee-email argument names are unverified. This policy therefore gates on
    tool identity + group membership only. A sharing-group member can still
    create a genuinely public link or invite an external email; constrain that
    with the companion transform once a live `tools/list` pins the argument names
    (see Composition).
  - **Tool names are unverified beyond the landscape note.** The official
    PascalCase names (`CreateSharedLink`, `DownloadLink`, `CreateFileRequest`)
    and the community snake_case names (`get_sharing_link`,
    `dropbox_create_shared_link`) come from the Dropbox help docs and community
    READMEs, not a live `tools/list`. Matching is by case-insensitive substring
    (`contains`), so server-name prefixes and trailing tokens like
    `...WithSettings`/`...V2` are already covered; but a genuinely different verb
    (one containing none of the stems in `external_share_stems`) would still slip
    through. In particular the stems are deliberately narrow to avoid catching the
    read/revoke tools (`list_shared_links`, `revoke_shared_link`), so a *creation*
    tool named with the "shared"-not-"sharing" spelling but a different verb — a
    hypothetical `get_shared_link` or a bare `share_link` — matches none of the
    stems and would pass through. (The broader stem `shared_link` cannot be added
    without also catching `list_shared_links`/`revoke_shared_link` and breaking
    their intended pass-through.) If your server exposes such a name for an
    external-sharing surface, add its stem to `external_share_stems` in the Rego
    and confirm with the dump-input debug technique before production.
  - **Group names are placeholders.** Replace `dropbox-sharing` with your IdP's
    group name at import time. Callers with no `groups` claim, an empty claim, or
    a non-array claim are simply not in the group (fail-closed for the grant).
  - **Read/revoke sharing tools are out of scope.** Enumerating existing shared
    links (`ListSharedLinks`, `GetSharedLinkMetadata`) or revoking them is not
    guarded here; pair with a read-side fence or egress policy if listing
    existing external links is itself sensitive.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - dropbox
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package dropbox.ingress.guard_share_links_external

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group whose members may mint external Dropbox sharing
# surfaces. Replace `dropbox-sharing` with your IdP's group name at import time.
sharing_group := "dropbox-sharing"

# Normalized tool name, safe against a missing resource/name. The gateway
# prefixes tool names with the configured MCP server name, so all matching below
# is by case-insensitive substring (`contains`, not `endswith`) to stay portable
# across both a server-name prefix and a trailing API-style token.
tool_name := lower(object.get(object.get(input, "resource", {}), "name", ""))

# Substring stems of the externally-reachable Dropbox sharing tools across the
# three dialects. Matched by `contains` (not `endswith`), so any gateway
# server-name PREFIX is tolerated AND any trailing API-style token is caught too
# — e.g. `create_shared_link_with_settings` (the real Dropbox v2 endpoint name)
# or a `CreateSharedLinkV2`/`...WithSettings` variant would slip past a pure
# suffix match. The read/revoke tools this policy passes through
# (`ListSharedLinks`, `GetSharedLinkMetadata`, `dropbox_list_shared_links`,
# `dropbox_revoke_shared_link`, `ListFileRequests`, `GetFileRequest`,
# `download_file`, `dropbox_download`) were verified to contain none of these
# stems, so `contains` introduces no false positives.
external_share_stems := [
	"createsharedlink", # official CreateSharedLink (public share link)
	"get_sharing_link", # community dbx-mcp-server (public share link)
	"create_shared_link", # community ngs dropbox_create_shared_link (public share link)
	"downloadlink", # official DownloadLink (single-use public download URL)
	"createfilerequest", # official CreateFileRequest (external upload endpoint)
]

is_external_share_tool if {
	some s in external_share_stems
	contains(tool_name, s)
}

# Caller's IdP groups, via object.get chains so a missing subject/claims/groups
# fails closed (no group -> not permitted to share externally).
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# True when the caller's groups claim (an array of strings) contains the sharing
# group. A malformed (non-array/string) claim makes the iteration fail -> fail
# closed. Compared case-insensitively.
caller_in_sharing_group if {
	some g in caller_groups
	lower(g) == sharing_group
}

# --- Allow rules --------------------------------------------------------------

# Pass through every tool that is not an external-sharing surface (all reads and
# non-sharing writes).
allow if not is_external_share_tool

# Permit external-sharing tools only for members of the sharing group.
allow if {
	is_external_share_tool
	caller_in_sharing_group
}

# --- Deny reasons -------------------------------------------------------------

reasons contains "Creating a public Dropbox share link, download link, or file request turns an internal file into an internet-visible resource in one step and is effectively irreversible once the URL is fetched, so it is blocked on the agent path by default. Route the file through an internal Dropbox channel (a shared team folder or existing workspace) instead, or ask a member of the 'dropbox-sharing' group to create the link. Contact your InfoSec team if this was a false positive." if {
	is_external_share_tool
	not caller_in_sharing_group
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
