---
name: Fence Intercom Contact & Company PII Reads
tags:
  - intercom
  - fence-sensitive-scopes
  - contact-reads
  - pii
  - ingress
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # intercom / fence-contact-reads

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny the structured-PII read surface for callers outside a support/CRM group; allow everything else
  **Package:** `intercom.ingress.fence_contact_reads`

  ## What it does

  Gates Intercom's structured-PII read surface — customer **contact** and **company**
  profiles — by IdP group. A caller whose JWT groups do not include a documented
  support/CRM group is denied access to:

  - `*get_contact` — full PII profile (email, phone, location, activity timestamps, custom attributes)
  - `*search_contacts` — contact search, including the email-**domain** enumeration path
  - `*get_company` — full company record
  - `*list_companies` — company listing
  - the generic `*search` tool **when `object_type == "contacts"`** — the connector-convention
    alias for `search_contacts`
  - the generic `*fetch` tool **when the target ID is `contact_…` or `company_…`-prefixed** —
    the connector-convention alias for `get_contact` / `get_company`

  Every other tool call passes through: conversation reads (`*get_conversation`,
  `*search_conversations`, `*search` with `object_type: "conversations"`, `*fetch`
  of a `conversation_…` ID), Help Center article tools, and any non-Intercom tool.
  Analytics and other non-support roles therefore keep conversation access but are
  steered away from raw customer profiles — enforcing minimum-necessary and
  least-privilege on the agent channel.

  The check runs at ingress, before the call reaches the Intercom MCP server, so a
  denied read never executes and no contact PII is returned to the agent.

  ### Why both the typed and generic paths are covered

  The contacts read surface is reachable two ways. A rule that only named
  `search_contacts` / `get_contact` would be trivially bypassed by calling the generic
  `search` with `object_type: "contacts"`, or the generic `fetch` with a
  `contact_`-prefixed ID. This policy fences the typed tools **and** both generic
  aliases so neither path leaks.

  ## Compliance alignment

  - **SOC 2 C1.1** — supports identifying and protecting confidential information by
    restricting the customer-profile read surface to roles that need it; **P4.1** —
    supports limiting personal-information use to identified purposes (support/CRM),
    keeping customer profiles out of analytics and other roles' reach.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary standard by
    scoping structured-PII reads to the support/CRM workforce; **§164.308(a)(4)** —
    supports information-access management (role-based authorization of access to
    protected data); **§164.522(a)** — supports enforcing agreed-to access restrictions
    on the agent channel.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to stored
    account data by role, where contact custom attributes carry plan/billing metadata;
    **7.2.1** — supports the least-privilege access model on the agent channel.
  - **GDPR Art. 9** — supports guarding special-category-adjacent profile data behind a
    role gate; **Art. 5(1)(b)** — supports purpose limitation (profiles reachable only
    for support/CRM purposes); **CCPA/CPRA §1798.121** — supports the right to limit use
    of sensitive personal information by fencing the profile surface.

  ## Tool name matching

  Tool names are matched **case-insensitively by suffix** on `input.resource.name`,
  because the DTwo gateway prefixes every tool with the configured MCP server name
  (e.g. `intercom-get_contact`) and that prefix is not standardized:

  - `endswith(name, "get_contact")`, `endswith(name, "search_contacts")`,
    `endswith(name, "get_company")`, `endswith(name, "list_companies")` — the typed surface.
  - `endswith(name, "search")` — the generic search tool. Only fenced when the
    `object_type` argument (trimmed + lower-cased) **starts with** `contact` — this
    catches `contacts`, the singular alias `contact`, and whitespace-padded
    `"contacts "`, while `conversations` (which does not start with `contact`) passes
    through. Note `search_contacts` ends in `contacts`, not `search`, so it is caught by
    its own typed rule, not this one.
  - `endswith(name, "fetch")` — the generic fetch tool. Only fenced when the `id`
    argument (lower-cased) **contains** a `contact_` or `company_` token — a bare
    prefixed ID (`contact_123`) or a workspace URL that embeds one
    (`…/users/contact_123`) are both caught. See Known limitations for the bare-URL
    (no embedded token) residual.

  All six tool names (`get_contact`, `search_contacts`, `get_company`, `list_companies`,
  `search`, `fetch`) are **verified** against Intercom's developer docs and the Speakeasy
  governance catalog per the app landscape note.

  ## Argument shape

  - Generic `search`: reads `object.get(input.payload.args, "object_type", "")`,
    lower-cases and `trim_space`s it, then checks it starts with `contact`. If
    `object_type` is present but **not a string** (an array/number/object), the call is
    fenced (fail closed) rather than slipping through — see below.
  - Generic `fetch`: reads `object.get(input.payload.args, "id", "")`, lower-cases it, and
    checks whether it contains a `contact_` / `company_` token (so an embedded-in-URL
    prefixed ID is caught, not only a bare prefix). If `id` is present but **not a string**,
    the fetch is fenced (fail closed).

  ## Identity gate

  Authorization reads the caller's IdP groups:
  `object.get(object.get(input.subject, "claims", {}), "groups", [])`. A caller is
  authorized only if at least one of those groups is in `allowed_groups`
  (placeholder: `{"support", "crm"}`). The gate **fails closed**: a caller with no
  `groups` claim (or no `subject`/`claims` at all) has an empty group list, matches no
  allowed group, and is denied the PII surface.

  ## Examples

  ### Allowed — support-group caller reads a contact

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-get_contact", "type": "tool" },
      "subject": { "claims": { "groups": ["support"] } },
      "payload": { "name": "intercom-get_contact", "args": { "id": "contact_123" } }
    }
  }
  ```

  `allow = true`.

  ### Allowed — analytics caller reads a conversation

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-search", "type": "tool" },
      "subject": { "claims": { "groups": ["analytics"] } },
      "payload": { "name": "intercom-search", "args": { "object_type": "conversations", "query": "state=open" } }
    }
  }
  ```

  `allow = true` — conversation access is unaffected.

  ### Denied — non-support caller enumerates contacts via the generic search alias

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-search", "type": "tool" },
      "subject": { "claims": { "groups": ["analytics"] } },
      "payload": { "name": "intercom-search", "args": { "object_type": "contacts", "query": "email~@acme.com" } }
    }
  }
  ```

  `allow = false`, with the role-gate reason.

  ## Composition

  This policy is single-purpose (role-gate the contact/company read surface). Useful companions:

  - **Egress custom-attribute strip** on `*get_contact` / `*search_contacts` / `*fetch` contact
    responses — remove billing/tier `custom_attributes` even for authorized callers.
  - **Egress PII/PAN redaction** on `*get_conversation` / `*search` / `*fetch` conversation bodies,
    since conversations remain readable here and carry raw customer free-text.
  - **`cap-bulk-export`** to clamp `limit` / `per_page` on the searches this policy still allows for
    authorized callers.

  ## Known limitations

  - **Group names are placeholders — replace `support` / `crm` in `allowed_groups` with your
    IdP's group name at import time.** The gate only works when the gateway has an IdP configured
    and the caller's JWT carries a `groups` claim.
  - **Single-token community servers expose no per-user identity.** Community Intercom servers
    (e.g. `raoulbia-ai/mcp-server-for-intercom`, `fabian1710/mcp-intercom`) authenticate with a
    single workspace-wide `INTERCOM_ACCESS_TOKEN` and expose no per-user identity, so this group
    gate only functions when the caller identity reaches the gateway via IdP claims. Those servers
    also do not expose `get_contact` / `get_company`, so the typed rules simply never match there.
  - **`fetch` bare-URL (no embedded prefix token) residual.** The generic `fetch` tool takes a
    prefixed ID or an Intercom URL, under the `id` argument (the OpenAI/Anthropic connector
    convention). The rule now fences any `id` value that **contains** a `contact_`/`company_`
    token, so a workspace URL that embeds the prefixed ID (`…/users/contact_123`) is caught. A
    URL that references the resource **only** by a bare numeric ID with no `contact_`/`company_`
    token (or that passes the target under a different argument key) is **not** detected and will
    pass through for non-support callers — a known residual bypass (see the tests.yaml case). The
    exact URL/argument shape is unverified in the app landscape note; verify it with the
    dump-input debug technique and, if your server uses bare-numeric URLs, add an explicit
    URL-path matcher (`/contacts/`, `/companies/`) or a per-server key before relying on this in
    production.
  - **Generic `search` without `object_type` is treated as non-contacts.** A `search` call that omits
    `object_type` is allowed (assumed conversation search). If your server defaults `search` to
    contacts when `object_type` is absent, tighten the `is_generic_search_contacts` rule accordingly.
  - **Non-string `object_type` / `id` fail closed (red-team fix).** A `search` whose `object_type` (or a
    `fetch` whose `id`) arrives as a non-string — an array such as `["contacts"]`, a number, or an
    object — cannot be lower-cased, so the primary match rule would be *undefined* and the call would
    otherwise slip through the allow fall-through. The policy fences any present-but-non-string
    `object_type`/`id` and requires support/CRM authorization for it (fail closed). A side effect: a
    malformed conversation search/fetch that wraps its type/id in an array is denied for non-support
    callers with the contact role-gate reason — acceptable, since such input is malformed per the DSL
    and erring toward deny is the intended posture. Absent `object_type`/`id` still uses the documented
    string default and is unaffected.
  - **`groups` claim must be an array.** The identity gate iterates `claims.groups` as a list. If
    your IdP emits a single group as a scalar string rather than a one-element array, the gate
    fails closed (an authorized support user is denied, not wrongly allowed) — normalize the claim
    to an array at the gateway, or add a string-handling branch.
  - **Out of scope by design.** The Intercom web UI, REST API scripts, and Fin's own actions do not
    traverse the gateway and are unaffected by this policy.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - intercom
industries: []
bundles:
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package intercom.ingress.fence_contact_reads

# Deny-by-default: the structured-PII read surface is only reachable by
# callers whose IdP groups authorize it. Everything else falls through the
# `not is_pii_read_surface` allow rule.
default allow := false

# IdP groups permitted to read customer contact/company profiles.
# PLACEHOLDER — replace with your organization's support/CRM group names at import time.
allowed_groups := {"support", "crm"}

# --- Identity gate (fail closed) ---
# Missing subject/claims/groups yields an empty list, which matches no
# allowed group, so a caller with no groups claim is not exempt.
caller_groups := object.get(object.get(input.subject, "claims", {}), "groups", [])

caller_authorized if {
    some g in caller_groups
    allowed_groups[g]
}

# --- The structured-PII read surface ---

# Typed tools: get_contact / search_contacts / get_company / list_companies.
# Matched by suffix so the gateway's server-name prefix does not matter.
is_typed_pii_tool if {
    endswith(lower(input.resource.name), "get_contact")
}

is_typed_pii_tool if {
    endswith(lower(input.resource.name), "search_contacts")
}

is_typed_pii_tool if {
    endswith(lower(input.resource.name), "get_company")
}

is_typed_pii_tool if {
    endswith(lower(input.resource.name), "list_companies")
}

# Generic search aliasing search_contacts: `search` with object_type == "contacts".
# `search_contacts` ends in "contacts" (not "search"), so it is not matched here.
is_generic_search_contacts if {
    endswith(lower(input.resource.name), "search")
    # trim_space + startswith("contact") so whitespace padding ("contacts ")
    # and a singular alias ("contact") cannot slip past strict equality.
    # "conversations" does not start with "contact", so it is unaffected.
    startswith(trim_space(lower(object.get(input.payload.args, "object_type", ""))), "contact")
}

# Defensive (fail closed): a non-string object_type (array/number/object)
# cannot be safely lower-cased — `lower` would error and the rule above would
# be *undefined*, letting the call slip through the `not is_pii_read_surface`
# allow fall-through (type-confusion bypass, e.g. object_type: ["contacts"]).
# Treat any present-but-non-string object_type as the contacts surface and
# fence it. Absent object_type yields the "" default (a string), so the
# documented "search without object_type => pass-through" behaviour is intact.
is_generic_search_contacts if {
    endswith(lower(input.resource.name), "search")
    not is_string(object.get(input.payload.args, "object_type", ""))
}

# Generic fetch aliasing get_contact / get_company: `fetch` of an ID (or
# workspace URL) that embeds a contact_ / company_ token. `contains` (not
# `startswith`) so a URL like `.../users/contact_123` is also caught; a
# `conversation_` id/URL contains neither token and passes through.
is_fetch_pii_id if {
    endswith(lower(input.resource.name), "fetch")
    contains(lower(object.get(input.payload.args, "id", "")), "contact_")
}

is_fetch_pii_id if {
    endswith(lower(input.resource.name), "fetch")
    contains(lower(object.get(input.payload.args, "id", "")), "company_")
}

# Defensive (fail closed): a non-string id (array/number/object) cannot be
# safely inspected for a contact_/company_ token — `lower` would error and the
# rules above would be *undefined*, letting the call slip through the allow
# fall-through (type-confusion bypass, e.g. id: ["contact_123"]). Fence any
# fetch whose id is present but not a string. Absent id yields the "" default
# (a string), so a fetch with no id is not fenced (it is inert at the server).
is_fetch_pii_id if {
    endswith(lower(input.resource.name), "fetch")
    not is_string(object.get(input.payload.args, "id", ""))
}

is_pii_read_surface if { is_typed_pii_tool }
is_pii_read_surface if { is_generic_search_contacts }
is_pii_read_surface if { is_fetch_pii_id }

# --- Allow rules ---

# Anything that is not the structured-PII read surface passes through
# (conversations, articles, non-Intercom tools).
allow if {
    not is_pii_read_surface
}

# The PII read surface is allowed only for authorized support/CRM callers.
allow if {
    is_pii_read_surface
    caller_authorized
}

# --- Deny reason ---

reasons contains "Intercom contact and company profiles are limited to support and CRM roles. Other roles keep conversation access. Ask your admin to add you to the support or CRM IdP group if you need customer-profile access, or contact your security team if this is a false positive." if {
    is_pii_read_surface
    not caller_authorized
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
