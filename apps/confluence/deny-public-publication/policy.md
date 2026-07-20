---
name: "Confluence: Deny Org-Wide & Public Publication"
tags:
  - confluence
  - atlassian
  - deny-public-exposure
  - publication
  - governance
  - ingress
  - finserv-comms
  - eu-ai-act
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # confluence / deny-public-publication

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on org-wide / public publications, allow everything else
  **Package:** `confluence.ingress.deny_public_publication`

  ## What it does

  Stops a prompt-injected or erring agent from broadcasting Confluence content
  org-wide or to anonymous external readers. On the two Confluence page
  create/update tools (`createConfluencePage` / `updateConfluencePage`, and the
  community `confluence_create_page` / `confluence_update_page`), the policy
  **denies** a write when either:

  - `contentType: "blog"` — a blog post broadcasts to the entire organization; or
  - `spaceId` (official) / `space_id` (community) is on a configured
    public / anonymous-access space list — a write there publishes
    externally-visible content instantly.

  Members of a placeholder `comms` group are exempt from the deny (they are the
  humans authorized to broadcast).

  On **creates** by callers outside the `comms` group, the policy additionally
  applies an ingress **transform** that forces `status: "draft"` (instead of
  `"current"`) and `isPrivate: true`, so the agent stakes out a draft and a human
  publishes it deliberately rather than the page going live the instant the agent
  calls the tool. Updates are never transformed (they operate on content a human
  already created), and comms-group callers keep full control.

  Every other Confluence tool — reads, searches, comment and label writes,
  attachment uploads, deletions — passes through untouched. This policy owns one
  surface: publication scope on page create/update.

  ## Compliance alignment

  This policy instantiates the public-exposure-deny family (PF-27,
  `deny-public-exposure`) on Confluence's publication surface, and supports
  alignment with:

  - **SOC 2 CC6.6, CC6.7** — boundary protection and restriction on the
    transmission/movement of information: denying agent-initiated org-wide blogs
    and public / anonymous-access-space writes keeps content from moving to a
    broad or external audience over the MCP path, and forcing agent creates to
    `draft` + `isPrivate` holds new content inside the boundary until a human
    publishes it. **CC6.3** — role-based restriction: only the placeholder
    `comms` group may broadcast, so publication authority is scoped to a role.
  - **FINRA Rule 2210(b)(1)** — principal pre-approval of retail communications
    (Partial in the coverage matrix). By blocking agent-initiated org-wide blogs
    and public-space writes, and forcing agent creates to draft, the agent cannot
    unilaterally push content to a broad or external audience — a human in the
    comms group reviews and publishes, which is the pre-approval gate the rule
    contemplates on the MCP path.
  - **EU AI Act Art. 50(4)** — disclosure / human-review marker for
    AI-generated-or-manipulated published text (Partial; PF-27 supplies the
    human-review marker). Forcing agent-authored creates to `draft` inserts a
    human review point before AI-produced text is published, and denying
    instant org-wide / public publication keeps un-reviewed AI text off broadly
    disseminated channels.
  - **GDPR Art. 5(1)(f) / Art. 32(1)(b), 32(2)** — integrity & confidentiality
    / security of processing: denying agent-initiated org-wide blogs and
    public / anonymous-access-space writes, and forcing agent creates to a
    private draft, is a technical measure against the accidental or unlawful
    disclosure of personal data that may sit in a page body to a broad or
    external audience over the MCP path. **CCPA/CPRA §1798.121** — supports
    limiting disclosure of sensitive personal information by keeping
    agent-authored content off public / org-wide channels until a human
    publishes it.

  **Why no `hipaa` / `pci-dss` / `sox` bundle tag.** This policy governs
  publication *scope* (blog vs page, public vs internal space, draft vs
  current), not content — it does not process PHI, cardholder, or
  financial-record data — so those three framework bundles do not apply. It is
  tagged `soc2` because denying org-wide / public broadcast is a genuine SOC 2
  boundary / information-movement control (CC6.6 / CC6.7), and `gdpr-ccpa`
  because that same broadcast denial is an Art. 5(1)(f) / Art. 32 measure
  against unauthorised disclosure of personal data (both cited above). The
  coverage matrix additionally maps PF-27 to FINRA 2210(b)(1) and EU AI Act
  50(4), tracked via the `finserv-comms` / `eu-ai-act` tags.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `atlassian-createconfluencepage` or `mcp-atlassian-confluence_create_page`),
  and that prefix is not standardized. The policy matches on the lowercased
  tool-name **suffix** so it stays portable across server-name conventions:

  - creates: `*createconfluencepage`, `*confluence_create_page`
  - updates: `*updateconfluencepage`, `*confluence_update_page`

  The official Rovo names (`createConfluencePage` / `updateConfluencePage`) are
  verified in the app landscape note; the community sooperset names
  (`confluence_create_page` / `confluence_update_page`) are verified as tool
  names, but their per-field argument schemas are **not** independently verified
  (see Known limitations). Confirm the exact name your gateway sends with the
  dump-input debug technique before relying on this in production. If your server
  exposes a differently-named publish tool, add its suffix to
  `create_tool_suffixes` / `update_tool_suffixes` in `policy.md`.

  ## Argument shape

  Read via `object.get`, so a missing key never crashes the rule:

  - `contentType` (official) with a `content_type` fallback (community
    snake_case) — string; a value of `"blog"` (case-insensitive, surrounding
    whitespace stripped) triggers the org-wide-broadcast deny. `contentType` is
    verified on the official connector; `content_type` is the community
    naming-convention fallback (its schema is unverified — see Known
    limitations).
  - `spaceId` (official) with a `space_id` fallback (community) — string; matched
    against the `public_space_ids` set.
  - `status` / `isPrivate` — set by the create transform. `status` defaults to
    `"current"` on the official server (instant publish); the transform forces
    `"draft"`. `isPrivate` is a create-only flag on the official server.

  ## Identity / exemption

  The `comms` exemption reads the caller's IdP-issued `groups` claim via
  `object.get(object.get(input.subject, "claims", {}), "groups", [])`. It fails
  closed: a caller with no `subject`, no `claims`, or no `comms` group is **not**
  exempt, so the blog/public-space write is denied and the create transform
  applies.

  ## Examples

  ### Denied (agent tries to publish an org-wide blog)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createconfluencepage", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "atlassian-createconfluencepage",
        "args": { "spaceId": "TEAM123", "title": "Q3 launch", "contentType": "blog", "body": "..." }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Confluence write publishes a blog post, ..."`.

  ### Denied (write into a public / anonymous-access space)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-updateconfluencepage", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "atlassian-updateconfluencepage",
        "args": { "spaceId": "PUBLIC-SPACE-ID", "pageId": "123", "title": "Notice", "body": "..." }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Confluence write targets a public or anonymous-access space, ..."`.

  ### Allowed + transformed (agent creates an ordinary page)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createconfluencepage", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "atlassian-createconfluencepage",
        "args": { "spaceId": "TEAM123", "title": "Runbook", "contentType": "page", "body": "..." }
      }
    }
  }
  ```

  `allow = true`; the call is rewritten so `args.status = "draft"` and
  `args.isPrivate = true`. A human publishes the draft.

  ### Allowed (comms-group member publishes a blog)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-createconfluencepage", "type": "tool" },
      "subject": { "sub": "google-apps|comms-lead@acme.com", "claims": { "groups": ["comms"] } },
      "payload": {
        "name": "atlassian-createconfluencepage",
        "args": { "spaceId": "NEWS", "title": "All-hands recap", "contentType": "blog", "body": "..." }
      }
    }
  }
  ```

  `allow = true`, no reason, no transform (comms keeps full control).

  ## Composition

  Single-purpose by design. Useful companions in the
  [`atlassian`](../../../bundles/atlassian/README.md) bundle:

  - [`confluence/freeze-page-deletion`](../freeze-page-deletion/policy.md) —
    freezes the irreversible Confluence deletion tools.
  - [`confluence/block-secrets`](../block-secrets/policy.md) — keeps credentials
    out of page bodies.
  - A companion Jira policy denying `*transitionjiraissue` calls that carry
    `historyMetadata` (change-history actor spoofing) — the other half of the
    PF-27 publication/audit-integrity story on the Atlassian suite.

  ## Known limitations

  - **Group names are placeholders — replace `comms` with your IdP's group name
    at import time.** The exemption is only as trustworthy as the `groups` claim
    your IdP issues; if callers can self-assert group membership, remap it to a
    claim your IdP controls. `is_admin`, `teams`, and the nested `user` claim are
    stripped before policies see them and must not be used here.
  - **Public-space list is a placeholder.** `public_space_ids`
    (`PUBLIC-SPACE-ID`, `ANONYMOUS-SPACE-ID`) must be remapped to your tenant's
    actual public / anonymous-access space identifiers at import time. A space
    not on the list is treated as internal; the policy has no way to discover a
    space's anonymous-access setting from the request alone.
  - **Community argument schema unverified.** The community
    `confluence_create_page` / `confluence_update_page` tool names are verified,
    but their per-field shapes are not independently verified. To defend the
    community surface the policy reads both spellings of the two fields that
    gate a deny: the blog check reads `contentType` **and** the community
    snake_case `content_type`, and the space check reads `spaceId` **and**
    `space_id`. If the community server names one of these something else again
    (or does not expose a blog content type at all), that specific check reads
    its default and fails open for that field — the tool still matches, but a
    blog may not be recognized as such. The injected `status` / `isPrivate`
    transform keys are camelCase only and may be ignored (or need to be
    `is_private`) on the community server; the transform is a best-effort nudge,
    not a deny, so a silently-ignored key does not widen the hard-denied blog /
    public-space surface. Verify the community schema before relying on it there.
  - **Suffix match only.** A future tool whose name ends differently (e.g.
    `createconfluenceblogpost`) is not covered — add its suffix. The policy does
    not fire on names where the verb is embedded mid-string.
  - **Draft-forcing is a create-time nudge, not an enforced human gate (for
    internal pages).** The transform forces agent *creates* to `draft` +
    `isPrivate`, but ordinary updates to internal (non-blog, non-public) pages
    pass through untouched. So a non-comms agent can create a page as a forced
    draft and then, in a follow-up `*updateconfluencepage` call, set
    `status: "current"` to publish it itself — no human in the loop for
    internal-space content. This is deliberate (blocking status flips on updates
    would break the legitimate "human already drafted, agent edits" flow), and it
    does **not** widen the org-wide *blog* surface: blog creates *and updates* are
    hard-denied regardless of the create-then-update sequence (because
    `contentType` travels in both requests), and creates into a public space are
    hard-denied. Updates to a page that *already resides* in a public space are a
    separate, documented gap — see the public-space-on-update limitation below. If
    you need a true human gate on internal publication too, pair this with a
    `require-human-approval`-style update policy.
  - **Public-space enforcement is reliable on creates, best-effort on updates.**
    The official `updateConfluencePage` / community `confluence_update_page`
    identify the target page by `pageId` / `page_id`; the page's space is **not**
    part of an update request (only creates carry `spaceId` — `isPrivate` is
    likewise create-only). So a non-comms agent editing a page that *already*
    lives in a public / anonymous-access space sends no `spaceId`,
    `is_public_space` reads its empty default, and the update passes through
    (un-transformed, since updates are never draft-forced). Creates are
    unaffected: `spaceId` is required on create, so a create *into* a public space
    is hard-denied. Blog edits are also still caught on update, because
    `contentType` travels in the request — only the space dimension is missing on
    updates. If you must stop edits to already-public pages over MCP, pair this
    with a page-ID allow/deny-list policy or otherwise freeze updates to public
    spaces. (The two "public-space update" examples above deny only because the
    caller happens to pass `spaceId`; a realistic pageId-only update would not.)
  - **Sibling community write tools are not publication-scope-checked.** On the
    community server, `confluence_move_page` (relocates an existing page —
    potentially *into* a public / anonymous-access space) and
    `confluence_update_page_section` are not matched by this policy, so a
    non-comms agent could expose a page publicly by moving it rather than by
    creating/updating it. `move_page`'s destination-space argument key is not
    verified in the landscape note, so a reliable public-space check cannot be
    built from the request alone; treat move/section as out of scope here and, on
    community deployments, freeze or group-gate them with a companion policy.
  - **Public-space list is matched exactly and by type.** `public_space_ids`
    membership is an exact string comparison: a `spaceId` sent by the tool as a
    JSON number will not equal a string-configured ID (and vice-versa). Configure
    the list with values that match the exact type and format your server emits
    on the wire (confirm with the dump-input debug technique).
  - **Body/link content not inspected.** This policy governs *publication scope*
    (blog vs page, public vs internal space, draft vs current), not what the body
    contains. Pair it with `block-secrets` and an egress PII policy for content
    control.
  - **Other paths are out of reach.** This covers only the MCP channel. A user
    publishing a blog or public page via the Confluence web UI or REST API is
    outside the gateway's scope by design.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - confluence
