---
name: Freeze M365 Identity Plane
tags:
  - ms365
  - freeze-identity-plane
  - ingress
  - identity
  - entra
  - groups
  - iso27001-nist
  - soc2
publishedAt: 2026-07-12
description: |
  # ms365 / freeze-identity-plane

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny group/team membership mutations, allow everything else
  **Package:** `ms365.ingress.freeze_identity_plane`

  ## What it does

  Freezes directory and membership mutations on the Microsoft 365 MCP surface. The
  policy denies, by tool-name suffix:

  - `*-create-group` / `*-update-group` — group creation and property changes
  - `*-add-group-member` / `*-remove-group-member` — group membership changes
  - `*-add-group-owner` / `*-remove-group-owner` — group ownership changes
  - `*-add-team-member` / `*-remove-team-member` — Teams membership changes

  All other tools pass through unchanged. The denied tools are exempt **only** for
  callers whose IdP `groups` claim contains the placeholder group `iam-admins`, read
  fail-closed from `input.subject.claims.groups` — a missing subject, missing claims,
  or missing/empty `groups` claim means no exemption and the mutation is denied.

  The escalation risk is concrete in M365. Microsoft 365 groups are the access-control
  primitive behind Teams, SharePoint sites, and shared mailboxes: `add-group-owner`
  hands control of every group-bound resource (the Team, its SharePoint site, its
  shared mailbox) to the added principal, and `add-group-member` silently widens
  access to group-shared files and channels. An injected agent that can touch these
  tools can grant itself — or an outside account — persistent access that survives the
  session. Freezing the identity plane at ingress means the mutation never reaches
  Microsoft Graph.

  Reads (`*-list-groups`, `*-list-group-members`, `*-list-group-owners`, `*-get-group`,
  `*-list-team-members`, `*-list-my-memberships`, …) stay open so agents can operate
  recon-free without triggering denials. `delete-group` is intentionally **not**
  matched here — destructive deletion belongs to the companion
  `freeze-destructive-ops` policy (one policy, one job).

  ## Compliance alignment

  - **ISO 27001 A.8.2 / NIST 800-53 AC-6(9), AC-6(10)** — supports privileged access
    restriction: group membership and ownership changes are privileged directory
    operations, and this policy prevents non-privileged callers (and injected agents
    acting as them) from executing privileged functions on the agent channel.
  - **FedRAMP AC-6** — supports least-privilege alignment for deployments mapped
    through the NIST 800-53 baseline: identity-plane mutations require an explicit
    IdP-asserted admin group.
  - **SOC 2 CC6.1 / CC6.3** — supports logical access security and role-based least
    privilege: group membership and ownership changes are privileged operations,
    gated to a named admin group so a non-privileged caller (or an injected agent
    acting as one) cannot widen its own access.
  - **HIPAA §164.308(a)(4)** — supports information access management on a
    PHI-capable suite: M365 groups are the access-control primitive behind Teams,
    SharePoint sites, and shared mailboxes that hold ePHI, so freezing membership and
    ownership mutations on the agent channel keeps access grants under human control.

  ## Tool name matching

  The policy matches by suffix on the lowercased `input.resource.name`:

  `-create-group`, `-update-group`, `-add-group-member`, `-add-group-owner`,
  `-remove-group-member`, `-remove-group-owner`, `-add-team-member`,
  `-remove-team-member`

  Tool names are verified against the `softeria/ms-365-mcp-server` implementation as
  observed live through a gateway deployment (gateway prefix `ms365-`, e.g.
  `ms365-add-group-owner`). The DTwo gateway prefixes tool names with the configured
  MCP server name, and that prefix is not standardized — suffix matching keeps the
  policy portable across server names. Bare, unprefixed tool names (`create-group`
  rather than `ms365-create-group`) carry no leading hyphen and would not end with
  any listed suffix, so the policy also matches each bare name exactly — a gateway
  that forwards the server's own tool names without a prefix cannot slip past the
  suffix match. Verify the exact names your gateway sends with the dump-input debug
  technique before relying on this in production.

  ## Argument shape

  The decision uses only the tool name (`input.resource.name`) and the caller's
  identity (`input.subject.claims.groups`). Tool arguments are not inspected, so no
  argument-shape drift can bypass the deny. Identity is read with `object.get`
  chains: a missing `subject`, missing `claims`, or missing `groups` claim yields an
  empty group list, which fails closed — the caller is not exempt and the mutation is
  denied.

  ## Examples

  ### Allowed — read tool, no identity required

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-list-group-members", "type": "tool" },
      "payload": { "name": "ms365-list-group-members", "args": { "groupId": "g-123" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — membership mutation by a non-admin caller

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "ms365-add-group-owner", "type": "tool" },
      "subject": { "sub": "auth0|agent-user", "claims": { "groups": ["engineering"] } },
      "payload": {
        "name": "ms365-add-group-owner",
        "args": { "groupId": "g-123", "userId": "u-456" }
      }
    }
  }
  ```

  `allow = false`, `reason = "M365 group and team membership changes are frozen on the agent path (...)"`.

  ### Allowed — same mutation by an `iam-admins` member

  The same call with `"groups": ["iam-admins"]` in `input.subject.claims` returns
  `allow = true`.

  ## Composition

  This policy is single-purpose. Useful companions:

  - **`freeze-destructive-ops`** (PF-06) — owns `*-delete-group` and the rest of the
    delete-class surface. This policy deliberately leaves deletion to it.
  - **A PF-22 escape-hatch deny on `*-graph-batch`** — `graph-batch` can issue
    arbitrary Graph requests, including `POST /groups/{id}/members/$ref`, and
    bypasses every per-tool rule here. Without it, this policy's guarantee holds only
    for the named tools.
  - **`role-gate-writes`** (PF-12) — the baseline write gate for everything else on
    the M365 surface.

  ## Known limitations

  - **`graph-batch` and raw-Graph passthroughs bypass this policy.** The softeria
    server's `graph-batch` tool and Lokka's single `Lokka-Microsoft` tool can reach
    the same Graph membership endpoints without matching any suffix here. Deploy a
    PF-22 escape-hatch policy alongside this one; for Lokka, name-based matching is
    useless and the deny must inspect `method`/`path` arguments.
  - **Group names are placeholders** — replace `iam-admins` with your IdP's group
    name at import time. The match is an exact, case-sensitive string comparison
    against entries of the `groups` claim; `IAM-Admins` does not match `iam-admins`.
  - **The `groups` claim must be an array of strings.** If your IdP emits a single
    string or a namespaced custom claim (e.g. `https://acme.com/groups`), adjust
    `caller_groups` in the Rego. The exemption is guarded by `is_array`, so every
    non-array shape fails closed (deny) — including an object-shaped claim such as
    `{"role": "iam-admins"}`, whose *values* would otherwise have been iterated by
    `some group in caller_groups` and spoofed the admin exemption. Without the guard
    that shape failed **open**; with it, only a JSON array whose elements include
    the exact string `iam-admins` grants the exemption.
  - **Suffix matching assumes the gateway joins the server-name prefix with a
    hyphen.** DTwo's gateway does (`ms365-add-group-owner`, verified live), and the
    policy also matches bare unprefixed names exactly. But a non-standard gateway
    that joined the prefix with `_` or `.` (`ms365_add-group-owner`,
    `ms365.add-group-owner`) would not end with any hyphen-led suffix and would slip
    through. Verify the exact separator your gateway sends with the dump-input debug
    technique; if it is not a hyphen, extend the match.
  - **Only softeria tool names are verified.** The Anthropic-hosted Microsoft 365
    connector does not publish MCP-level tool names (and does not traverse a
    customer gateway); the official Microsoft enterprise server is read-only and has
    no mutation tools to match. If you route a different Graph-backed server through
    the gateway, verify its tool names and extend the suffix list.
  - **Reads stay open by design.** `list-groups`, `list-group-members`, and other
    directory reads are not gated here. If directory recon itself is a concern in
    your environment, add a separate read-gating policy rather than widening this
    one.
  - **A request with no resolvable tool name passes through.** This is a blocklist
    keyed on `input.resource.name`: a missing or empty name matches no suffix and
    is allowed. The gateway reliably populates `resource.name` on
    `tool_pre_invoke`, so this is inherent blocklist semantics rather than an
    observed gateway behavior; if you need fail-closed-on-unknown, deploy a PF-28
    default-deny allowlist policy instead of (or alongside) this one.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - ms365
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package ms365.ingress.freeze_identity_plane

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Placeholder IdP group permitted to perform identity-plane mutations.
# Replace "iam-admins" with your IdP's group name at import time.
iam_admin_group := "iam-admins"

