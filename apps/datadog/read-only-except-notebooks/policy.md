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
  - **Everything else is denied.** A Datadog tool only goes through if its name reads as a
    lookup (`search`, `get`, `list`, `aggregate`, `analyze`, `query`, …) and has no
    state-changing verb in it. So `upsert_datadog_dashboard`, `execute_datadog_workflow`,
    `move_datadog_log_pipeline`, `reorder_…_rules`, and `run_datadog_bits_agent` are all
    blocked, and so is any new tool whose name doesn't clearly say it only reads.
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
  the gateway). Its name is split into `-` / `_`-separated tokens, and it is allowed only when:

  - at least one token is a read verb from `_read_verbs` (`search`, `get`, `list`, `query`,
    `aggregate`, `analyze`, `describe`, `validate`, …), **and**
  - no token is a state-changing verb from `_write_verbs` (`create`, `update`, `execute`,
    `move`, `reorder`, `recover`, `link`, `sync`, `start`, …).

  This fails closed: the Datadog server has well over a hundred tools and keeps adding write
  tools with new verbs, so a tool is denied unless its name clearly says it only reads. The
  notebook exception requires the token `notebook` plus `create`, `edit`, or `update`, and no
  destructive verb. A few short helper tools with no verb in their name (`dd_gff`, `dd_guc`,
  `dd_rfw`) are allowed by name in `_helper_tools`.

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
  - **Verb-token heuristic.** A new read tool whose name uses a verb that isn't in
    `_read_verbs` is denied until you add the verb. A write tool would only pass if its name
    has a read verb and none of the `_write_verbs` — add the verb if that happens.
  - **Code execution.** `execute_code` and similar tools are denied, even though some of
    what they run only reads.
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

# Allow by default; deny any Datadog tool that isn't clearly a read, except
# notebook create/edit. Non-Datadog tools are never touched.
default allow := true

_tool := lower(object.get(input.resource, "name", ""))

# Scope: tools served by an MCP server whose gateway name starts with "datadog".
_is_datadog if startswith(_tool, "datadog")

_tokens := {t | some t in regex.split(`[-_]`, _tool)}

# Verbs that mark a tool as a lookup. A Datadog tool needs one of these to pass.
_read_verbs := {
    "search", "get", "list", "aggregate", "analyze", "analyse", "query", "describe",
    "find", "discover", "read", "validate", "estimate", "check", "diagnose", "explore",
    "rank", "summarize", "summary", "suggest", "build", "ask", "optimize", "load",
    "recommendations",
}

# Verbs that change state in Datadog. Any one of these denies the tool, even if
# it also has a read verb. ("run" is left out: ddsql_run_query only reads, and
# run_datadog_bits_agent is still denied because it has no read verb.)
_write_verbs := {
    "create", "edit", "update", "upsert", "delete", "remove", "add", "set",
    "patch", "write", "mute", "unmute", "resolve", "cancel", "schedule",
    "enable", "disable", "submit", "send", "trigger", "archive", "import",
    "clone", "assign", "unassign", "snooze", "acknowledge", "ack", "restore",
    "revoke", "rotate", "publish", "execute", "exec", "move", "reorder",
    "recover", "attach", "detach", "link", "unlink", "start", "stop", "conclude",
    "sync", "mitigate", "manage", "steer", "apply", "approve", "merge", "invite",
    "pause", "resume", "install", "uninstall", "register", "deploy", "rollback",
    "promote", "reset", "retry", "rerun", "restart", "terminate", "kill", "purge",
    "upload", "post", "put", "save", "toggle",
}

# Short Datadog helper tools with no verb in their name, allowed by name.
_helper_tools := {"dd_gff", "dd_guc", "dd_rfw"}

# Verbs that destroy or hide data — never part of the notebook exception.
_destructive_verbs := {"delete", "remove", "archive", "revoke"}

_has_read_verb if {
    some t in _tokens
    _read_verbs[t]
}

_has_write_verb if {
    some t in _tokens
    _write_verbs[t]
}

_is_helper_tool if {
    some h in _helper_tools
    endswith(replace(_tool, "-", "_"), h)
}

_is_read_tool if {
    _has_read_verb
    not _has_write_verb
}

_is_read_tool if _is_helper_tool

# Fail closed: every Datadog tool that isn't clearly a read counts as a write.
_is_write_tool if {
    _is_datadog
    not _is_read_tool
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
