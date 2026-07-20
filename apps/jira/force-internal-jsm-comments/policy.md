---
name: Force Internal Visibility on JSM Comments
tags:
  - jira
  - force-internal-comments
  - comments
  - jsm
  - service-management
  - ingress
  - soc2
  - atlassian
publishedAt: 2026-07-12
description: |
  # jira / force-internal-jsm-comments

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow with transform (transform-only, no deny branch)
  **Package:** `jira.ingress.force_internal_jsm_comments`

  ## What it does

  Keeps agent-drafted Jira Service Management (JSM) comments off the customer-facing portal by
  rewriting `addCommentToJiraIssue` calls to carry a restrictive `commentVisibility` before they
  reach the Atlassian MCP server.

  In JSM, a comment added through `addCommentToJiraIssue` **without** a `commentVisibility` object is
  a *public reply* — it lands on the customer portal and is emailed to the reporter/request
  participants. Supplying `commentVisibility: {type, value}` scopes the comment to an internal role
  or group, so it appears only to fulfillers and never on the portal. Because the field defaults to
  *unset → portal-visible*, an agent that omits it (or is prompt-injected into omitting it) silently
  discloses internal notes to the customer.

  This policy:

  - **Transforms** `addCommentToJiraIssue` to inject `commentVisibility: {type: "role", value: "Service Desk Team"}`
    when **all** of these hold: the `issueIdOrKey` belongs to a configured JSM project (its key prefix
    is in the placeholder set `SUP` / `HELP` / `ITSM`), the caller is **not** in the placeholder
    `support-agents` IdP group, and the call does **not** already carry a restrictive
    `commentVisibility`.
  - **Passes through unmodified** any call that already carries a restrictive `commentVisibility`
    (`type` is `role` or `group` with a non-empty `value` that does not name a customer-facing
    audience such as the default JSM `Service Desk Customers` role) — the caller has already scoped
    the comment to an internal audience, so there is nothing to fix and its choice is preserved.
  - **Passes through unmodified** callers who *are* in the `support-agents` group — they are expected
    to post customer-facing replies as part of their job.
  - **Passes through unmodified** comments on non-JSM projects, and every tool other than
    `addCommentToJiraIssue`.

  The check runs at ingress, before the call reaches the Atlassian MCP server, so a would-be
  portal-visible comment is scoped internal before it is ever written. This is a *visibility* control
  only — it never denies the comment, it only changes who can see it. This is the Jira-specific
  instantiation of `force-internal-comments` (PF-26): it prevents accidental **external disclosure**
  of internal notes, as distinct from *masking* the notes on the way back out (egress
  `redact-sensitive-info`) or *blocking* the write outright (a write-fence / `role-gate-writes`).

  ## Compliance alignment

  Forcing internal visibility keeps agent-authored internal notes — which routinely contain another
  customer's PII, internal risk assessments, or credentials pasted into a ticket — from being
  disclosed to the external requester on the customer portal.

  - **SOC 2 CC6.7** (*Restrict transmission/movement/removal of information* — coverage E) — supports
    alignment by preventing internal note text from being transmitted to an external (customer-portal)
    audience over the agent channel.
  - **SOC 2 P6.1** (*PI disclosure to third parties* — coverage P) — supports alignment by confining
    comment text to an internal role rather than disclosing it to the requester, who for a JSM ticket
    is a third party relative to the internal note.
  - **HIPAA §164.502(b) / §164.514(d)** (*Minimum necessary; role-based limits* — coverage E) —
    supports alignment: an agent-drafted internal note on a JSM (service-desk) ticket that may carry
    PHI is scoped to internal fulfillers rather than disclosed to the external requester on the
    customer portal. **§164.530(c)** (*Privacy safeguards* — coverage P) — supports alignment by
    removing an incidental-disclosure path that would otherwise push internal PHI-bearing notes to
    the portal.
  - **GDPR Art. 5(1)(f) / Art. 32** (*Security / confidentiality of processing* — coverage P) —
    supports alignment: an internal note that may contain personal data is scoped to authorised
    fulfillers instead of being exposed to the data subject or unrelated portal viewers.
  - **CCPA/CPRA §1798.150** (*Nonredacted-PI breach-exposure reduction* — coverage P) — supports
    alignment by reducing the surface on which unredacted personal information in an internal note can
    be disclosed externally.

  These SOC 2, HIPAA, and GDPR/CCPA rows list families such as PF-02/PF-04/PF-05/PF-01/PF-08/PF-23 in
  the coverage matrix; this policy contributes to the same controls by the disclosure-prevention
  effect of PF-26, not by being named in those rows. The `atlassian` tag is the thematic app bundle.

  ## Why ingress and not egress

  Posting a comment is a write with an immediate, externally visible side effect — once
  `addCommentToJiraIssue` reaches JSM without a restrictive `commentVisibility`, the text is on the
  customer portal and may already have been emailed to request participants. Egress redaction would
  only mask the *response* the agent sees, not the portal entry itself. Injecting `commentVisibility`
  at ingress, before the call executes, is the only placement that actually keeps the text off the
  portal.

  ## Tool name matching

  Matches by suffix, case-insensitively:

  - `*addcommenttojiraissue`

  `addCommentToJiraIssue` is the verified official Atlassian Rovo / Claude-connector tool name
  (camelCase canonical; the Claude connector surfaces it lowercased as
  `atlassian-addcommenttojiraissue`). The DTwo gateway prefixes tool names with the configured MCP
  server name, and that prefix is not standardized across deployments, so suffix matching keeps the
  policy portable. Verify the exact name your gateway sends with the dump-input debug technique before
  relying on this in production.

  The suffix is tested against **both** `input.resource.name` (the canonical PARC field) **and** the
  legacy `input.payload.name` alias, each read through an `object.get` chain. Both are populated on
  tool hooks and carry the same value, so the second branch is defense-in-depth: a call that arrived
  with an absent/empty `resource.name` still matches via `payload.name` rather than passing the
  comment through portal-visible (a fail-open leak on this visibility control), and reading both via
  `object.get` means a missing `resource` object cannot error the rule.

  The community `sooperset/mcp-atlassian` server exposes a differently-named, differently-shaped
  `jira_add_comment` tool whose JSM-visibility argument is not verified in the landscape note; per the
  no-invented-tool-names rule this policy does **not** add a speculative suffix for it (see Known
  limitations).

  ## Argument shape

  Verified from the live official-connector schema for `addCommentToJiraIssue`:

  - `issueIdOrKey` (req) — e.g. `SUP-123` (or a bare numeric issue ID).
  - `commentBody` (req) — markdown/ADF.
  - `commentId` (opt) — when present, edits an existing comment.
  - `commentVisibility` (opt) — `{type: "group" | "role", value: <string>}`. **Absent → the comment is
    a public/portal-visible reply.**

  All fields are read via `object.get` chains. The JSM decision keys on the **project prefix** of
  `issueIdOrKey` (the substring before the first `-`, upper-cased) — the value is `trim_space`d first
  so leading/trailing whitespace, tabs, or newlines can't push the prefix out of the JSM key set. A
  `commentVisibility` counts as *restrictive* only when it is an object with **exactly** the keys
  `{type, value}` (an extra key such as the Jira REST `identifier` field disqualifies it — it could
  re-address the audience by ID while `value` looks internal), whose `type` is `role` or `group`
  **and** whose `value` is a `trim_space`-non-empty string that does **not** (lower-cased, trimmed)
  name a customer-facing audience in the placeholder set `{"service desk customers"}`; anything
  else (absent, empty, whitespace-only, malformed, an unrecognised `type`, an extra key, or a
  customer-facing value) is treated as unrestricted and rewritten. The rewrite **replaces the
  caller's `commentVisibility` wholesale**: the existing key is removed from `args` before
  `object.union` injects the internal default, so extra caller-supplied keys inside it (e.g. the
  Jira REST `identifier` field, which can re-address the audience by ID) cannot survive the
  rewrite. `commentBody`, `issueIdOrKey`, `commentId`, and every other supplied field are preserved.

  ## Examples

  ### Transformed (non-support-agent, JSM project, no visibility set)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-addcommenttojiraissue", "type": "tool" },
      "subject": { "sub": "agent@example.com", "claims": { "groups": ["staff"] } },
      "payload": {
        "name": "atlassian-addcommenttojiraissue",
        "args": { "issueIdOrKey": "SUP-123", "commentBody": "Escalating to tier 2 internally." }
      }
    }
  }
  ```

  `allow = true`; `transform.transformed_payload` becomes
  `{ "issueIdOrKey": "SUP-123", "commentBody": "Escalating to tier 2 internally.", "commentVisibility": { "type": "role", "value": "Service Desk Team" } }`.

  ### Passed through (caller already scoped the comment internal)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-addcommenttojiraissue", "type": "tool" },
      "subject": { "sub": "agent@example.com", "claims": { "groups": ["staff"] } },
      "payload": {
        "name": "atlassian-addcommenttojiraissue",
        "args": {
          "issueIdOrKey": "SUP-123",
          "commentBody": "internal",
          "commentVisibility": { "type": "group", "value": "jira-administrators" }
        }
      }
    }
  }
  ```

  `allow = true`, no transform — the caller's existing restriction is preserved.

  ### Passed through (support-agent caller)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-addcommenttojiraissue", "type": "tool" },
      "subject": { "sub": "desk@example.com", "claims": { "groups": ["support-agents"] } },
      "payload": {
        "name": "atlassian-addcommenttojiraissue",
        "args": { "issueIdOrKey": "SUP-123", "commentBody": "Your ticket is resolved." }
      }
    }
  }
  ```

  `allow = true`, no transform — a support agent may post a portal-visible reply.

  ### Passed through (non-JSM project)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "atlassian-addcommenttojiraissue", "type": "tool" },
      "subject": { "sub": "agent@example.com", "claims": { "groups": ["staff"] } },
      "payload": {
        "name": "atlassian-addcommenttojiraissue",
        "args": { "issueIdOrKey": "ENG-45", "commentBody": "note on the dev ticket" }
      }
    }
  }
  ```

  `allow = true`, no transform — `ENG` is not a configured JSM project, so ordinary Jira comments are
  untouched.

  ## Composition

  This policy is single-purpose — it controls comment **visibility** only, not whether the caller may
  comment at all. Useful companions:

  - **`role-gate-writes`** (PF-12) — decides whether the caller may call `addCommentToJiraIssue` (or
    any write) in the first place. This policy composes cleanly on top: role-gate-writes admits the
    write, force-internal-jsm-comments confines its visibility.
  - **`redact-sensitive-info`** (egress) — masks PII/secrets when comments are *read back*; the
    complementary egress leg to this ingress visibility control.
  - **`deny-write-sensitive-projects`** — if agents should not write to certain JSM projects at all.

  ## Known limitations

  - **Placeholders — replace at import time.** The JSM key set ships as `SUP` / `HELP` / `ITSM` and
    the exemption group as `support-agents`. Replace both with your own project keys and IdP group
    name at import time. Group names are placeholders — replace `support-agents` with your IdP's group
    name at import time. The injected `value` `"Service Desk Team"` is the default JSM Service Desk
    Team project role name; if your project uses a different role/group for internal comments, change
    `internal_visibility` accordingly.
  - **`groups` claim shape.** The `groups` claim is assumed to be an array of strings. A caller with
    no `groups` claim (or no `subject` at all) is treated as **not** a support agent and is rewritten —
    the exemption fails closed toward the internal-only posture. If your IdP emits a single string or a
    namespaced claim, adapt `is_support_agent`.
  - **Numeric issue IDs bypass the JSM match — documented residual.** A comment can be addressed by
    the numeric issue ID (e.g. `issueIdOrKey: "10023"`, or the same value sent as a JSON number)
    instead of the project key. The project of a numeric ID cannot be determined without an API call,
    so such a call does not match any configured JSM key prefix and passes through untouched. An agent
    (or injection) that uses the numeric ID can therefore post a portal-visible comment on a JSM issue.
    To close this, pair with a policy that denies `addCommentToJiraIssue` calls whose `issueIdOrKey` is
    not an alphabetic `KEY-nnn` shape, or resolve the ID→project mapping upstream.
  - **Key normalisation is whitespace-only — embedded junk is a residual.** The project prefix is
    `trim_space`d, so leading/trailing spaces, tabs, and newlines around an otherwise-valid key
    (`" SUP-123"`, `"SUP-123\n"`) still match the JSM set and are rewritten. Characters embedded
    *inside* the prefix (e.g. a zero-width space, `"SUP​-123"`) are **not** stripped and would
    miss the match — but such a mangled key is not a valid Jira issue key and fails at the server
    rather than posting a portal-visible comment. If you need defence against embedded control
    characters, pair with a schema-validation ingress policy that rejects non-`KEY-nnn` shapes.
  - **Comment-via-transition escape hatch — documented residual.** The official
    `transitionJiraIssue` tool accepts open `fields`/`update` objects (verified in the landscape
    note), and Jira's transition API adds a comment via `update.comment[].add` — with its own
    optional visibility. A comment posted that way never passes through `addCommentToJiraIssue` and
    is not inspected by this policy, so an injected agent can land a portal-visible comment on a JSM
    issue by transitioning it. Pair with a policy that denies or strips `update`/`fields` payloads
    on `*transitionjiraissue` (see the landscape note's publication-control candidate) to close
    this. Official `editJiraIssue` exposes only a `fields` object, and Jira does not accept comment
    adds via `fields`, so it is not a comment route per the verified schema.
  - **Customer-facing audiences beyond the default are not detectable.** The rewrite refuses to
    treat `{type: "role", value: "Service Desk Customers"}` (the default JSM customer role,
    compared lower-cased/trimmed via the `customer_facing_values` placeholder set) as restrictive —
    otherwise an injected agent could "restrict" a comment to the customers themselves. Any *other*
    role or group whose membership includes portal customers is indistinguishable from an internal
    one at the gateway; extend `customer_facing_values` with your site's customer-containing
    roles/groups at import time.
  - **Community `jira_add_comment` / `jira_edit_comment` are not matched.** `sooperset/mcp-atlassian`
    names its comment tools `jira_add_comment` and `jira_edit_comment` with a different (unverified)
    visibility argument. Per the no-invented-names rule this policy adds no speculative suffix; if
    your gateway front-ends the community server, confirm the real tool and visibility field with
    the dump-input technique and add them before relying on this policy there.
  - **Non-restrictive existing `commentVisibility` is overwritten — wholesale.** If a call supplies
    a `commentVisibility` that is malformed (including a non-object value), uses an unrecognised
    `type` (e.g. `type: "public"`), carries an empty/whitespace-only `value`, carries any key
    beyond `{type, value}` (e.g. `identifier`), or names a customer-facing audience, it is treated
    as unrestricted and **replaced in full** with the internal default — the existing object is
    dropped before the injection, so no caller-supplied key inside it survives. A well-formed `role`/`group` visibility with a
    non-customer-facing, `trim_space`-non-empty value is preserved as-is (the caller's internal
    scoping choice is respected even if it differs from the default).
  - **Malformed (non-object) `args` pass through unmodified.** If a caller sends `args` as a string or
    array, the `object.get` chain is undefined on a non-object, so the rewrite never fires and the call
    passes through. Such a call cannot carry a valid `commentBody`/`issueIdOrKey` and fails at the
    server rather than posting a portal-visible comment. Pair with `role-gate-writes` or a
    schema-validation ingress policy if you want malformed writes rejected outright.
  - **Visibility only, never a deny.** This policy never blocks a comment; it only scopes it internal.
    Pair it with `role-gate-writes` if some callers should not be able to comment at all.
  - **Identity placeholders.** Group names are placeholders — replace `support-agents` with your IdP's
    group name at import time.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - jira
industries: []
bundles:
  - soc2
  - atlassian
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package jira.ingress.force_internal_jsm_comments

# Transform-only policy: allow everything, and rewrite addCommentToJiraIssue
# calls on JSM projects so agent-drafted text is scoped to an internal role
# instead of landing on the customer-facing portal. Never denies.
default allow := true

# ---------------------------------------------------------------------------
# Configuration placeholders — replace at import time
# ---------------------------------------------------------------------------

# JSM project-key prefixes whose comments must be internal-only. Upper-case.
# PLACEHOLDER: replace with your JSM project keys.
jsm_project_keys := {"SUP", "HELP", "ITSM"}

# IdP group whose members may post customer-portal-visible comments (their
# calls pass through unmodified). PLACEHOLDER: replace with your IdP group.
support_agents_group := "support-agents"

# The commentVisibility injected onto unrestricted JSM comments. "Service Desk
# Team" is the default JSM project role; change value for your project's role.
internal_visibility := {"type": "role", "value": "Service Desk Team"}

# commentVisibility.type values that actually restrict a comment to an internal
# audience. Anything else is treated as unrestricted (portal-visible).
restrictive_visibility_types := {"role", "group"}

# Role/group names whose membership includes portal customers — a visibility
# naming one of these is NOT internal, so it is rewritten like an unrestricted
# comment. "Service Desk Customers" is the default JSM customer role. Compared
# lower-cased/trimmed. PLACEHOLDER: extend with any customer-containing
# roles/groups in your site.
customer_facing_values := {"service desk customers"}

# ---------------------------------------------------------------------------
# Shared accessors — every possibly-missing field is read via object.get
# ---------------------------------------------------------------------------

args := object.get(object.get(input, "payload", {}), "args", {})

# addCommentToJiraIssue tool. Verified official name; the gateway prefixes the
# server name, so match by suffix for portability. Case-insensitive so a
# mixed-case tool name can't slip past. Match on resource.name OR the legacy
# payload.name alias (both populated on tool hooks, same value): a call that
# arrived with an absent/empty resource.name would otherwise miss the match and
# pass the comment through portal-visible — a fail-open leak. Reading both via
# object.get also means a missing `resource` object can't error the rule.
is_add_comment_call if {
    input.action == "tool_pre_invoke"
    endswith(lower(object.get(object.get(input, "resource", {}), "name", "")), "addcommenttojiraissue")
}

is_add_comment_call if {
    input.action == "tool_pre_invoke"
    endswith(lower(object.get(object.get(input, "payload", {}), "name", "")), "addcommenttojiraissue")
}

# Project prefix of issueIdOrKey (substring before the first "-"), upper-cased.
# The raw value is trim_space'd first so leading/trailing whitespace, tabs, or
# newlines (" SUP-123", "SUP-123\n") can't push the prefix out of the JSM key
# set and slip a portal-visible comment through. split always yields >= 1
# element, so this is defined whenever args is an object; a bare numeric ID
# (no "-") yields the whole string, which won't be in the JSM key set
# (documented residual).
issue_project := upper(split(trim_space(object.get(args, "issueIdOrKey", "")), "-")[0])

# True when the issue belongs to a configured JSM project.
is_jsm_issue if {
    jsm_project_keys[issue_project]
}

# True when the caller is in the support-agents exemption group. Missing claims /
# missing subject fail closed (no group -> not exempt -> comment is rewritten).
is_support_agent if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    some g in object.get(claims, "groups", [])
    g == support_agents_group
}

