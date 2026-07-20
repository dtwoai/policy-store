---
name: "Slack: Redact Profile PII from User Lookups"
tags:
  - slack
  - pii
  - redaction
  - privacy
  - egress
  - soc2
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # slack / redact-profile-pii

  **Direction:** egress (`tool_post_invoke`)
  **Default:** allow (transform-only — never denies)
  **Package:** `slack.egress.redact_profile_pii`

  ## What it does

  Redacts personally identifiable information — email addresses, phone
  numbers, and Slack custom profile fields (which commonly carry phone,
  title, and manager) — from the responses of Slack user-lookup tools before
  they reach the agent. Display name and `user_id` are left intact, so agent
  workflows that resolve mentions or look up who to notify keep working; the
  agent just no longer receives a PII directory it does not need.

  Callers whose IdP `groups` claim contains `people-ops` receive unredacted
  profiles. Anyone else — including callers with missing, empty, or
  malformed identity claims — gets the redacted view (the exemption fails
  closed).

  The policy addresses the PII-directory-harvesting surface: a single agent
  session can otherwise sweep `slack_search_users` / `slack_read_user_profile`
  across the workspace and assemble an email + phone directory of every
  employee.

  ## Compliance alignment

  - **SOC 2 CC6.7** — supports the restriction on transmission/movement of
    information by masking personal contact data on the agent read path;
    **C1.1** — supports identifying and protecting confidential information
    (employee contact data in workspace profiles); **P4.1** — supports
    limiting personal-information use to identified purposes: mention
    resolution keeps working, directory harvesting does not.
  - **HIPAA §164.502(b)** — supports the minimum-necessary standard: agents
    resolving users do not need workforce emails and phone numbers;
    **§164.514(b)** — supports de-identification by removing Safe-Harbor
    identifier classes (email addresses, telephone numbers) from responses.
  - **GDPR Art. 5(1)(c)** — supports data minimisation on the agent channel;
    **CPRA §1798.121** — supports the consumer's right to limit use of
    sensitive personal information by keeping contact PII out of agent
    context unless the caller has a people-ops role.

  ## Tool name matching

  The policy targets the user-lookup tools of the three Slack MCP servers in
  real use (official, korotovsky community, archived reference), matched by
  suffix:

  | Suffix | Server / tool |
  |---|---|
  | `_read_user_profile` | official `slack_read_user_profile` |
  | `_get_user_profile` | archived reference `slack_get_user_profile` |
  | `_search_users` | official `slack_search_users` |
  | `_get_users` | archived reference `slack_get_users` |
  | `users_search` | korotovsky `users_search` |

  The DTwo gateway prefixes tool names with the configured MCP server name
  (e.g. `slack-mcp-slack_read_user_profile`), and that prefix is not
  standardized. Before matching, the policy lowercases the name and
  normalizes `-` to `_` (and trims stray surrounding whitespace), then matches
  on the suffix — so it works whether your gateway joins with hyphens or
  underscores. Three name surfaces are checked: `input.resource.name`,
  `input.tool_metadata.name`, and the legacy `input.payload.name` alias.
  Egress is detected by `input.mode == "output"` with a fallback to the
  `tool_post_invoke` action/kind identifier, so a response is still redacted
  if a gateway leaves `mode` unset. Verify the exact names your gateway emits
  with the dump-input debug technique before relying on this in production.

  ## Response shape

  Each server returns its own JSON shape for profiles, and the official
  server documents tool names/shapes as runtime-discoverable rather than
  contractual. The policy therefore does not parse the response; it hands
  the gateway a redaction transform that works on any shape:

  - `redact_fields: ["email", "phone", "fields"]` — structured JSON keys,
    matched case-insensitively and recursively. `fields` is the container
    Slack uses for custom profile fields (commonly phone, title, manager).
  - `redact_patterns` — email and phone regexes applied to the serialized
    response, catching PII that appears under other keys or in plain text.

  `display_name`, `real_name`, `name`, and `id`/`user_id` keys are not in
  the redaction list and survive intact (unless their *values* are
  email/phone shaped — see Known limitations).

  ## Identity exemption

  Callers with `"people-ops"` in `input.subject.claims.groups` (exact,
  case-sensitive match) bypass redaction. The check uses safe `object.get`
  chains plus an `is_array` guard: a missing `subject`, missing `claims`,
  missing `groups`, or a `groups` value that is not an array (a string, an
  object such as `{"role":"people-ops"}`, a number, or null) all fail closed
  to the redacted view.

  ## Examples

  ### Redacted (default)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "slack-mcp-slack_read_user_profile", "type": "tool" },
      "subject": { "sub": "google-apps|dev@corp.example", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "slack-mcp-slack_read_user_profile",
        "text": ["{\"user_id\":\"U024BE7LH\",\"display_name\":\"jane\",\"email\":\"jane@corp.example\",\"phone\":\"+1 555 123 4567\"}"]
      }
    }
  }
  ```

  `allow = true`, and the policy emits a transform. After the gateway applies
  it, `email` and `phone` values read `[REDACTED]`; `user_id` and
  `display_name` are untouched.

  ### Unredacted (people-ops exemption)

  ```jsonc
  {
    "input": {
      "action": "tool_post_invoke",
      "mode": "output",
      "resource": { "name": "slack-mcp-slack_read_user_profile", "type": "tool" },
      "subject": { "sub": "google-apps|hrbp@corp.example", "claims": { "groups": ["people-ops"] } },
      "payload": { "name": "slack-mcp-slack_read_user_profile", "text": ["..."] }
    }
  }
  ```

  `allow = true`, no transform — the caller sees the full profile.

  ## Composition

  Transform-only and `default allow := true`, so it composes cleanly with
  deny policies on the same egress pipeline. Useful companions:

  - [`guard-dm-privacy`](../guard-dm-privacy/policy.md) — ingress gate on
    DM/private-channel reach; this policy covers the profile-directory
    surface that gate does not.
  - [`redact-sensitive-info`](../redact-sensitive-info/policy.md) — ingress
    redaction on outbound messages; pairing both keeps PII masked in both
    directions.
  - [`block-secrets`](../block-secrets/policy.md) — ingress deny for
    credential-shaped message bodies.

  ## Known limitations

  - **Response shapes are observed, not contractual.** Slack documents the
    official server's tool names/shapes as runtime-discoverable ("use
    `tools/list` as the source of truth; names can change"). The suffix list
    and field keys here match the mid-2026 landscape; re-verify after server
    updates. The korotovsky `users_search` name is verified from that
    project's README, but your gateway's full prefixed name should be
    confirmed with the dump-input technique. **Tool-name drift fails open:**
    matching is by a fixed suffix allowlist, so a renamed, versioned, or newly
    added profile-returning tool whose suffix is not in the list
    (e.g. `slack_read_user_profile_v2`, or the not-yet-verified emoji /
    channel-member-listing tools the landscape note leaves unnamed) passes
    through **unredacted** until you extend `profile_tool_suffixes`. Re-verify
    the suffix list against `tools/list` after every server upgrade.
  - **`redact_fields` may not descend into serialized JSON.** MCP tool output
    arrives as `payload.text`, an array of content-block *strings*. When a
    server returns the profile as a JSON string inside that array (the common
    shape), `redact_fields` — which matches structured object *keys* — may not
    reach keys that live inside the string; in that case only the
    `redact_patterns` email/phone regexes fire on the serialized bytes. Email
    and phone *values* are therefore still masked, but non-PII-shaped custom
    fields carried under `fields` (e.g. title, manager) can survive. Do not
    rely on this policy to strip title/manager unless you have confirmed your
    gateway applies `redact_fields` recursively into stringified JSON; pair
    with a purpose-built transform if you need that guarantee. (This is a
    downstream transform-engine behavior and is not exercised by the policy
    test runner, which asserts only that the transform is emitted.)
  - **Pattern over-match.** The phone regex matches bare 10-digit runs, so
    Unix timestamps in profile responses (e.g. `updated`, message `ts`
    values) may be redacted too — cosmetic, but visible. A display name
    whose value is email-shaped will be redacted despite the intent to keep
    display names intact.
  - **Pattern under-match.** Phone numbers written without `+`, country
    code, or separators in non-NANP local formats may survive redaction.
    PII in free-text profile fields that is not email/phone shaped (e.g. a
    street address in a status line) is out of scope.
  - **`fields` is a generic key.** Any key named `fields` in a matched
    tool's response is redacted, not only Slack's custom-field container.
    Scope is limited to the five user-lookup suffixes, so collateral impact
    is confined to profile responses.
  - **Other surfaces can leak profile data.** Message search/history tools
    (`slack_search_public*`, `slack_read_channel`, …) may return messages
    that quote someone's email or phone; those tools are outside this
    policy's scope — pair with a general PII-redaction egress policy if you
    need workspace-wide coverage.
  - **Group names are placeholders** — replace `people-ops` with your IdP's
    group name at import time. The match is exact and case-sensitive
    (`People-Ops` does not qualify), and the exemption requires `groups` to be
    an **array** of strings: every other shape (single string, object, number,
    null, or missing) fails closed to the redacted view. Confirm your IdP emits
    `groups` as a string array for your tenant before relying on the exemption.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: egress
apps:
  - slack
industries: []
bundles:
  - slack
  - soc2
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package slack.egress.redact_profile_pii

# Transform-only policy — never denies, only redacts profile PII from Slack
# user-lookup responses. Every other tool and every caller in the people-ops
# group passes through untouched.
default allow := true

# -----------------------------------------------------------------------------
# Scope: Slack tools that return user-profile content, across the three MCP
# servers in real use (official, korotovsky community, archived reference).
# The gateway prefixes tool names with the configured MCP server name, so we
# match by suffix. Names are normalized first (lowercase, "-" -> "_") because
# gateways join the prefix with hyphens while Slack tool names use
# underscores. Verify exact names with the dump-input debug technique.
# -----------------------------------------------------------------------------

profile_tool_suffixes := {
    "_read_user_profile", # official Slack MCP server: slack_read_user_profile
    "_get_user_profile",  # archived reference server: slack_get_user_profile
    "_search_users",      # official Slack MCP server: slack_search_users
    "_get_users",         # archived reference server: slack_get_users
    "users_search",       # korotovsky/slack-mcp-server: users_search
}

# Normalize a raw tool name: trim surrounding whitespace (a stray newline or
# space around the name would otherwise defeat the suffix match), lowercase,
# and fold the gateway's "-" join char to "_".
normalize(raw) := replace(lower(trim_space(raw)), "-", "_")

# Tool name from the PARC resource surface, normalized.
candidate_names contains name if {
    name := normalize(object.get(object.get(input, "resource", {}), "name", ""))
    name != ""
}

# Egress hooks also expose the tool name under tool_metadata.name, and the
# legacy payload.name alias is populated on tool hooks too. Check all three so
# we match regardless of which surface the gateway populates.
candidate_names contains name if {
    name := normalize(object.get(object.get(input, "tool_metadata", {}), "name", ""))
    name != ""
}

candidate_names contains name if {
    name := normalize(object.get(object.get(input, "payload", {}), "name", ""))
    name != ""
}

is_profile_tool if {
    some name in candidate_names
    some suffix in profile_tool_suffixes
    endswith(name, suffix)
}

# Egress detection. The gateway sets mode=="output" on post-invoke hooks; we
# also accept the tool_post_invoke action/kind identifier so a profile response
# is still redacted if a gateway leaves mode unset (fail closed — redact rather
# than leak). Ingress pre-invoke hooks match none of these, so request
# arguments are never touched.
is_output if input.mode == "output"

is_output if object.get(input, "action", "") == "tool_post_invoke"

is_output if object.get(input, "kind", "") == "tool_post_invoke"

# -----------------------------------------------------------------------------
# Exemption: people-ops sees unredacted profiles. `people-ops` is a
# placeholder — replace it with your IdP's group name at import time. Safe
# object.get chains make missing subject/claims/groups fail closed (no group
# -> not exempt -> redacted). The is_array guard is load-bearing: without it a
# groups claim shaped as an object (e.g. {"role":"people-ops"}) would iterate
# its *values* and match, granting the exemption to a caller who never held the
# group in an array. Requiring an array keeps every non-array shape (string,
# object, number, null) fail-closed.
# -----------------------------------------------------------------------------

caller_is_exempt if {
    claims := object.get(object.get(input, "subject", {}), "claims", {})
    groups := object.get(claims, "groups", [])
    is_array(groups)
    some g in groups
    g == "people-ops"
}

# -----------------------------------------------------------------------------
# Redaction transform. Response JSON shapes differ per server and are
# documented as observed rather than contractual, so we do not parse the
# response: redact_fields handles the structured keys (case-insensitive,
# recursive) and redact_patterns catches email/phone values under any other
# key or in plain text. display_name / real_name / name / id / user_id are
# not listed, so mention-resolution workflows keep working.
# -----------------------------------------------------------------------------

transform := {
    "redact_patterns": [
        # Email addresses
        `[\w.-]+@[\w.-]+\.[\w.-]+`,
        # NANP (US/CA) phone numbers, with or without separators/country code
        `\+?1?[- .]?\(?\d{3}\)?[- .]?\d{3}[- .]?\d{4}`,
        # Bare international E.164 numbers (+ followed by 7-15 digits)
        `\+\d{7,15}`,
        # International numbers with separators (+CC, then grouped digits)
        `\+\d{1,3}[- .]\d{1,4}(?:[- .]\d{2,5}){1,4}`,
    ],
    # `fields` is the container Slack uses for custom profile fields, which
    # commonly carry phone, title, and manager.
    "redact_fields": ["email", "phone", "fields"],
    "replacement": "[REDACTED]",
} if {
    is_output
    is_profile_tool
    not caller_is_exempt
}
```