industries: []
bundles:
  - atlassian
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package confluence.ingress.deny_public_publication

# Deny-by-default: only the explicit allow rules below permit a request. Every
# tool that is not a Confluence page create/update passes through; create/update
# calls are denied when they would broadcast org-wide (a blog) or publish into a
# public / anonymous-access space, unless the caller is in the comms group.
default allow := false

# -----------------------------------------------------------------------------
# TOOL MATCHING. The gateway prefixes tool names with the configured MCP server
# name, which is not standardized, so we match on the lowercased suffix to stay
# portable. Official Rovo names (createConfluencePage / updateConfluencePage) and
# community sooperset names (confluence_create_page / confluence_update_page) are
# both covered. Verify the exact name your gateway sends with the dump-input
# debug technique before relying on this in production.
# -----------------------------------------------------------------------------
create_tool_suffixes := {
    "createconfluencepage",
    "confluence_create_page",
}

update_tool_suffixes := {
    "updateconfluencepage",
    "confluence_update_page",
}

tool_name := lower(input.resource.name)

is_create_tool if {
    some suffix in create_tool_suffixes
    endswith(tool_name, suffix)
}

is_update_tool if {
    some suffix in update_tool_suffixes
    endswith(tool_name, suffix)
}

is_publish_tool if {
    is_create_tool
}

