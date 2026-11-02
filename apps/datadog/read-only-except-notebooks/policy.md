---
name: Datadog Read-Only Except Notebooks
tags:
  - datadog
  - observability
  - access-control
  - read-only
  - ingress
publishedAt: 2026-10-11
description: |
  # datadog / read-only-except-notebooks

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** deny on match, allow otherwise
  **Package:** `datadog.ingress.readonly_except_notebooks`

  ## What it does

  Keeps Datadog read-only for the agent, with one exception: it can create and edit
  notebooks. That's enough for an agent to investigate an incident and write up what it
  found, without being able to change the dashboards, monitors, and settings your on-call
  team relies on.

  - **Reads pass.** Searching and aggregating logs, spans, metrics, events, RUM, monitors,
    incidents, hosts, and dashboards is untouched.
  - **Writes are denied.** Any Datadog tool whose name contains a mutating verb (`create`,
    `edit`, `update`, `upsert`, `delete`, `mute`, `resolve`, …) is blocked — for example
    `upsert_datadog_dashboard`.
  - **Notebook create and edit are allowed.** `create_datadog_notebook` and
    `edit_datadog_notebook` go through. Deleting a notebook is still blocked.

  ## Compliance alignment

  - **SOC 2 CC6.1; CC6.3** — least privilege on the agent channel: read access plus the one
    write the investigation workflow needs.
  - **SOC 2 CC7.2** — protects the monitoring configuration (monitors, dashboards) that the
    organization uses to detect anomalies.

  ## Why ingress

  A changed monitor or dashboard takes effect immediately and can silence an alert. Whether a
  call is a write is decided by its tool name, so ingress can stop it before Datadog sees it.

  ## How it matches

  A tool is in scope when its lowercased name starts with `datadog` (the MCP server name on
  the gateway). It is a write when any `-` / `_`-separated token in its name is a mutating
  verb. Matching verbs instead of a fixed tool list means new Datadog write tools are blocked
  without a policy edit. The notebook exception requires the token `notebook` plus `create`,
  `edit`, or `update`, and no destructive verb.

  Datadog ships **MCP Write Access** switched off. Even with it off this policy is a useful
  safety net, and it is what lets you turn write access on for notebooks without also handing
  over dashboards and monitors.

  ## Examples

  ### Allowed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "datadog-create_datadog_notebook", "type": "tool" },
      "payload": { "args": { "name": "checkout-api 5xx spike, Oct 11" } }
    }
  }
  ```

  `allow = true`, no reason.

  ### Denied

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "datadog-upsert_datadog_dashboard", "type": "tool" },
      "payload": { "args": { "title": "Checkout" } }
    }
  }
  ```

  `allow = false`, `reason = "Blocked: Datadog is read-only through this gateway. The only change allowed is creating or editing a notebook. Ask your admin if you need a dashboard, monitor, or setting changed."`.

  ## Composition

  Pairs with [`datadog/cap-search-window`](../cap-search-window/policy.md) (ingress transform on
  reads) and [`datadog/redact-secrets-egress`](../redact-secrets-egress/policy.md) (egress
  redaction).

  ## Known limitations

  - **Server name prefix.** Scope is tools whose name starts with `datadog`. If your Datadog
    MCP server is registered under another name, change `_is_datadog`.
  - **Verb-token heuristic.** A future Datadog tool that changes state without a verb from
    `_write_verbs` in its name would pass. Add the verb if that happens.
  - **Notebook content is not inspected.** Notebooks are shared inside your Datadog org; pair
    with an egress or DLP policy if what gets written matters.

  > **Compliance note.** This policy supports alignment with the cited framework controls **on the MCP path only**. No policy or bundle makes an organization compliant with any framework; web-UI, native-API, and in-app access are outside the gateway's reach by design. Validate against your own compliance program before relying on it.
direction: ingress
apps:
  - datadog
industries: []
bundles:
  - engineering-stack-jira
  - engineering-stack-linear
experimental: true
schemaVersion: 1.0.0
minimumGatewayVersion: 1.0.0b24
---

```rego
package datadog.ingress.readonly_except_notebooks

# Allow by default; deny Datadog write tools except notebook create/edit.
# Non-Datadog tools are never touched.
default allow := true

_tool := lower(object.get(input.resource, "name", ""))

# Scope: tools served by an MCP server whose gateway name starts with "datadog".
_is_datadog if startswith(_tool, "datadog")

_tokens := {t | some t in regex.split(`[-_]`, _tool)}

# Verbs that change state in Datadog.
_write_verbs := {
    "create", "edit", "update", "upsert", "delete", "remove", "add", "set",
    "patch", "write", "mute", "unmute", "resolve", "cancel", "schedule",
    "enable", "disable", "submit", "send", "trigger", "archive", "import",
    "clone", "assign", "unassign", "snooze", "acknowledge", "ack", "restore",
    "revoke", "rotate", "publish",
}

# Verbs that destroy or hide data — never part of the notebook exception.
_destructive_verbs := {"delete", "remove", "archive", "revoke"}

_is_write_tool if {
    _is_datadog
    some t in _tokens
    _write_verbs[t]
}

_is_notebook_write if {
    "notebook" in _tokens
    some v in {"create", "edit", "update"}
    v in _tokens
    count(_tokens & _destructive_verbs) == 0
}

allow := false if {
    _is_write_tool
    not _is_notebook_write
}

reason := "Blocked: Datadog is read-only through this gateway. The only change allowed is creating or editing a notebook. Ask your admin if you need a dashboard, monitor, or setting changed." if {
    _is_write_tool
    not _is_notebook_write
}
```
