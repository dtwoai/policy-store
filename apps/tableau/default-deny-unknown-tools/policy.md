---
name: Default-Deny Unknown Tableau Tools
tags:
  - tableau
  - default-deny
  - unknown-tools
  - allowlist
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # tableau / default-deny-unknown-tools

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny — allow only pinned, verified tool names
  **Package:** `tableau.ingress.default_deny_unknown_tools`

  ## What it does

  Fails closed on tool drift. The policy carries a **pinned allowlist** of the 39 tools in the
  verified official Tableau web toolset (`tableau/tableau-mcp` v2.24.x, Jul 2026). A Tableau call
  is allowed only when the suffix of `lower(input.resource.name)` matches an allowlisted tool
  name; **every other name is denied** and surfaced with an actionable reason for operator review.

  The hosted `mcp.tableau.com` server ships new tools automatically as Tableau releases them, so an
  un-pinned gateway silently gains ungoverned tool surface between releases. This policy makes a
  new, renamed, or misspelled upstream tool name fail closed until an operator adds it to the
  allowlist and re-verifies against the server's `tools/list` after each upgrade — turning a silent
  capability expansion into an explicit, reviewed change. The one exception is a new name that
  *suffix-extends* a pinned entry (e.g. a future `force-delete-workbook` ending with the pinned
  `-delete-workbook`); suffix matching lets that through the existence gate — see **Known
  limitations** for why, and how the danger-scoped companions still catch it.

  This is a PF-28 (default-deny-unknown-tools) ingress control. `default allow := false` is the
  whole point: the allowlist is the *only* thing that grants access.

  ## Per-tenant pinning

  `allowed_tool_suffixes` is a **per-tenant constant** — it is the pinned inventory for one tenant's
  Tableau deployment at one point in time. It is not self-updating. The intended operational loop is:

  1. After every Tableau MCP server upgrade (hosted or self-hosted), call `tools/list` on the server.
  2. Diff the returned tool names against `allowed_tool_suffixes`.
  3. For each new tool, decide whether it belongs on the allowlist, add its kebab-case suffix, and
     re-publish this policy version. Denied names in your deny logs are the review queue.

  The shipped list covers **only** the official web toolset. Tableau Next (the Agentforce-platform
  product, `analytics/tableau-next`) exposes a **disjoint snake_case** toolset (`analyze_data`,
  `list_dashboards`, `search_assets`, …) that is intentionally **not** on this list — it is a
  separate product requiring its own allowlist policy. If you run both products behind one gateway,
  attach a second default-deny policy for the Tableau Next server rather than merging the lists.

  ## Compliance alignment

  - **SOC 2 CC6.1** — supports logical access security over protected assets by ensuring only an
    audited, named set of tools can reach the analytics backend on the agent channel.
  - **SOC 2 CC6.6** — supports boundary protection: an upstream server that grows new tools cannot
    expand the gateway's reachable surface without an explicit allowlist change.
  - **SOC 2 CC6.8** — supports the "prevent unauthorized software/functionality" control by denying
    tool functionality that has not been reviewed and pinned.
  - **SOC 2 CC7.2 / CC7.3** — the deny-and-surface behaviour feeds anomaly monitoring: a denied,
    unknown tool name in the audit stream is the drift-detection signal for a new or renamed tool.
  - **GDPR Art. 25** — supports data protection by design and by default on the agent channel: the
    default posture is deny, and new data-reaching capabilities are off until deliberately enabled.

  ## Tool name matching

  Matching is on the **suffix** of `lower(input.resource.name)`, case-insensitive. The DTwo gateway
  prefixes every tool name with the configured MCP server name (e.g. `tableau-mcp-query-datasource`),
  and that prefix is not standardized across deployments — suffix matching keeps the policy portable.
  The official server uses **kebab-case with no vendor prefix** (`query-datasource`, `delete-workbook`),
  so each allowlist entry is the leading-hyphen kebab suffix (`-query-datasource`, `-delete-workbook`).

  The 39 pinned tools, by group:

  - **Data reads:** `-query-datasource`, `-get-datasource-metadata`, `-list-datasources`,
    `-get-view-data`, `-get-custom-view-data`, `-get-view-image`, `-get-custom-view-image`
  - **Catalog / metadata reads:** `-list-workbooks`, `-get-workbook`, `-get-view`, `-list-views`,
    `-list-custom-views`, `-list-projects`, `-search-content`, `-list-jobs`, `-list-users`,
    `-list-extract-refresh-tasks`
  - **Pulse reads:** `-list-all-pulse-metric-definitions`,
    `-list-pulse-metric-definitions-from-definition-ids`,
    `-list-pulse-metrics-from-metric-definition-id`, `-list-pulse-metrics-from-metric-ids`,
    `-list-pulse-metric-subscriptions`, `-generate-pulse-metric-value-insight-bundle`,
    `-generate-pulse-insight-brief`
  - **Admin-insights reads:** `-query-admin-insights-ts-events`,
    `-query-admin-insights-site-content`, `-query-admin-insights-job-performance`,
    `-get-stale-content-report`
  - **Token / session:** `-get-embed-token`, `-revoke-access-token`, `-reset-consent`
  - **Mutations + their `confirm-` twins:** `-delete-datasource`, `-confirm-delete-datasource`,
    `-delete-workbook`, `-confirm-delete-workbook`, `-delete-extract-refresh-task`,
    `-confirm-delete-extract-refresh-task`, `-update-cloud-extract-refresh-task`,
    `-confirm-update-cloud-extract-refresh-task`

  Every destructive tool has a `confirm-` twin registered as a *separate* tool; both the base and
  the `-confirm-` name are pinned so the preview→confirm protocol works end to end. This policy is a
  **gate on existence, not on danger** — it allows the mutation and token tools so they remain
  usable; pair it with the danger-scoped policies below to actually restrict them.

  ## Argument shape

  This policy inspects **only the tool name** (`input.resource.name`). It does not read
  `input.payload.args`, so it is insensitive to argument shape and to the `confirm` preview/execute
  distinction. Argument-level control is the job of the companion policies.

  ## Examples

  ### Allowed — a pinned read tool (server-prefixed)

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-mcp-query-datasource", "type": "tool" },
      "payload": {
        "name": "tableau-mcp-query-datasource",
        "args": { "datasourceLuid": "abc-123", "query": { "fields": [] } }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — a new/renamed upstream tool not yet pinned

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-mcp-list-flows", "type": "tool" },
      "payload": { "name": "tableau-mcp-list-flows", "args": {} }
    }
  }
  ```

  `allow = false`, reason names the tool and tells the operator to verify against `tools/list` and
  add it to the allowlist.

  ### Denied — a Tableau Next (snake_case) tool

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "tableau-next-analyze_data", "type": "tool" },
      "payload": { "name": "tableau-next-analyze_data", "args": { "utterance": "top accounts" } }
    }
  }
  ```

  `allow = false` — Tableau Next tools are a separate product and belong on their own allowlist.

  ## Composition

  This policy governs *which tools exist*; it does not restrict *how* an allowed tool is used.
  Attach it alongside the danger-scoped Tableau policies:

  - **`freeze-destructive-content`** / a mutation-admin gate — restrict the delete/update tools and
    their `confirm-` twins by IdP group and by the `confirm` flag.
  - **`fence-datasource-scope`** — allowlist `datasourceLuid` on `query-datasource`.
  - A **token-management deny** — block `get-embed-token`, `revoke-access-token`, `reset-consent`.
  - An **egress PII-redaction / image-deny** policy for `query-datasource`, `get-view-data`, and the
    image tools.

  Because a default-deny allowlist denies **everything not on the list**, attach this policy to the
  **Tableau MCP server's pipeline only** — not gateway-wide. Attached gateway-wide it would deny
  every non-Tableau tool (including your DTwo management tools, which can self-lock the gateway — see
  Known limitations).

  ## Known limitations

  - **Suffix matching is portable but broad — including against *same-server* variants.** Because
    the gate matches on the *end* of the tool name, any name that merely *ends with* a pinned suffix
    is allowed. Two cases matter. (a) An *unrelated* tool on another server (e.g.
    `something-query-datasource`) — avoided by scoping this policy to the Tableau pipeline only.
    (b) More importantly, a **new, more-dangerous variant of a pinned Tableau tool**: a future
    `force-delete-workbook`, `bulk-delete-datasource`, or `hard-delete-extract-refresh-task` ends
    with the pinned `-delete-workbook` / `-delete-datasource` / `-delete-extract-refresh-task`
    suffix and is therefore **allowed automatically** — even though it is exactly the kind of new,
    unreviewed tool PF-28 exists to catch. So the "a new upstream tool fails closed" guarantee holds
    only for names that do **not** suffix-extend an existing entry; a verb-prefixed superstring
    (`<verb>-<pinned-stem>`) slips past the existence gate. This is confirmed by the
    `force-delete-workbook` test case. Two things bound the blast radius: (1) this is an
    *existence* gate, not a *danger* gate — the danger-scoped companions below (mutation-admin gate,
    token deny) still catch such a tool by argument/identity even when this gate lets its name
    through; and (2) for a strict posture, replace the `endswith` checks with exact-name comparisons
    once you have confirmed the exact server-prefixed names your gateway emits via the dump-input
    debug technique. Names that are *renamed* rather than suffix-extended (`purge-workbook`,
    `remove-workbook`, misspellings) still fail closed as intended.
  - **Generic suffixes collide across servers.** `-list-users`, `-list-jobs`, and `-search-content`
    are not distinctive to Tableau. If this policy were (incorrectly) attached gateway-wide, those
    suffixes would allow same-named tools on other MCP servers. Keep it scoped to the Tableau pipeline.
  - **Self-lock risk.** As a `default allow := false` allowlist, this policy denies `dtwo-*`
    management tools if they route through the same gateway. Attach it only to the Tableau pipeline,
    or add a `dtwo-` management passthrough, to avoid locking yourself out (recover by detaching via
    the DTwo web UI).
  - **The list is a snapshot, not a subscription.** It reflects the verified v2.24.x inventory
    (source-verified from `src/tools/web/toolName.ts`). It does not update itself — a Tableau upgrade
    that adds tools requires a manual re-verification against `tools/list` and a new policy version.
  - **Name only.** This policy does not inspect arguments, identity claims, or the `confirm` flag —
    an allowed mutation tool is still allowed to execute unless a companion policy restricts it.
  - **No identity placeholders.** The allowlist is the same for every caller; this policy is not
    identity-gated.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - tableau
