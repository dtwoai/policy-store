---
name: Constrain Notion Connected-Tool Search
tags:
  - notion
  - constrain-aggregator
  - ingress
  - soc2
publishedAt: 2026-07-12
description: |
  # notion / constrain-connected-search

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny external-scoped searches, allow native Notion searches and all other tools
  **Package:** `notion.ingress.constrain_connected_search`

  ## What it does

  Notion's hosted MCP server (`notion-search`) does not just search Notion pages — through Notion AI connectors it also searches **connected Slack, Google Drive, and Jira content**. That means a single Notion OAuth grant can read those systems' data while bypassing the per-app MCP governance (policies, pipelines, audit) you attached to their own connectors.

  This policy closes that aggregator side-door. It denies search calls whose `query_type` or `filters` argument scopes the search to connected/external sources, forcing that traffic through each system's own governed MCP connector instead. Native Notion searches — the default scope, `query_type: "internal"` / `"user"`, and native filters such as teamspace filters — pass through unchanged, as do all non-search tools.

  The external-scope branch **fails closed**: a `query_type` value or `filters` shape the policy cannot positively recognize as native Notion scope is denied rather than silently allowed, so an unrecognized connector-scoping shape cannot reopen the cross-app path.

  ## Compliance alignment

  - **SOC 2 CC6.6** — supports boundary protection: content from Slack, Google Drive, and Jira only crosses the gateway through each system's own connector, where its dedicated policies apply — not through a Notion side-channel.
  - **SOC 2 CC6.8** — supports preventing unauthorized software paths: the Notion AI connector fan-out is an un-vetted access route into three other systems; this policy keeps it shut on the MCP path.
  - **SOC 2 CC9.2** — supports vendor/business-partner risk management by preventing one vendor's connector (Notion) from becoming an unmanaged proxy for data held with other vendors.
  - **HIPAA §164.508** — supports authorization discipline: PHI residing in connected Slack/Drive/Jira cannot be pulled through the Notion aggregator, which would sidestep the PHI controls attached to those apps' connectors.
  - **GDPR Arts. 44/46** — supports control of agent-visible cross-system transfers: personal data held in Slack, Google Drive, or Jira is not re-exposed through a second processor's search surface without the safeguards configured on the primary path.

  ## Tool name matching

  The policy matches search tools by suffix:

  - `*-search`

  This covers the hosted server's `notion-search` under any gateway server-name prefix (e.g. `notion-notion-search`), and the legacy official local server's plain `search` once the gateway prefixes it (e.g. `notion-mcp-search`). The DTwo gateway prefixes tool names with the configured MCP server name, and that prefix is not standardized — verify the exact name your gateway sends with the dump-input debug technique before relying on this in production.

  **Attach this policy to the Notion pipeline only.** The `-search` suffix is deliberately broad and will also match other apps' search tools (e.g. an Atlassian `*-search` tool) if they share a pipeline, where a legitimate filter value like `"jira"` would be a false positive.

  ## Argument shape

  Read from `input.payload.args` with `object.get` (never direct indexing):

  1. `query_type` (string) — must be absent or a recognized native value: `"internal"` (workspace content) or `"user"` (workspace people search). Any other value — including a non-string — is denied. These enum values come from Notion's hosted-server documentation but are **not independently verified**; extend `native_query_types` if your tenant observes other native values.
  2. `filters` (object) — walked recursively. Any key or string value that canonicalizes (trim surrounding whitespace, lowercase, hyphens/interior-spaces → underscores) to a connected-source token — `slack`, `google_drive`/`googledrive`/`gdrive`/`drive`, `jira`, or a generic scope word (`connected`, `connected_sources`, `connected_tools`, `external`) — is denied. A `filters` value that is not an object or array (a scalar the policy cannot inspect) is denied as an unrecognized shape.
  3. `query` and `teamspace` are treated as content/native scope and are never inspected — search text mentioning "jira" is not a denial trigger.

  ## Examples

  ### Allowed — native workspace search

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-search", "type": "tool" },
      "payload": {
        "name": "notion-notion-search",
        "args": { "query": "Q3 launch retro", "query_type": "internal", "filters": { "teamspace_id": "ts_123" } }
      }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied — search scoped to a connected source

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "notion-notion-search", "type": "tool" },
      "payload": {
        "name": "notion-notion-search",
        "args": { "query": "customer contract", "filters": { "source": "google_drive" } }
      }
    }
  }
  ```

  `allow = false`, `reason = "This Notion search is filtered to a connected external source (...)"`.

  ## Composition

  This policy is single-purpose. Useful companions on the Notion pipeline:

  - `apps/notion` PF-08-style bulk-export caps and PF-02 egress PII redaction on `-search` / `-fetch` / `-query-data-sources` responses.
  - A PF-07-style guard on `-query-data-sources` (raw SQL over Notion databases).
  - **Meta-tool servers are out of scope by design:** the community `awkoy/notion-mcp-server` funnels 43 operations (including deletes and file upload) through a single `notion_execute` tool with unverified per-operation schemas. Tool-name policies cannot govern it — block that server outright in gateway config and standardize on the hosted server.

  ## Known limitations

  - **Connector filter shapes are unverified.** Notion's public docs confirm that `notion-search` reaches connected Slack, Google Drive, and Jira, and confirm the `query_type`/`filters`/`teamspace` argument names, but do not publish the exact filter schema used to scope a search to a connector. The policy therefore combines token matching (keys and string values inside `filters`) with fail-closed handling of unrecognized `query_type` values and uninspectable `filters` shapes. If Notion ships a connector-scoping shape expressed through argument names outside `query_type`/`filters`, it would not be caught — re-verify against live traffic with the dump-input technique.
  - **Token equality, not substrings.** A filter key like `slack_channel_ids` does not canonicalize to `slack` and would pass; conversely a teamspace literally named `drive` would false-positive. Both are deliberate trade-offs to keep false positives low — tune `external_source_tokens` for your workspace.
  - **Default scope may still include connected content upstream.** If your Notion workspace's AI connectors are enabled, an unscoped ("native default") search may still surface connected-source snippets server-side; this policy only blocks *explicitly scoped* connector searches on the MCP path. Disable or restrict Notion AI connectors in the Notion admin console for full coverage — connector configuration itself is outside MCP.
  - **Other implementations differ.** The suekou community server uses `notion_find` (underscore, no `-search` suffix) and is not matched; the awkoy meta-tool server is unmatchable by tool name (see Composition). Add per-implementation policies if you allow those servers.
  - **Bare `search` is only caught when the gateway joins the server prefix with a hyphen.** The hosted server's tool is literally named `notion-search`, so it ends in `-search` under any prefix separator (`notion-notion-search`, `notion.notion-search`). But the legacy local server's tool is the bare word `search`: it is matched only when the gateway prefixes it into `…-search` (e.g. `notion-mcp-search`). If your gateway joins names with a dot or no separator, that server's search surfaces as `notion.search` / `notionsearch`, which does **not** end in `-search` and is treated as a non-search tool (allowed). Confirm the exact emitted name with the dump-input technique; if it is not hyphen-joined, add the observed form to `is_search_tool`. This does not affect the hosted server (the primary target).
  - **No identity-based exemptions.** All callers are subject to the same check. If a specific team legitimately needs Notion connected search, add an `allow if` branch gated on `input.subject.claims` groups.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - notion
industries: []
bundles:
  - soc2
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package notion.ingress.constrain_connected_search

# Deny-by-default: only the explicit allow rules below permit the request.
default allow := false

# Connected-source tokens. Slack, Google Drive, and Jira are the connectors
# verified in the Notion landscape research; the generic scope words catch
# filter shapes that point a search at connected rather than native content.
# Compared by token equality (after canonicalization), not substring, to
# limit false positives. Extend if your workspace enables more connectors
# (e.g. GitHub, Microsoft Teams, SharePoint, OneDrive, Linear).
external_source_tokens := {
    "slack",
    "google_drive",
    "googledrive",
    "gdrive",
    "drive",
    "jira",
    "connected",
    "connected_sources",
    "connected_tools",
    "external",
}

# query_type values recognized as native Notion scope. "" covers the default
# (argument absent). "internal" (workspace content) and "user" (workspace
# people search) are the hosted server's documented values — unverified enum,
# extend if your tenant observes other native values. Anything else fails
# closed: an unrecognized query_type could be a connector scope.
native_query_types := {"", "internal", "user"}

# Match search tools by suffix. The gateway prefixes tool names with the
# configured MCP server name (e.g. `notion-notion-search`), and the legacy
# official local server exposes plain `search` (prefixed to e.g.
# `notion-mcp-search`). Attach to the Notion pipeline only — the suffix is
# broad enough to catch other apps' search tools on a shared pipeline.
is_search_tool if {
    endswith(lower(input.resource.name), "-search")
}

args := object.get(object.get(input, "payload", {}), "args", {})

filters_arg := object.get(args, "filters", {})

# Allow any tool that is not a search call.
allow if {
    not is_search_tool
}

# Allow native searches: recognized native query_type, an inspectable filters
# shape, and no connected/external source referenced anywhere in filters.
allow if {
    is_search_tool
    query_type_is_native
    filters_shape_inspectable
    not filters_scope_external
}

query_type_is_native if {
    qt := lower(object.get(args, "query_type", ""))
    native_query_types[qt]
}

# filters must be a container we can walk. A scalar filters value is an
# unrecognized shape and fails closed rather than opening the cross-app path.
filters_shape_inspectable if is_object(filters_arg)

filters_shape_inspectable if is_array(filters_arg)

# Canonicalize a token: strip surrounding whitespace first (so a padded
# " slack " / "slack\n" cannot dodge equality), then lowercase and map
# hyphens and interior spaces to underscores, so "Google-Drive" and
# "google drive" both resolve to `google_drive`.
canonical(s) := replace(replace(lower(trim_space(s)), "-", "_"), " ", "_")

is_external_token(x) if {
    is_string(x)
    external_source_tokens[canonical(x)]
}

# A string value anywhere inside filters names a connected source
# (e.g. {"source": "slack"} or {"sources": ["jira"]}).
filters_scope_external if {
    walk(filters_arg, [_, value])
    is_external_token(value)
}

# A key anywhere inside filters names a connected source
# (e.g. {"slack": {"channels": ["C123"]}}).
filters_scope_external if {
    walk(filters_arg, [path, _])
    some segment in path
    is_external_token(segment)
}

reasons contains "This Notion search sets query_type to a value that is not a recognized native Notion scope, so it may reach connected Slack, Google Drive, or Jira content. Use the default workspace search, or query those systems through their own governed MCP connectors. Contact your InfoSec team if this was a false positive." if {
    is_search_tool
    not query_type_is_native
}

reasons contains "This Notion search is filtered to a connected external source (Slack, Google Drive, or Jira). Search that system through its own governed MCP connector instead. Contact your InfoSec team if this was a false positive." if {
    is_search_tool
    filters_scope_external
}

reasons contains "This Notion search uses a filters shape this policy cannot verify as native Notion scope. Re-run the search without filters or with native filters (for example teamspace filters). Contact your InfoSec team if this was a false positive." if {
    is_search_tool
    not filters_shape_inspectable
}

reason := joined if {
    count(reasons) > 0
    reason_list := sort([r | some r in reasons])
    joined := concat("; ", reason_list)
}
```