# True when the caller already scoped the comment to an internal audience: a
# commentVisibility object with a role/group type and a non-empty value. When
# true, the comment is not portal-visible and is left untouched.
has_restrictive_visibility if {
    cv := object.get(args, "commentVisibility", {})
    is_object(cv)
    # Only the exact verified shape {type, value} counts. An extra key (e.g. the
    # REST "identifier" field) could re-address the audience by ID while `value`
    # looks internal, so any unexpected key disqualifies the object and the
    # visibility is replaced wholesale with the internal default.
    object.keys(cv) == {"type", "value"}
    restrictive_visibility_types[lower(object.get(cv, "type", ""))]
    value := object.get(cv, "value", "")
    is_string(value)
    # trim_space so a whitespace-only value (" ", "\t") can't pass off a bogus
    # visibility as "restrictive" and dodge the internal-default rewrite.
    trim_space(value) != ""
    # A role/group whose membership includes portal customers is not internal —
    # {type: "role", value: "Service Desk Customers"} must not count as
    # restrictive, or an injected agent could scope the comment to customers.
    not customer_facing_values[lower(trim_space(value))]
}

# ---------------------------------------------------------------------------
# Transform: inject internal commentVisibility on unrestricted JSM comments
# ---------------------------------------------------------------------------

# The caller's commentVisibility is removed before the union: object.union
# merges nested objects recursively, so unioning over an existing
# commentVisibility would let extra caller-supplied keys (e.g. the REST
# visibility "identifier" field) survive inside the injected object and
# re-address the audience. Dropping it first replaces the object wholesale.
transform := {"transformed_payload": object.union(object.remove(args, {"commentVisibility"}), {"commentVisibility": internal_visibility})} if {
    is_add_comment_call
    is_jsm_issue
    not is_support_agent
    not has_restrictive_visibility
}
```