# Lowercased, whitespace-trimmed tool name. The gateway prefixes tool names
# with the configured MCP server name (observed live as `ms365-`), so matching
# is case-insensitive and suffix-based to stay portable across server names.
# Red-team fix: trim_space so a trailing space/newline in the tool name cannot
# defeat the endswith suffix match (`"...-add-group-owner\n"` would otherwise
# slip through).
tool_name := trim_space(lower(object.get(object.get(input, "resource", {}), "name", "")))

# Directory and membership mutations on the softeria ms-365-mcp-server,
# verified from a live gateway deployment. `delete-group` is intentionally
# absent — it belongs to the companion freeze-destructive-ops policy.
identity_mutation_suffixes := [
    "-create-group",
    "-update-group",
    "-add-group-member",
    "-add-group-owner",
    "-remove-group-member",
    "-remove-group-owner",
    "-add-team-member",
    "-remove-team-member",
]

is_identity_mutation if {
    some suffix in identity_mutation_suffixes
    endswith(tool_name, suffix)
}

# Red-team fix: every suffix starts with "-", so a bare, unprefixed tool name
# (e.g. `create-group` from a gateway configured without a server-name prefix)
# would not end with any suffix and slip through. Match the bare names exactly.
is_identity_mutation if {
    some suffix in identity_mutation_suffixes
    tool_name == trim_prefix(suffix, "-")
}

# --- Identity (fail closed) ---
# Missing subject, missing claims, a missing groups claim, or a groups claim
# that is not an array all yield "not an IAM admin" — mutations then deny.
caller_groups := object.get(object.get(object.get(input, "subject", {}), "claims", {}), "groups", [])

# Red-team fix: guard on is_array. Without it, `some group in caller_groups`
# iterates the *values* of an object-shaped groups claim, so a claim like
# {"role": "iam-admins"} would spoof the exemption and fail OPEN. Requiring an
# array makes every non-array shape (string, object, number) fail closed —
# matching the documented "must be an array of strings" contract.
caller_is_iam_admin if {
    is_array(caller_groups)
    some group in caller_groups
    group == iam_admin_group
}

# Allow any tool that is not an identity-plane mutation (reads such as
# list-groups and list-group-members stay open for recon-free operation).
allow if {
    not is_identity_mutation
}

# Allow identity-plane mutations only for members of the IAM admin group.
allow if {
    is_identity_mutation
    caller_is_iam_admin
}

reasons contains msg if {
    is_identity_mutation
    not caller_is_iam_admin
    msg := sprintf("M365 group and team membership changes are frozen on the agent path — group membership and ownership changes are made in the Microsoft Entra admin center by an identity administrator. If your role requires making these changes through the gateway, ask your identity admin to add you to the '%s' IdP group, or contact your InfoSec team if this looks like a false positive.", [iam_admin_group])
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
