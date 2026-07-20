---
name: Cap Intercom Contact Enumeration
tags:
  - intercom
  - cap-bulk-export
  - contact-enumeration
  - dlp
  - ingress
  - soc2
  - hipaa
  - pci-dss
  - gdpr-ccpa
publishedAt: 2026-07-12
description: |
  # intercom / cap-contact-enumeration

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny the bulk-enumeration query shape on contact search (unless the
  caller is a CRM admin); clamp page size on everything else; allow the rest
  **Package:** `intercom.ingress.cap_contact_enumeration`

  ## What it does

  Stops an agent from sweeping Intercom's entire customer base in one (or a few)
  calls. It targets the two enumeration-capable surfaces the landscape note flags
  as the highest-value bulk-PII exfiltration vector — `search_contacts` and the
  generic `search` tool with `object_type == "contacts"` — and applies two levels
  of control:

  1. **Deny the enumeration signature.** On a contact search whose DSL filter
     either targets the email **domain**, or uses a *broadening* operator on
     `email`, `name`, or `phone` — `contains`/`~`, starts-with (`^`), ends-with
     (`$`), a range (`<`/`>`/`<=`/`>=`), or not-equals (`!=`/`neq`) — the call is
     denied.
     That shape is how you harvest the customer list (e.g. "every contact whose
     email is `~ @acme.com`", "every email that ends with `@acme.com`", "every
     contact whose email is `!=` one throwaway address", or "every name
     containing `a`") rather than look up one known person. Exact equality
     (`=`/`eq`) and set membership (`in`/`nin`) stay allowed — they name a known
     contact. A caller in a documented CRM-admin IdP group is exempt.

  2. **Clamp page size on the rest.** Contact searches that are *not* the
     enumeration shape (an exact `email = …` lookup, an ID match, a free-text
     `q`) are allowed but have their `limit` / `per_page` clamped to a bounded
     ceiling (default **50**). The company and article listing tools are clamped
     to their documented maxima — `*list_companies` `per_page` ≤ **60**,
     `*list_articles` `per_page` ≤ **150** — so a single unbounded request cannot
     page the whole workspace at once.

  Denying the domain-sweep / broad-match shape is deliberately higher-value than a
  pure limit clamp: `search_contacts` email-**domain** matching is the single most
  efficient way to bulk-exfiltrate the customer base on this surface, so the
  enumeration shape is blocked outright rather than merely rate-limited.

  Every other tool call — conversation reads, single-record `get_*` / `fetch`,
  article reads, non-Intercom tools — passes through untouched.

  ## Compliance alignment

  This policy instantiates family **PF-08 (`cap-bulk-export`)** for Intercom.

  - **SOC 2 CC6.7** — supports restricting the transmission, movement, and removal
    of confidential information by blocking the query shape that bulk-extracts the
    customer contact base and bounding page size on the remaining list/search paths.
  - **HIPAA §164.502(b) / §164.514(d)** — supports the minimum-necessary standard:
    a support agent looks up the specific contact a case concerns, not the whole
    directory; enumeration is reserved for a documented CRM-admin role.
  - **PCI DSS 7.2.6** — supports restricting programmatic query access to
    repositories of stored account data by role, where Intercom contact custom
    attributes can carry plan/billing metadata: the enumeration deny blocks the
    bulk-query shape that would sweep that data, and the page-size clamp bounds
    the role-permitted queries so a single call cannot page the whole base;
    **7.2.1** — supports the least-privilege access model on the agent channel by
    reserving bulk contact access for a documented CRM-admin role.
  - **GDPR Art. 5(1)(c)** — supports data minimisation by preventing the agent from
    pulling far more personal data than a support interaction requires;
    **CCPA/CPRA 11 CCR §7002** — supports the proportionality principle (collection
    limited to what is reasonably necessary) on the agent channel.

  ## Why ingress

  Enumeration harm is fully determined by the request — the tool name, the DSL
  filter shape, and the page size are all in `input.payload.args`. Blocking at
  ingress means the sweep never reaches Intercom, so no bulk contact set is ever
  returned to the agent (and nothing needs to be redacted on the way back). The
  clamp likewise has to rewrite arguments *before* the call, so it is an ingress
  transform.

  ## Tool name matching

  The DTwo gateway prefixes tool names with the configured MCP server name, so all
  matching is on the lowercased **suffix** for portability. Both `snake_case`
  (official / raoulbia) and `kebab-case` (community servers) separators are
  tolerated:

  - contact search: `*search_contacts` / `*search-contacts`
  - generic search alias: `*search` — gated when `object_type == "contacts"` **or
    when `object_type` is absent/empty** (the landscape note describes `search` as a
    universal search over conversations *and* contacts, so an omitted `object_type`
    still returns contacts and cannot be used to dodge the deny). An explicit
    `object_type:"conversations"` is left out of the contacts path.
  - company listing: `*list_companies` / `*list-companies`
  - article listing: `*list_articles` / `*list-articles`

  All 13 official Intercom tool names are **verified** against Intercom's developer
  docs and the Speakeasy governance catalog (per the landscape note); the generic
  `search` / `object_type` convention is verified there too. Verify the exact
  prefixed names your gateway emits with the dump-input debug technique before
  relying on this in production.

  ## Argument shape

  - The DSL filter is read defensively via `object.get(input.payload.args, "query", {})`.
    The query is walked with `walk/2`, so nested `AND` / `OR` compound clauses are
    inspected too. A leaf clause is an object carrying `field` and `operator`.
  - **Enumeration signature** = any leaf clause where the `field` references a
    domain (its lowercased name contains `"domain"`, e.g. `email_domain`, any
    operator), **or** the `field` is `email` / `name` / `phone` with a
    *broadening* operator: `contains`/`~`, starts-with (`^`), ends-with (`$`), a range
    (`<`/`>`/`<=`/`>=`), or not-equals (`!=`/`neq`). Exact equality (`=`/`eq`)
    and set membership (`in`/`nin`) are **not** enumeration operators — they
    identify a known contact, so they fall through to the clamp instead. The
    operator is lowercased before matching, so casing does not evade it.
  - A query that is **missing**, is a **free-text `q`** (no `query` object), or is
    **reshaped** (a string, a number, an empty object) yields no matching leaf
    clause, so it never trips the enumeration branch — it falls through to the
    clamp instead.
  - Page size is read from `limit` and `per_page`; a numeric value above the
    ceiling is lowered to the ceiling, anything else is left as-is.

  ## Identity

  The CRM-admin exemption reads the caller's IdP groups via
  `object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])`
  and checks membership against `crm_admin_groups` (placeholder: `{"crm-admins"}`).
  The gate **fails closed**: a caller with no `groups` claim (or no `subject` /
  `claims` at all) has an empty group list, matches nothing, and is therefore
  *not* exempt — the enumeration shape is denied for them. The exemption also
  guards the claim shape with `is_array` / `is_string`, so a spoofed non-array
  `groups` (e.g. a map `{"role": "crm-admins"}` whose value happens to equal a
  gated group) cannot iterate its way into the exemption.

  ## Examples

  ### Denied — domain sweep on search_contacts

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-search_contacts", "type": "tool" },
      "subject": { "claims": { "groups": ["support"] } },
      "payload": {
        "name": "intercom-search_contacts",
        "args": { "query": { "field": "email", "operator": "~", "value": "@acme.com" } }
      }
    }
  }
  ```

  `allow = false` — a `contains` match on `email` is an enumeration signature.

  ### Denied — enumeration via the generic search alias

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-search", "type": "tool" },
      "subject": { "claims": { "groups": ["analytics"] } },
      "payload": {
        "name": "intercom-search",
        "args": {
          "object_type": "contacts",
          "query": { "field": "name", "operator": "contains", "value": "a" }
        }
      }
    }
  }
  ```

  `allow = false` — the `search`/`object_type` alias is covered, not just `search_contacts`.

  ### Allowed — CRM admin is exempt

  A caller whose `groups` include `crm-admins` running the same domain sweep is
  allowed (page size is still clamped).

  ### Allowed + clamped — exact lookup with an oversized page

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "intercom-search_contacts", "type": "tool" },
      "payload": {
        "name": "intercom-search_contacts",
        "args": {
          "query": { "field": "email", "operator": "=", "value": "bob@acme.com" },
          "per_page": 500
        }
      }
    }
  }
  ```

  `allow = true`; the transform rewrites `per_page` to `50`.

  ### Allowed — free-text search, no DSL filter

  A `search_contacts` call with only a `q` string (no `query` object) is allowed;
  it is not the enumeration shape.

  ## Composition

  Single-purpose. Useful companions on the same gateway:

  - [`apps/intercom/fence-contact-reads`](../fence-contact-reads/policy.md) — role-gates
    the structured-PII read surface (`get_contact`, `search_contacts`, `fetch` of
    `contact_`/`company_` IDs) so non-support callers get no contact profiles at all.
  - [`apps/intercom/mask-pan-egress`](../mask-pan-egress/policy.md) — masks card
    numbers in whatever contact/conversation data does come back.

  This policy caps how *many* contacts one call can pull and blocks the sweep
  *shape*; `fence-contact-reads` decides *who* may touch the surface at all.

  ## Known limitations

  - **Bounded paging still works.** This raises cost and creates an audit trail; it
    does not make enumeration impossible. An attacker can still page through results
    with repeated bounded calls (each clamped to the ceiling) — including an
    **unfiltered** `search_contacts` (empty or no `query`), which lists the whole
    base a page at a time — or issue many exact lookups. Pair with rate limiting and
    the audit pipeline for detection.
  - **Free-text `q` is clamp-only, not denied.** A contact search that filters via
    the free-text `q` argument (rather than a DSL `query`) is treated as a lookup:
    it is bounded by the page-size clamp but never trips the enumeration deny, even
    when the keyword is a bare domain (`q: "@acme.com"`). This is deliberate — `q` is
    also how a legitimate agent finds one person by name, so it cannot be denied
    without breaking normal search. Each call still returns at most the ceiling;
    rely on the clamp plus rate limiting here.
  - **Operator tokens are the note's plus inferred symbol forms.** The broadening
    operators are grounded in the landscape note's DSL list (`neq`/`gt`/`lt`/
    `contains`); the symbol and affix forms (`!=`, `<`, `>`, `^`, `$`) are inferred
    from Intercom's search API. If your server names an equivalent operator
    differently, add it to `broad_match_operators`. Verify with the dump-input
    debug technique.
  - **Domain-field name is inferred.** The email-**domain** signature matches any
    DSL field whose name contains `"domain"` (e.g. `email_domain`). Intercom's exact
    domain-filter field name is not pinned in the landscape note; if your workspace
    exposes domain matching purely as `email ~ @domain` or `email $ @domain`, that
    path is still caught by the `email` + broadening-operator branch. Review against
    your server's DSL vocabulary.
  - **Only the identity fields are deny-gated.** The enumeration deny fires on a
    domain field or a broadening operator over `email` / `name` / `phone` — the
    identity fields a support agent uses to find one person. A broadening filter on
    a **custom attribute** (`plan ~ enterprise`) or a **timestamp range**
    (`created_at > …`) also returns many contacts, but custom-attribute names are
    arbitrary and unknowable ahead of time, so those shapes are not denied — they
    fall through to the page-size clamp and rely on rate limiting plus the audit
    pipeline. Add the specific custom-attribute names your workspace treats as
    segmentation keys to `enumeration_fields` if you want them deny-gated too.
  - **Non-numeric page sizes pass through.** The clamp only lowers a numeric
    `limit` / `per_page`; a string or object value is left untouched (Intercom
    would reject it upstream). The clamp is defence-in-depth — the enumeration
    **deny** is the primary control and is unaffected.
  - **`fetch` by ID is out of scope.** Single-record `fetch` / `get_contact` is a
    lookup, not enumeration; gate it with `fence-contact-reads`.
  - **Group names are placeholders — replace `crm-admins` in `crm_admin_groups`
    with your IdP's group name at import time.** The exemption works only when the
    gateway has an IdP configured and the caller's JWT carries a `groups` claim.
  - **Community-server coverage.** No surveyed community Intercom server exposes a
    `search_contacts` tool today; the suffix patterns are written to tolerate
    kebab-case in case one appears.

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
package intercom.ingress.cap_contact_enumeration

# Deny-by-default: the enumeration query shape on contact search is denied unless
# the caller is a CRM admin. Every other tool is permitted by the allow rule
# below; a separate transform clamps page size where relevant.
default allow := false

# Page-size ceiling for a (non-enumeration) contact search. A legitimate
# known-contact lookup returns very few rows, so this is intentionally well below
# Intercom's API maximum. Tune for your environment.
contacts_page_ceiling := 50

# Documented maxima for the listing tools (from the Intercom developer docs).
companies_page_ceiling := 60

articles_page_ceiling := 150

# IdP groups exempt from the enumeration deny. Placeholder — replace with your
# IdP's CRM-admin group name at import time.
crm_admin_groups := {"crm-admins"}

# --- Tool matching (suffix, tolerating snake_case and kebab_case) ---------------

is_search_contacts_tool if {
    endswith(lower(input.resource.name), "search_contacts")
}

is_search_contacts_tool if {
    endswith(lower(input.resource.name), "search-contacts")
}

# The generic search alias counts as a contact search when object_type says so.
is_generic_contacts_search if {
    endswith(lower(input.resource.name), "search")
    lower(object.get(input.payload.args, "object_type", "")) == "contacts"
}

# ...and also when object_type is absent/empty. The landscape note describes the
# generic `search` tool as a UNIVERSAL search over conversations AND contacts, so a
# call that omits object_type still returns contacts — closing the "just drop
# object_type" evasion. An explicit object_type:"conversations" (or any other
# non-empty value) is left out of the contacts path so conversation search is not
# over-blocked.
is_generic_contacts_search if {
    endswith(lower(input.resource.name), "search")
    lower(object.get(input.payload.args, "object_type", "")) == ""
}

is_contacts_search_tool if {
    is_search_contacts_tool
}

is_contacts_search_tool if {
    is_generic_contacts_search
}

is_list_companies_tool if {
    endswith(lower(input.resource.name), "list_companies")
}

is_list_companies_tool if {
    endswith(lower(input.resource.name), "list-companies")
}

is_list_articles_tool if {
    endswith(lower(input.resource.name), "list_articles")
}

is_list_articles_tool if {
    endswith(lower(input.resource.name), "list-articles")
}

# --- Enumeration signature detection --------------------------------------------

# A DSL query can be a single leaf clause or a nested AND/OR compound. walk/2
# visits every sub-value, so nested clauses are inspected too. A query that is
# missing, free-text, or reshaped yields no matching leaf clause.
enumeration_clause_present if {
    query := object.get(input.payload.args, "query", {})
    walk(query, [_, node])
    is_object(node)
    is_enumeration_clause(node)
}

# Signature (a): the filter targets an email domain field.
is_enumeration_clause(node) if {
    field := lower(object.get(node, "field", ""))
    contains(field, "domain")
}

# Signature (b): a broadening operator on email, name, or phone. Exact equality
# (= / eq) and set membership (in / nin) are lookups of already-known contacts and
# stay allowed; contains, starts-/ends-with, range, and not-equals all widen the
# filter into a sweep of the customer base.
is_enumeration_clause(node) if {
    field := lower(object.get(node, "field", ""))
    enumeration_fields[field]
    broad_match_operators[lower(object.get(node, "operator", ""))]
}

enumeration_fields := {"email", "name", "phone"}

# Operators that turn an email/name filter into a base sweep rather than a
# single-record lookup. Grounded in the landscape note's DSL operators
# (neq | gt | lt | contains) plus the symbol / affix forms Intercom's search API
# uses for the same semantics. `$` (ends-with) is the operator form of a domain
# sweep — `email $ "@acme.com"` returns every contact on a domain, the exact
# vector this policy exists to stop — so it is an enumeration operator even
# though the landscape note describes domain matching only as a dedicated field.
# Exact equality (= / eq) and set membership (in / nin) are deliberately absent:
# they identify a known contact, not the whole base. Verify the exact operator
# tokens your server's DSL uses (see Known limitations).
broad_match_operators := {
    "~", "contains",
    "!=", "neq", "ne",
    "<", "lt", "<=", "lte",
    ">", "gt", ">=", "gte",
    "^", "starts_with", "startswith", "starts-with",
    "$", "ends_with", "endswith", "ends-with",
}

# --- Identity -------------------------------------------------------------------

caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# Membership grant fails closed: `groups` must be an array of strings. A map- or
# scalar-shaped claim (spoofing surface) is not an array, so it grants nothing.
is_crm_admin if {
    is_array(caller_groups)
    some group in caller_groups
    is_string(group)
    crm_admin_groups[lower(group)]
}

# --- Decision -------------------------------------------------------------------

# The only thing this policy denies: an enumeration-shaped contact search by a
# non-CRM-admin caller.
deny_enumeration if {
    is_contacts_search_tool
    enumeration_clause_present
    not is_crm_admin
}

# Allow everything that is not the enumeration deny.
allow if {
    not deny_enumeration
}

reasons contains "This Intercom contact search uses a bulk-enumeration filter (an email-domain match, or a contains/~ operator on email or name) that can exfiltrate the customer base. Look up a specific contact by exact email, phone, or ID instead. If you genuinely need bulk contact access, ask your CRM administrator to run it or to add you to the CRM-admin group." if {
    deny_enumeration
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}

# --- Page-size clamp (transform) ------------------------------------------------

# Contact searches that are allowed through get their page size bounded.
transform := {"transformed_payload": clamped} if {
    is_contacts_search_tool
    not deny_enumeration
    clamped := clamp_args(input.payload.args, contacts_page_ceiling)
    clamped != input.payload.args
}

# Company listing clamped to its documented maximum.
transform := {"transformed_payload": clamped} if {
    is_list_companies_tool
    clamped := clamp_key(input.payload.args, "per_page", companies_page_ceiling)
    clamped != input.payload.args
}

# Article listing clamped to its documented maximum.
transform := {"transformed_payload": clamped} if {
    is_list_articles_tool
    clamped := clamp_key(input.payload.args, "per_page", articles_page_ceiling)
    clamped != input.payload.args
}

# Clamp both page-size keys used by the search surface.
clamp_args(args, ceiling) := out if {
    out := clamp_key(clamp_key(args, "limit", ceiling), "per_page", ceiling)
}

# Lower a numeric value above the ceiling; otherwise leave args unchanged.
clamp_key(args, key, ceiling) := object.union(args, {key: ceiling}) if {
    clamp_needed(object.get(args, key, null), ceiling)
}

clamp_key(args, key, ceiling) := args if {
    not clamp_needed(object.get(args, key, null), ceiling)
}

clamp_needed(value, ceiling) if {
    is_number(value)
    value > ceiling
}
```
