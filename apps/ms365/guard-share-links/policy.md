---
name: Guard OneDrive/SharePoint Share Links
tags:
  - ms365
  - share-links
  - sharing
  - ingress
  - soc2
  - iso27001-nist
  - hipaa
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # ms365 / guard-share-links

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow with transform; two explicit deny branches
  **Package:** `ms365.ingress.guard_share_links`

  ## What it does

  Stops agents from opening OneDrive/SharePoint files to the whole internet. It guards the two Microsoft 365 sharing tools:

  1. **`*-create-drive-item-share-link`** — Microsoft Graph mints an anonymous link silently, with no notification to anyone, and the link is usable by anybody who obtains it. This policy:
     - **Transforms** `body.scope: "anonymous"` to `"organization"`, so the link only works for signed-in members of the tenant.
     - **Forces** `body.scope: "organization"` when the request carries a body but omits `scope` entirely — Graph's `createLink` default scope is `anonymous` for OneDrive personal (and SharePoint tenants can be configured with an "Anyone" default link), so relying on the tenant default would let an agent mint a public link just by not sending `scope`.
     - **Injects** `body.expirationDateTime` seven days out when the request carries a body but no expiry, so every link the agent creates ages out.
     - **Denies outright** when `body.type` is `"edit"` combined with anonymous scope — a writable anonymous link is an unattended tenant-wide write path, and silently downgrading it could mask a compromised or misbehaving agent. This deny has no group exemption.
  2. **`*-share-drive-item`** — emails sharing invitations to `recipients[]`. The policy **denies** when any recipient address is outside the corporate-domain allowlist, unless the caller is in the placeholder `collab-admins` IdP group. Recipients without a resolvable email address (objectId/alias entries, or non-string shapes) are also denied, because the domain check cannot verify them.

  All other tool calls pass through untouched.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of information outside system boundaries: anonymous links and external invitations are the two ways a drive item leaves the tenant's access-control perimeter through the agent, and both are downgraded or blocked at ingress.
  - **SOC 2 P6.1** — supports limiting disclosure of personal information to third parties: files behind anonymous links are disclosed to anyone holding the URL; forcing organization scope keeps disclosure inside the tenant.
  - **ISO 27001 A.5.14** — information-transfer control on the agent's file-sharing write path.
  - **HIPAA §164.502(b) / §164.530(c)** — supports minimum-necessary limits and
    privacy safeguards on a PHI-capable storage surface: OneDrive/SharePoint items
    can contain ePHI, so downgrading anonymous links to organization scope and
    blocking external sharing invitations keeps that content from being disclosed
    outside the covered entity through the agent.
  - **GDPR Art. 5(1)(f) / Art. 32; Arts. 44/46** — supports security of processing
    and cross-border-transfer discipline: an anonymous or externally-invited share
    link moves personal data out of the tenant's access-control perimeter, and both
    are blocked or scoped down at ingress so agent-driven personal-data egress stays
    inside approved domains.

  ## Why ingress and not egress

  Creating a share link or sending an invitation is a write with instant external effect — once Graph mints an anonymous URL or emails an invitation, the exposure exists regardless of what the caller sees in the response. Egress redaction would only hide the link from the agent, not revoke it. Ingress transform/deny is the only placement that actually prevents the exposure.

  ## Tool name matching

  Matches by suffix, case-insensitively:

  - `*-create-drive-item-share-link`
  - `*-share-drive-item`

  The DTwo gateway prefixes tool names with the configured MCP server name (observed live as `ms365-`, e.g. `ms365-create-drive-item-share-link`), and the prefix is not standardized across deployments — suffix matching keeps the policy portable. Verify the exact names your gateway sends with the dump-input debug technique before relying on this in production. The tool names themselves are verified from a live gateway deployment of `softeria/ms-365-mcp-server`.

  ## Argument shape

  Verified from live schemas of the softeria server:

  - `create-drive-item-share-link`: `driveId`, `driveItemId`, `body.type` (`view`|`edit`|`embed`), `body.scope` (`anonymous`|`organization`|`users`), `body.password`, `body.expirationDateTime`.
  - `share-drive-item`: `driveId`, `driveItemId`, and invitation `recipients[]` (each entry a Graph `driveRecipient`: `email`, or `objectId`/`alias`). The exact placement of `recipients` (top-level vs `body.recipients`) is inferred from the Graph `invite` action rather than verified from a live schema, so the policy checks **both** locations.

  All fields are read via `object.get` chains. A share-link call with **no `body` at all** passes through untransformed — there is nothing to patch, and injecting a body the caller never sent risks breaking the call shape (Graph applies tenant defaults; keep those conservative). Note the distinction from a call that carries a body but omits `scope`: that one **is** transformed (scope forced to `organization`), because relying on the tenant default there would be a silent public-link path. `scope` and `type` values are compared case-insensitively **and whitespace-trimmed**, so a padded `" anonymous "` / `" edit "` cannot slip past the downgrade or the edit deny. `expirationDateTime` is only treated as present when it is a non-empty string — an explicit `null`, a non-string value, or an empty/whitespace string all trigger expiry injection (Graph treats `null` as "no expiry", so accepting it would defeat the injected default).

  ## Examples

  ### Transformed (anonymous view link downgraded, expiry injected)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-create-drive-item-share-link", "type": "tool" },
      "payload": {
        "name": "ms365-create-drive-item-share-link",
        "args": {
          "driveId": "b!abc",
          "driveItemId": "01XYZ",
          "body": { "type": "view", "scope": "anonymous" }
        }
      }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload.body` becomes `{ "type": "view", "scope": "organization", "expirationDateTime": "<now + 7 days>" }`.

  ### Denied (anonymous edit link)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-create-drive-item-share-link", "type": "tool" },
      "payload": {
        "name": "ms365-create-drive-item-share-link",
        "args": {
          "driveId": "b!abc",
          "driveItemId": "01XYZ",
          "body": { "type": "edit", "scope": "anonymous" }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "Anonymous edit links are blocked: ..."`.

  ### Denied (external invitation, caller not in collab-admins)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-share-drive-item", "type": "tool" },
      "subject": { "sub": "user@example.com", "claims": { "groups": ["staff"] } },
      "payload": {
        "name": "ms365-share-drive-item",
        "args": {
          "driveId": "b!abc",
          "driveItemId": "01XYZ",
          "body": { "recipients": [ { "email": "partner@vendor-b.example" } ] }
        }
      }
    }
  }
  ```

  `allow = false`, `reason = "This sharing invitation includes recipients outside the corporate domain allowlist: ..."`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - A `graph-batch` deny policy — `*-graph-batch` can reach the same Graph `createLink`/`invite` endpoints directly and bypasses every per-tool rule, so close that hole with a separate ingress policy.
  - An external email egress guard on `*-send-mail` / `*-forward-mail-message` — invitations are only one of the ways content leaves the tenant by email.
  - An egress policy on `*-list-drive-item-permissions` if you also want to limit ACL reconnaissance.

  ## Known limitations

  - **Placeholders — replace at import time.** `allowed_recipient_domains` ships as `{"example.com"}` and the exemption group ships as `collab-admins`; replace both with your corporate domain(s) and your IdP's group name. Group names are placeholders — replace `collab-admins` with your IdP's group name at import time. The `groups` claim is assumed to be an array of strings; if your IdP emits a single string or a namespaced claim, adapt `is_collab_admin`.
  - **`graph-batch` bypass.** This policy only sees the two named sharing tools. `*-graph-batch` (and generic passthrough servers like Lokka's `Lokka-Microsoft`) can call the underlying Graph endpoints unmatched — pair with a passthrough-deny policy (see Composition).
  - **No-body passthrough.** A share-link call with **no `body` at all** is allowed untransformed by design (documented above); the resulting link's scope/expiry follow tenant defaults, so keep tenant-level sharing defaults conservative. This is the only remaining tenant-default path — a call that carries a body but omits `scope` is *not* passed through: `scope` is forced to `organization` (red-team fix, see the transform). A body that is present but not an object (see next item) still passes through, since the scope read is undefined.
  - **`share-drive-item` recipients shape partially inferred.** The landscape research verifies the tool name and that it emails `recipients[]`, but the exact request placement is inferred from the Graph `invite` action. Both top-level `recipients` and `body.recipients` are checked; if your server nests them elsewhere, extend `recipient_entries`.
  - **Non-standard body shapes fail open for the transform.** If `body` is not an object (e.g. a string), the scope/expiry reads are undefined, no transform or link-deny fires, and the call passes through — Graph will reject the malformed body itself. The invitation deny branch is not affected (recipients that can't be parsed as email-bearing entries are denied as unverifiable).
  - **Expiry is injected, not enforced.** Graph/tenant settings decide whether `expirationDateTime` is honored for a given link type; some tenants ignore expiry on organization-scoped links. The injected value is a defense-in-depth default, not a guarantee.
  - **Anonymous-edit deny has no group exemption** — that is deliberate; if an external edit link is genuinely required, it should be created outside the agent path with human review.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - ms365
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
package ms365.ingress.guard_share_links

# Transform-first policy: allow by default, downgrade anonymous share links to
# organization scope and inject an expiry; deny only the two explicitly
# dangerous branches (anonymous edit links, external sharing invitations).
default allow := true

# ---------------------------------------------------------------------------
# Configuration placeholders — replace at import time
# ---------------------------------------------------------------------------

# Email domains allowed to receive sharing invitations.
# PLACEHOLDER: replace "example.com" with your corporate domain(s), lowercase.
allowed_recipient_domains := {"example.com"}

# IdP group exempt from the external-invitation deny.
# PLACEHOLDER: replace with your IdP's group name.
collab_admin_group := "collab-admins"

# Injected share-link lifetime: 7 days, in nanoseconds.
seven_days_ns := ((7 * 24) * 3600) * 1000000000

# ---------------------------------------------------------------------------
# Shared accessors — every possibly-missing field is read via object.get
# ---------------------------------------------------------------------------

args := object.get(object.get(input, "payload", {}), "args", {})

# The Graph request body ({} when the call carries no body at all).
share_body := object.get(args, "body", {})

# True only when the call actually carries a body. A share-link call with no
# body passes through untransformed: there is nothing to downgrade, and Graph
# applies tenant defaults / rejects the call itself.
body_present if {
    object.get(args, "body", null) != null
}

# createLink tool — mints a share link. Gateway prefixes the server name
# (observed live as `ms365-`), so match by suffix for portability.
is_share_link_call if {
    input.action == "tool_pre_invoke"
    endswith(lower(input.resource.name), "-create-drive-item-share-link")
}

# invite tool — emails sharing invitations to recipients[].
is_share_invite_call if {
    input.action == "tool_pre_invoke"
    endswith(lower(input.resource.name), "-share-drive-item")
}

# Current scope value, lowercased and whitespace-trimmed. "" when the body omits
# scope entirely (or carries only whitespace). Trimming closes a bypass where a
# padded value like " anonymous " would otherwise evade both the downgrade and
# the anonymous-edit deny while Graph may still coerce it to the enum value.
scope_value := trim(lower(object.get(share_body, "scope", "")), " \t\n\r\f")

# Link type (view/edit/embed), lowercased and whitespace-trimmed for the same
# reason as scope_value — a padded " edit " must not slip past the edit deny.
type_value := trim(lower(object.get(share_body, "type", "")), " \t\n\r\f")

anonymous_scope if {
    scope_value == "anonymous"
}

# Scope omitted on a call that DOES carry a body. We must not rely on the
# tenant's default sharing scope: Graph's createLink default is "anonymous" for
# OneDrive personal, and SharePoint/OneDrive-for-Business tenants can be
# configured with an "Anyone" (anonymous) default link. Treating an omitted
# scope as safe would let an agent mint a public link just by not sending
# `scope`, bypassing the anonymous-scope guard entirely.
scope_omitted if {
    body_present
    scope_value == ""
}

# Expiry is treated as missing unless a non-empty string is actually present.
# A caller could otherwise defeat the injected expiry by sending
# expirationDateTime: null (Graph treats null as "no expiry"), a non-string
# value, or an empty/whitespace-only string.
missing_expiry if {
    not is_string(object.get(share_body, "expirationDateTime", ""))
}

missing_expiry if {
    exp := object.get(share_body, "expirationDateTime", "")
    is_string(exp)
    trim(exp, " \t\n\r\f") == ""
}

is_collab_admin if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    some g in object.get(claims, "groups", [])
    g == collab_admin_group
}

# ---------------------------------------------------------------------------
# Deny branch 1: anonymous EDIT links (no transform, no group exemption)
# ---------------------------------------------------------------------------

edit_anonymous_link if {
    is_share_link_call
    type_value == "edit"
    anonymous_scope
}

allow := false if {
    edit_anonymous_link
}

reasons contains "Anonymous edit links are blocked: an anonymous edit link lets anyone on the internet modify this file without signing in, and Microsoft Graph creates it silently with no notification. Request the link with organization scope instead (anonymous view links are downgraded to organization scope automatically). Contact your InfoSec team if an external edit link is genuinely required." if {
    edit_anonymous_link
}

# ---------------------------------------------------------------------------
# Transform: downgrade anonymous scope, inject a 7-day expiry when absent
# ---------------------------------------------------------------------------

default_expiry := time.format([time.now_ns() + seven_days_ns, "UTC", "2006-01-02T15:04:05Z07:00"])

body_patch["scope"] := "organization" if {
    anonymous_scope
}

# Force organization when scope is omitted so an unspecified scope can't inherit
# a public tenant default (see scope_omitted).
body_patch["scope"] := "organization" if {
    scope_omitted
}

body_patch["expirationDateTime"] := default_expiry if {
    missing_expiry
}

transform := {"transformed_payload": object.union(args, {"body": new_body})} if {
    is_share_link_call
    not edit_anonymous_link
    body_present
    count(body_patch) > 0
    new_body := object.union(share_body, body_patch)
}

# ---------------------------------------------------------------------------
# Deny branch 2: sharing invitations to external / unverifiable recipients
# ---------------------------------------------------------------------------

# Recipients may appear at the top level or under body — check both (the exact
# placement is inferred from the Graph invite action; see Known limitations).
recipient_entries contains r if {
    is_share_invite_call
    some r in object.get(args, "recipients", [])
}

recipient_entries contains r if {
    is_share_invite_call
    some r in object.get(share_body, "recipients", [])
}

# Normalize a recipient entry to a lowercase email string; "" when the entry
# carries no resolvable email (objectId/alias entries, non-string shapes).
recipient_email(r) := lower(email) if {
    is_object(r)
    email := object.get(r, "email", "")
    is_string(email)
}

recipient_email(r) := "" if {
    is_object(r)
    not is_string(object.get(r, "email", ""))
}

recipient_email(r) := lower(r) if {
    is_string(r)
}

recipient_email(r) := "" if {
    not is_object(r)
    not is_string(r)
}

# An email is allowlisted only when it has exactly one "@" and its domain is
# in the corporate allowlist — malformed addresses fail closed as external.
allowlisted_email(email) if {
    parts := split(email, "@")
    count(parts) == 2
    allowed_recipient_domains[parts[1]]
}

external_recipients contains email if {
    some r in recipient_entries
    email := recipient_email(r)
    email != ""
    not allowlisted_email(email)
}

has_unverifiable_recipient if {
    some r in recipient_entries
    recipient_email(r) == ""
}

allow := false if {
    count(external_recipients) > 0
    not is_collab_admin
}

allow := false if {
    has_unverifiable_recipient
    not is_collab_admin
}

reasons contains msg if {
    count(external_recipients) > 0
    not is_collab_admin
    msg := sprintf("This sharing invitation includes recipients outside the corporate domain allowlist: %s. Share with organization members instead, or ask a member of the %s group to send external invitations. Contact your InfoSec team if a domain should be added to the allowlist.", [concat(", ", sort([e | some e in external_recipients])), collab_admin_group])
}

reasons contains msg if {
    has_unverifiable_recipient
    not is_collab_admin
    msg := sprintf("This sharing invitation includes a recipient without an email address (such as an objectId or alias), so the corporate-domain check cannot verify it. Re-send the invitation using recipient email addresses, or ask a member of the %s group to send it.", [collab_admin_group])
}

# --- Standard reason aggregation block ---
reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