is_publish_tool if {
    is_update_tool
}

# -----------------------------------------------------------------------------
# PUBLIC / ANONYMOUS-ACCESS SPACES. Placeholder spaceIds — remap to your tenant's
# public / anonymous-access space identifiers at import time. A write into any of
# these publishes externally-visible content.
# -----------------------------------------------------------------------------
public_space_ids := {
    "PUBLIC-SPACE-ID",
    "ANONYMOUS-SPACE-ID",
}

# -----------------------------------------------------------------------------
# COMMS EXEMPTION. Members of this IdP group may publish blogs and to public
# spaces, and are not subject to the draft-forcing transform. Placeholder — remap
# `comms` to your IdP's group name at import time. Fail closed: a missing
# subject / claims / groups yields no exemption.
# -----------------------------------------------------------------------------
comms_group := "comms"

# Tool arguments, null-safe: missing payload or args yields {}.
args := object.get(object.get(input, "payload", {}), "args", {})

caller_in_comms if {
    subject := object.get(input, "subject", {})
    groups := object.get(object.get(subject, "claims", {}), "groups", [])
    some g in groups
    lower(g) == comms_group
}

# A blog broadcasts to the whole organization (contentType: "blog"). Read the
# official camelCase `contentType` key, falling back to the community snake_case
# `content_type` key, so a blog posted through the community server is caught too
# (its other args — space_id, page_id — are snake_case, so contentType would be
# as well). Compared case-insensitively and with surrounding whitespace stripped,
# so a padded value like " blog\n" cannot slip past the check if the server would
# still coerce it.
is_blog if {
    ct := object.get(args, "contentType", object.get(args, "content_type", ""))
    trim_space(lower(ct)) == "blog"
}

