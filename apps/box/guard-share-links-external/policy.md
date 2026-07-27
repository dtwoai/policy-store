---
name: Guard Box Share Links and External Collaborations
tags:
  - box
  - guard-share-links
  - sharing
  - external-sharing
  - ingress
  - soc2
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # box / guard-share-links-external

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `box.ingress.guard_share_links_external`

  ## What it does

  Blocks the externally-visible Box sharing surface — the riskiest Box surface an
  agent can touch — before the call ever reaches Box:

  1. **External collaborations.** Collaboration create/update calls are denied when
     the invitee's email login (`accessible_by.login` on the official server,
     `user_login` on the community server) has a domain outside a documented
     allowlist of corporate domains. Grants that carry **no email login at all**
     (id-based user grants, group grants, and role-only collaboration updates)
     **fail closed** for non-exempt callers, because the domain check cannot run.
  2. **Public share links.** Shared-link create/update calls are denied when
     `access` is `open` — an `open` link mints an anonymous URL that is visible
     outside the organization the moment it is created. `company` and
     `collaborators` access pass through. An `access` value that is **present
     but not a string** (e.g. `{"value":"open"}` or `["open"]`, an evasion of
     the string check) also **fails closed**; only a wholly absent `access`
     passes (see Known limitations).

  Callers in a placeholder `infosec` IdP group (read from
  `input.subject.claims.groups`, fail-closed when claims are missing) are exempt
  from both checks. All other Box tools pass through unchanged.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission, movement, and
    removal of confidential information by stopping agent-initiated external
    collaboration grants and anonymous share links on the MCP path.
  - **SOC 2 P6.1** — supports limits on disclosure of personal information to
    third parties: documents commonly stored in Box (HR files, contracts,
    financials) cannot be shared to non-corporate email domains or exposed via
    public URLs by an agent.
  - **GDPR Art. 5(1)(f) / Art. 32** — supports the security-of-processing and
    confidentiality principle by stopping agent-initiated movement of
    personal-data documents to external domains or anonymous public URLs on the
    MCP path; **Arts. 44/46** — supports the restriction on cross-border
    transfers by denying external-domain collaboration grants an agent cannot
    otherwise scrutinize.
  - **HIPAA §164.308(a)(4)** — supports information access management by keeping
    an agent from granting external parties access to PHI-bearing Box documents;
    **§164.502(e)** — supports the business-associate disclosure limit by
    blocking shares to non-corporate domains and anonymous public links, which
    would place PHI with parties that may hold no BAA.

  ## Tool name matching

  All matching is case-insensitive on `lower(input.resource.name)` and by suffix,
  because the DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `box-remote-create_collaboration`). Both Box MCP dialects are covered:

  **Collaboration grants**
  - Official hosted server (`mcp.box.com`): `*create_collaboration`, `*update_collaboration`
  - Community `box-community/mcp-server-box`: `*_by_user_login_tool`,
    `*_by_user_id_tool`, `*_by_group_id_tool` (file and folder variants),
    `*box_collaboration_update_tool`, `*set_collaboration_tool`

  **Shared links**
  - Official: `*add_file_shared_link`, `*add_folder_shared_link`
  - Community: any `*create_or_update_tool` whose name contains `shared_link`
    (covers the file, folder, and web-link mirrors)

  Read-only collaboration/shared-link tools (`list_item_collaborations`,
  `box_shared_link_*_get_*`, removal tools) are intentionally not matched — this
  policy guards grants, not revocations. Verify the exact names your gateway sends
  with the dump-input debug technique before relying on this in production.

  ## Argument shape

  - Official `create_collaboration`: `item` (`type` + `id`), `accessible_by`
    (`{type: user|group, login | id}`), `role`. The policy reads
    `accessible_by.login` and checks its email domain.
  - Official `update_collaboration`: takes a collaboration id and a new `role` —
    it carries no login, so it **fails closed** to the exempt group. Role
    escalation on an existing external collaboration cannot be domain-checked at
    ingress.
  - Community collaboration tools: `file_id`/`folder_id`, `user_login`, `role`.
    The policy reads `user_login`. The `_by_user_id_tool` / `_by_group_id_tool`
    variants carry no login and fail closed.
  - Shared-link tools: `file_id`/`folder_id`, `access`
    (`open` | `company` | `collaborators`), plus permission flags. The policy
    reads `access` only.

  Replace the placeholder domain allowlist (`allowed_domains`, ships as
  `example.com`) with your corporate domains at import time.

  ## Examples

  ### Allowed — internal collaboration

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-remote-create_collaboration", "type": "tool" },
      "payload": {
        "name": "box-remote-create_collaboration",
        "args": {
          "item": { "type": "folder", "id": "9821" },
          "accessible_by": { "type": "user", "login": "bob@example.com" },
          "role": "viewer"
        }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — public share link

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "box-remote-add_file_shared_link", "type": "tool" },
      "payload": {
        "name": "box-remote-add_file_shared_link",
        "args": { "file_id": "1234", "access": "open" }
      }
    }
  }
  ```

  `allow = false`, `reason = "Public 'open' Box shared links are blocked (...)"`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - A transform-only ingress policy that **downgrades** instead of denying —
    rewrite `access: open → company` and force `can_download: false` for
    environments where a hard deny is too disruptive.
  - A destructive-op gate for the community server (`box_*_delete_tool`,
    `box_collaboration_delete_tool`) — deleting a collaboration is not covered
    here.
  - An egress PII redaction policy on `get_file_content` / `ai_qa_*` responses.

  ## Known limitations

  - **Official-server argument names are partially unverified.** Box's docs do not
    publish full JSON schemas for the hosted MCP server; `accessible_by.login` and
    `access` follow the underlying Box API and Box blog examples. Confirm against
    a live `tools/list` (or the dump-input technique) before production use. If
    the official server nests arguments differently, the collaboration branch
    fails closed (deny) rather than open.
  - **Box's own guardrails are a second layer, not a substitute.** Box disables
    external-collaborator support on the hosted server by default (an admin must
    enable it per-enterprise), and blocks many writes on items with external
    exposure. Do not rely on that in place of this policy — the community server
    has no such guardrail, and an admin can switch the default off. Conversely,
    this policy does not replace Box enterprise sharing settings.
  - **A missing `access` field passes through.** Shared-link calls that omit
    `access` fall back to your Box enterprise default, which this policy cannot
    see. If your enterprise default is `open`, tighten it in the Box Admin
    Console, or extend the policy to fail closed on a missing `access`. (A
    *present-but-non-string* `access` is different — it fails closed, see What
    it does.)
  - **Only the dedicated sharing tools are matched (alternate create paths).**
    The match set is the four official sharing tools plus the community
    collaboration / `*create_or_update_tool` mirrors named in the landscape
    note. If the official server lets a *non-sharing* tool mint or open a
    shared link as a side effect — e.g. `update_file_properties` /
    `update_folder_properties` carrying a nested `shared_link.access`, or a hub
    tool — that call is **not** guarded here and passes through (those
    side-channel argument shapes are unverified against a live `tools/list`).
    Add the extra tool suffixes to `is_shared_link_tool` if your gateway shows a
    `shared_link` argument on them. Likewise out of scope: the community
    `box_file_set_download_open_tool` (download scope on an existing link) and
    `box_folder_set_upload_email_tool` (inbound public upload address) — neither
    is a share-link/collaboration grant, but both widen exposure; gate them with
    a companion policy if needed.
  - **Group names are placeholders** — replace `infosec` with your IdP's group
    name at import time, and `example.com` in `allowed_domains` with your
    corporate domains. Callers with no `groups` claim are simply not exempt
    (fail-closed for the exemption).
  - **Id-based and group grants always fail closed** for non-exempt callers, even
    when the target user is internal — the policy cannot resolve a Box user id to
    an email domain at ingress. Route those grants through the exempt group.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - box
industries: []
bundles:
  - soc2
  - hipaa
  - gdpr-ccpa
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package box.ingress.guard_share_links_external

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder allowlist of corporate email domains for Box collaborations.
# Replace `example.com` with your organization's domains at import time.
allowed_domains := {"example.com"}

# Normalized tool name. The gateway prefixes tool names with the configured
# MCP server name (e.g. `box-remote-create_collaboration`), so all matching
# below is by case-insensitive suffix to stay portable.
tool_name := lower(input.resource.name)

# Tool arguments, safe against a missing payload/args.
args := object.get(object.get(input, "payload", {}), "args", {})

# --- Exemption: placeholder `infosec` IdP group -----------------------------
# Read via object.get chains so missing claims fail closed (no group -> not
# exempt). Replace `infosec` with your IdP's group name at import time.
is_exempt_caller if {
	claims := object.get(object.get(input, "subject", {}), "claims", {})
	groups := object.get(claims, "groups", [])
	some g in groups
	lower(g) == "infosec"
}

# --- Collaboration-grant tools (both dialects) ------------------------------

# Official hosted server (mcp.box.com)
is_collab_tool if endswith(tool_name, "create_collaboration")

is_collab_tool if endswith(tool_name, "update_collaboration")

# Community server: email-login grants (file + folder variants)
is_collab_tool if endswith(tool_name, "_by_user_login_tool")

# Community server: id-based user grants — no login, fail closed below
is_collab_tool if endswith(tool_name, "_by_user_id_tool")

# Community server: group grants — no login, fail closed below
is_collab_tool if endswith(tool_name, "_by_group_id_tool")

# Community server: role/status update on an existing collaboration
is_collab_tool if endswith(tool_name, "box_collaboration_update_tool")

# Community server: folder-level collaboration setter
is_collab_tool if endswith(tool_name, "set_collaboration_tool")

# --- Shared-link tools (both dialects) ---------------------------------------

# Official hosted server
is_shared_link_tool if endswith(tool_name, "add_file_shared_link")

is_shared_link_tool if endswith(tool_name, "add_folder_shared_link")

# Community server: file / folder / web-link create-or-update mirrors
is_shared_link_tool if {
	contains(tool_name, "shared_link")
	endswith(tool_name, "create_or_update_tool")
}

# --- Argument extraction ------------------------------------------------------

# Invitee email login. Official server: `accessible_by.login`; community
# server: `user_login`. Undefined when neither carries a non-empty string —
# which makes the collaboration allow rule below fail closed.
collab_login := login if {
	login := object.get(object.get(args, "accessible_by", {}), "login", "")
	login != ""
}

collab_login := login if {
	object.get(object.get(args, "accessible_by", {}), "login", "") == ""
	login := object.get(args, "user_login", "")
	login != ""
}

# True when `login` is a well-formed email whose domain is on the corporate
# allowlist. Requires exactly one `@` so crafted logins such as
# `mallory@evil.com@example.com` cannot smuggle an approved suffix.
login_domain_allowed(login) if {
	parts := split(lower(trim_space(login)), "@")
	count(parts) == 2
	parts[1] in allowed_domains
}

# True when the shared link would be an anonymous public URL.
shared_link_is_open if {
	lower(trim_space(object.get(args, "access", ""))) == "open"
}

# True when a shared-link call carries an `access` value that is present but not
# a string (e.g. `{"value":"open"}` or `["open"]`). trim_space/lower cannot run
# on a non-string, so without this guard `shared_link_is_open` is undefined and
# the call would pass through — a fail-open. Treat a present-but-non-string
# `access` as malformed/evasive and fail closed. A wholly absent `access` is NOT
# malformed: it still passes (Box enterprise default; see Known limitations).
shared_link_access_malformed if {
	access := object.get(args, "access", null)
	access != null
	not is_string(access)
}

# --- Allow rules --------------------------------------------------------------

# Pass through every tool that is not a Box sharing surface.
allow if {
	not is_collab_tool
	not is_shared_link_tool
}

# InfoSec break-glass: exempt callers bypass both checks.
allow if {
	is_exempt_caller
}

# Collaboration grants: allowed only when an email login is present AND its
# domain is on the corporate allowlist. Id-based/group grants and role-only
# updates carry no login, so this rule cannot fire — fail closed.
allow if {
	is_collab_tool
	login_domain_allowed(collab_login)
}

# Shared links: allowed unless the link is public (`open`). `company` and
# `collaborators` — and a missing `access` field (Box enterprise default,
# see Known limitations) — pass through.
allow if {
	is_shared_link_tool
	not shared_link_is_open
	not shared_link_access_malformed
}

# --- Deny reasons -------------------------------------------------------------

reasons contains msg if {
	is_collab_tool
	not is_exempt_caller
	login := collab_login
	not login_domain_allowed(login)
	msg := sprintf("Box collaboration with '%s' is blocked: the invitee's email domain is not on the approved corporate domain list. Invite a corporate account instead, or ask your InfoSec team to approve the domain.", [login])
}

reasons contains "This Box collaboration grant carries no invitee email login (id-based, group, or role-only grant), so the external-domain check cannot run and the request fails closed. Re-issue the grant with the invitee's email login, or ask your InfoSec team to run it." if {
	is_collab_tool
	not is_exempt_caller
	not collab_login
}

reasons contains "Public 'open' Box shared links are blocked because they mint an anonymous URL visible outside the organization. Use 'company' or 'collaborators' access instead. Contact your InfoSec team if you need a public link." if {
	is_shared_link_tool
	not is_exempt_caller
	shared_link_is_open
}

reasons contains "This Box shared-link call has a malformed 'access' value (not a string), so the public-link check cannot run and the request fails closed. Re-issue with access set to 'company' or 'collaborators'." if {
	is_shared_link_tool
	not is_exempt_caller
	shared_link_access_malformed
}

reason := joined if {
	count(reasons) > 0
	reason_list := sort([r | some r in reasons])
	joined := concat("; ", reason_list)
}
```
