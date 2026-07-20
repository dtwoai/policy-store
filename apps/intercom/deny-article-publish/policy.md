---
name: "Intercom: Keep Agent Help Center Articles in Draft"
tags:
  - intercom
  - deny-public-exposure
  - ingress
  - articles
  - help-center
  - publication
  - governance
  - soc2
publishedAt: 2026-07-12
description: |
  # intercom / deny-article-publish

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny an explicit publish, allow everything else
  **Package:** `intercom.ingress.deny_article_publish`

  ## What it does

  Keeps agent-authored Intercom Help Center articles in **draft** so a human
  reviews them before they go live on the public Help Center. On the two Intercom
  article-write tools — `create_article` and `update_article` — the policy
  **denies** the call when its arguments set `state == "published"`, unless the
  caller is a member of a documented content-admin IdP group.

  Every other article write passes through untouched: a write that omits `state`
  (Intercom defaults it to `draft`) or explicitly sets `state: "draft"` is
  allowed, and so is every non-article tool on the Intercom surface (search,
  fetch, conversation/contact reads, `list_articles`, `get_article`, and so on).
  This policy owns exactly one surface: the publish flag on article writes.

  `create_article` with `state: "published"` puts agent-authored HTML on the
  public Help Center immediately, and `update_article` can silently rewrite —
  and re-publish — a live public doc. These are the only externally visible,
  defacement-class actions on the Intercom MCP surface (there are no delete or
  conversation-send tools), so the publish step belongs behind human review. The
  check runs at ingress, before the call reaches the Intercom MCP server, so a
  blocked publish never touches the public Help Center.

  ## Compliance alignment

  This policy instantiates the public-exposure-deny family (PF-27,
  `deny-public-exposure`) on Intercom's article-publication surface: it forces
  agent-authored public content through a human-review gate rather than letting
  the agent broadcast it unilaterally.

  - **SOC 2 CC8.1** — supports change management by preserving the human
    authorization step for a change to public-facing content. Publishing (or
    re-publishing via `update_article`) a Help Center article is an
    agent-initiated change to live, externally visible data; this policy denies
    the publish transition so the change is authorized and approved by a
    content-admin before it is implemented, rather than being broadcast
    unilaterally by the agent.

  Beyond the SOC 2 bundle, PF-27 also maps to FINRA Rule 2210(b)(1) (principal
  pre-approval of retail communications) and EU AI Act Art. 50(4) (human-review
  marker for published AI-generated text) — both **Partial** — neither of which
  is one of the five framework bundles (`soc2`, `hipaa`, `pci-dss`, `gdpr-ccpa`,
  `sox`). This Intercom instance therefore ships with the `soc2` framework
  bundle (per the CC8.1 citation above) plus its thematic tags.

  ## Tool name matching

  The gateway prefixes tool names with the configured MCP server name (e.g.
  `intercom-create_article` or `mcp-intercom-create_article`), and that prefix is
  not standardized. The policy matches on the lowercased tool-name **suffix** so
  it stays portable across server-name conventions, and it tolerates both the
  snake_case names the official server uses and a kebab-case separator alias in
  case a community server renames them:

  - creates: `*create_article`, `*create-article`
  - updates: `*update_article`, `*update-article`

  The official Intercom snake_case names (`create_article` / `update_article`)
  are **verified** against the app landscape note (Intercom developer docs +
  Speakeasy governance catalog). The kebab-case aliases are a **defensive,
  unverified** variant — no surveyed Intercom server ships article writes in
  kebab-case today (only one community server uses kebab-case, and solely for a
  read tool), but the community naming space diverges, so both separators are
  matched. Confirm the exact name your gateway sends with the dump-input debug
  technique before relying on this in production. If a server exposes a
  differently-named article-publish tool, add its suffix to
  `article_write_suffixes` in `policy.md`.

  ## Argument shape

  Read via `object.get`, so a missing key never crashes the rule:

  - `state` (`create_article` / `update_article`) — string, `"draft"` or
    `"published"`. Read defensively with
    `object.get(input.payload.args, "state", "")` and compared case-insensitively
    with surrounding whitespace stripped. **A missing or empty `state` is treated
    as draft (allowed):** Intercom defaults an unset `state` to `draft`, so the
    deny branch fires **only** on an explicit `state == "published"`. Any value
    other than `published` (including `draft`) passes through.

  The policy does not inspect `title`, `body`, `author_id`, `parent_id`, or any
  other field — publication scope is its only concern.

  ## Identity / exemption

  The content-admin exemption reads the caller's IdP-issued `groups` claim via
  `object.get(object.get(input.subject, "claims", {}), "groups", [])`. It fails
  **closed**: a caller with no `subject`, no `claims`, or no `content-admins`
  group is **not** exempt, so an explicit publish is denied. The claim must be a
  JSON **array** of group strings — a `groups` value shaped as an object or a
  bare string is ignored (`is_array` guard), so a malformed claim cannot
  accidentally grant the exemption. Only a caller whose `groups` **array**
  contains the content-admin group may publish directly.

  ## Examples

  ### Denied (agent tries to publish an article to the public Help Center)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-create_article", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["support"] } },
      "payload": {
        "name": "intercom-create_article",
        "args": { "title": "Refund policy", "author_id": "123", "body": "<p>...</p>", "state": "published" }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Intercom write publishes an article to your public Help Center ..."`.

  ### Denied (agent republishes a live public doc via update)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-update_article", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["support"] } },
      "payload": {
        "name": "intercom-update_article",
        "args": { "id": "art_42", "body": "<p>rewritten</p>", "state": "published" }
      }
    }
  }
  ```

  `allow = false`, same reason.

  ### Allowed (agent creates or edits an article as a draft)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-create_article", "type": "tool" },
      "subject": { "sub": "google-apps|agent@acme.com", "claims": { "groups": ["support"] } },
      "payload": {
        "name": "intercom-create_article",
        "args": { "title": "Draft: onboarding", "author_id": "123", "body": "<p>...</p>", "state": "draft" }
      }
    }
  }
  ```

  `allow = true`, no reason. A write that omits `state` entirely is likewise
  allowed (Intercom defaults it to draft).

  ### Allowed (content-admin publishes directly)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-create_article", "type": "tool" },
      "subject": { "sub": "google-apps|kb-lead@acme.com", "claims": { "groups": ["content-admins"] } },
      "payload": {
        "name": "intercom-create_article",
        "args": { "title": "Launch announcement", "author_id": "9", "body": "<p>...</p>", "state": "published" }
      }
    }
  }
  ```

  `allow = true`, no reason (content-admins keep full control).

  ## Composition

  Single-purpose by design. Useful companions on the Intercom surface:

  - An **egress PII/PAN redaction** policy (PF-01 / PF-02) on `*get_conversation`,
    `*search`, `*fetch`, and `*search_conversations` responses — conversations are
    raw customer free-text and are the dominant Intercom egress risk.
  - An **ingress contact-enumeration deny** (PF-08 / PF-23) on `*search_contacts`
    and `*search` with `object_type: "contacts"` to stop email-domain sweeps of
    the customer base.

  ## Known limitations

  - **Out-of-MCP writes are neither blocked nor visible.** This policy governs
    only the MCP path. An article created, edited, or published through the
    Intercom inbox/web UI, the Intercom REST API, or Fin's own actions is outside
    the gateway's reach — such writes are **not** blocked by this policy and do
    **not** appear in the DTwo audit pipeline. Treat this as an agent-channel
    control, not a complete Help Center publication gate.
  - **Group names are placeholders — replace `content-admins` with your IdP's
    group name at import time.** The exemption is only as trustworthy as the
    `groups` claim your IdP issues; if callers can self-assert group membership,
    remap it to a claim your IdP controls. `is_admin`, `teams`, and the nested
    `user` claim are stripped before policies see them and must not be used here.
    Community Intercom servers authenticate with a workspace-level access token
    and assert no per-user identity, so `subject.claims`-based gating only works
    when the gateway sits in front of an IdP-authenticated path.
  - **Publish detection is `state`-only, exact key, string value.** The deny
    fires on the string `state == "published"` read from the exact,
    case-sensitive argument key `state`. Three inputs therefore read the empty
    default and **pass through (allowed)**: (a) the publish flag under a
    case-variant or renamed key (`State`, `STATE`, or a future boolean
    `published: true` / separate publish tool); (b) a non-string `state` value
    (e.g. `true` or `["published"]`), on which the case-fold errors out and the
    check treats the write as a draft; (c) a missing `state` (see next bullet).
    None of these is an exploitable publish bypass against the **verified**
    official Intercom server, whose `create_article`/`update_article` contract
    takes `state` as a case-sensitive string enum (`"draft"`/`"published"`) — a
    wrong-case key or non-string value is not a valid publish there either, so
    such a call lands as a draft on both the policy side and the server side. The
    residual risk is a **non-conforming connector** that is case-insensitive on
    argument keys or coerces non-string values to `"published"`; if you deploy one,
    add the alternate key/value handling to `is_publish`. Regression tests pin the
    current pass-through behavior for the wrong-case key and non-string value so
    the decision stays conscious.
  - **The draft default is an assumption, not verified in the landscape note.**
    The allow-missing-`state` branch is safe **only if** Intercom defaults an
    unset `state` to `draft`. That is Intercom's documented Articles-API
    behavior, but the app landscape note lists `state ("draft"|"published")`
    without stating the default, so treat this as an **unverified** load-bearing
    assumption: if the connector you front actually defaults an omitted `state`
    to `published`, the missing-`state` branch becomes a fail-open publish and you
    must change it to deny when `state` is absent. Confirm your connector's
    default with the dump-input debug technique before relying on the
    allow-missing-`state` behavior.
  - **Suffix match only, kebab alias unverified.** Only tool names ending in
    `create_article` / `update_article` (either separator) match. A future tool
    whose name ends differently (e.g. camelCase `createArticle`, or
    `publish_article`) is not covered — add its suffix. The kebab-case aliases
    (`create-article` / `update-article`) are matched defensively but are not
    verified against any shipping server.
  - **No content inspection.** This policy governs publication scope
    (draft vs published), not what the article body contains. Pair it with a
    body-content policy if agent-authored HTML must also be scanned before a
    content-admin publishes it.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - intercom
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package intercom.ingress.deny_article_publish

# Deny-by-default: only the explicit allow rules below permit a request. Every
# tool that is not an Intercom article write passes through; an article write is
# denied only when it sets state:"published" and the caller is not in the
# content-admin group. All other article writes (missing state, or state:"draft")
# are allowed.
default allow := false

# -----------------------------------------------------------------------------
# TOOL MATCHING. The gateway prefixes tool names with the configured MCP server
# name, which is not standardized, so we match on the lowercased suffix to stay
# portable. Both write tools are covered, and each is matched in snake_case (the
# verified official spelling) and kebab-case (a defensive, unverified separator
# alias) so a community server that renames them is still caught.
# -----------------------------------------------------------------------------
article_write_suffixes := {
    "create_article",
    "create-article",
    "update_article",
    "update-article",
}

tool_name := lower(input.resource.name)

is_article_write if {
    some suffix in article_write_suffixes
    endswith(tool_name, suffix)
}

# -----------------------------------------------------------------------------
# CONTENT-ADMIN EXEMPTION. Members of this IdP group may publish articles
# directly. Placeholder — remap `content-admins` to your IdP's group name at
# import time. Fail closed: a missing subject / claims / groups yields no
# exemption, so an explicit publish is denied.
# -----------------------------------------------------------------------------
content_admin_group := "content-admins"

caller_is_content_admin if {
    subject := object.get(input, "subject", {})
    groups := object.get(object.get(subject, "claims", {}), "groups", [])
    # Only an array of group strings grants the exemption. Without this guard a
    # malformed object-shaped claim (e.g. {"x":"content-admins"}) would exempt,
    # because `some g in <object>` iterates the object's VALUES — an accidental
    # fail-open. A bare-string or object `groups` is now ignored (fails closed),
    # matching the documented "no group → not exempt" contract.
    is_array(groups)
    some g in groups
    lower(g) == content_admin_group
}

# Tool arguments, null-safe: missing payload or args yields {}.
args := object.get(object.get(input, "payload", {}), "args", {})

# The publish flag, read defensively. Intercom defaults an unset state to
# "draft", so a missing or empty value is treated as draft (allowed). Compared
# case-insensitively with surrounding whitespace stripped so a padded value like
# " Published " cannot slip past the check. The deny fires only on an explicit
# publish.
is_publish if {
    state := trim_space(lower(object.get(args, "state", "")))
    state == "published"
}

# -----------------------------------------------------------------------------
# ALLOW: everything that isn't an article write, plus article writes that are
# not an explicit publish, plus explicit publishes by a content-admin caller.
# -----------------------------------------------------------------------------
allow if {
    not is_article_write
}

allow if {
    is_article_write
    not is_publish
}

allow if {
    is_article_write
    is_publish
    caller_is_content_admin
}

# The only deny path: an explicit publish by a non-content-admin caller.
reasons contains "This Intercom write publishes an article to your public Help Center (state: \"published\"), putting agent-authored content live and externally visible immediately. Agent-initiated publishing is blocked. Create or update the article as a draft instead (omit state, or set state to \"draft\") and ask a member of the content-admin team to review and publish it. Contact your admin if you believe this is a false positive." if {
    is_article_write
    is_publish
    not caller_is_content_admin
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