# The write targets a public / anonymous-access space. Read the official
# `spaceId` key, falling back to the community `space_id` key.
is_public_space if {
    sid := object.get(args, "spaceId", object.get(args, "space_id", ""))
    public_space_ids[sid]
}

# -----------------------------------------------------------------------------
# ALLOW: everything that isn't a publish tool, plus publish calls that are
# neither a blog nor a public-space write (or are made by a comms-group caller).
# -----------------------------------------------------------------------------
allow if {
    not is_publish_tool
}

allow if {
    is_publish_tool
    not is_blocked
}

# A publish is blocked when a non-comms caller broadcasts a blog...
is_blocked if {
    is_publish_tool
    not caller_in_comms
    is_blog
}

# ...or writes into a public / anonymous-access space.
is_blocked if {
    is_publish_tool
    not caller_in_comms
    is_public_space
}

reasons contains "This Confluence write publishes a blog post, which broadcasts to your whole organization. Agent-initiated blog posts are blocked. Post it as a regular page in a team space instead, or ask a member of the comms team to publish it. Contact your admin if you believe this is a false positive." if {
    is_publish_tool
    not caller_in_comms
    is_blog
}

reasons contains "This Confluence write targets a public or anonymous-access space, which would publish externally visible content. Agent-initiated writes to public spaces are blocked. Move the content to an internal space, or ask a member of the comms team to publish it. Contact your admin if this space should not be treated as public." if {
    is_publish_tool
    not caller_in_comms
    is_public_space
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}

# -----------------------------------------------------------------------------
# TRANSFORM: on page CREATES by non-comms callers, force the page to draft and
# private so a human publishes it deliberately (instead of status:"current"
# going live immediately). Applies only to allowed creates — the gateway ignores
# the transform on a denied request. Comms-group callers keep full control, and
# updates are never rewritten.
# -----------------------------------------------------------------------------
transform := {"transformed_payload": merged} if {
    is_create_tool
    not caller_in_comms
    merged := object.union(args, {"status": "draft", "isPrivate": true})
}
```