industries: []
bundles:
  - soc2
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package tableau.ingress.default_deny_unknown_tools

# Default-deny-unknown-tools (PF-28). Only the pinned allowlist below grants access;
# every unpinned, new, renamed, or misspelled tool name fails closed.
default allow := false

# Per-tenant pinned allowlist: the 39 tools of the verified official Tableau web
# toolset (tableau/tableau-mcp v2.24.x, Jul 2026 — source: src/tools/web/toolName.ts).
# Entries are leading-hyphen kebab suffixes because the gateway prefixes each tool
# with the configured MCP server name (e.g. `tableau-mcp-query-datasource`).
# This is a SNAPSHOT: re-verify against the server's tools/list after each upgrade
# and add new tools here explicitly. Tableau Next's snake_case tools are a separate
# product and are intentionally excluded.
allowed_tool_suffixes := {
    # Data reads
    "-query-datasource",
    "-get-datasource-metadata",
    "-list-datasources",
    "-get-view-data",
    "-get-custom-view-data",
    "-get-view-image",
    "-get-custom-view-image",
    # Catalog / metadata reads
    "-list-workbooks",
    "-get-workbook",
    "-get-view",
    "-list-views",
    "-list-custom-views",
    "-list-projects",
    "-search-content",
    "-list-jobs",
    "-list-users",
    "-list-extract-refresh-tasks",
    # Pulse reads
    "-list-all-pulse-metric-definitions",
    "-list-pulse-metric-definitions-from-definition-ids",
    "-list-pulse-metrics-from-metric-definition-id",
    "-list-pulse-metrics-from-metric-ids",
    "-list-pulse-metric-subscriptions",
    "-generate-pulse-metric-value-insight-bundle",
    "-generate-pulse-insight-brief",
    # Admin-insights reads
    "-query-admin-insights-ts-events",
    "-query-admin-insights-site-content",
    "-query-admin-insights-job-performance",
    "-get-stale-content-report",
    # Token / session
    "-get-embed-token",
    "-revoke-access-token",
    "-reset-consent",
    # Mutations and their confirm- twins
    "-delete-datasource",
    "-confirm-delete-datasource",
    "-delete-workbook",
    "-confirm-delete-workbook",
    "-delete-extract-refresh-task",
    "-confirm-delete-extract-refresh-task",
    "-update-cloud-extract-refresh-task",
    "-confirm-update-cloud-extract-refresh-task",
}

# Lowercased tool name, safe against a missing resource.name (missing -> "" -> deny).
tool_name := lower(object.get(input.resource, "name", ""))

# Allow only when the tool name ends with a pinned allowlist suffix.
allow if {
    some suffix in allowed_tool_suffixes
    endswith(tool_name, suffix)
}

# Single deny condition: anything not on the allowlist. Name the offending tool and
# tell the operator exactly what to do.
reason := sprintf(
    "Tableau tool '%s' is not on the pinned allowlist of verified official web tools (tableau-mcp v2.24.x, 39 tools). It may be new, renamed, or misspelled upstream. An operator must re-verify the server's tools/list after the latest upgrade and add the tool's kebab-case name suffix to allowed_tool_suffixes before it can be used. Tableau Next's snake_case tools belong on their own allowlist. Contact your InfoSec team if this is a legitimate tool that should be allowed.",
    [object.get(input.resource, "name", "<unknown>")],
) if not allow
```
