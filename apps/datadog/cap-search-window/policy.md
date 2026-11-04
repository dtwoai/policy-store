---
name: Cap the Time Window of Datadog Searches
tags:
  - datadog
  - observability
  - data-minimization
  - cost-control
  - ingress
publishedAt: 2026-10-11
description: |
  # datadog / cap-search-window

  **Direction:** ingress (`tool_pre_invoke`)
  **Default:** allow (transform-only, never denies)
  **Package:** `datadog.ingress.cap_search_window`

  ## What it does

  Keeps Datadog searches to a recent window. The agent can search logs, spans, RUM, and events
  as much as it likes, but each call looks back at most **7 days**. One broad prompt like
  "find every log for this user" can't quietly turn into a scan of months of data.

  This is a transform, not a block: when `to` minus `from` is longer than 7 days, `from` is
  moved forward so the window is exactly 7 days. When `to` is missing or `now`, the new `from`
  is written as `now-7d`; otherwise it's an RFC 3339 timestamp 7 days before `to`. Windows of
  7 days or less are left alone, and every other argument passes through unchanged.

  The number of records returned isn't capped here. Datadog already bounds each response with
  `max_tokens` (hard cap 20,000), and an agent reading a burst of errors around a deploy
  should be able to see them.

  Applies to `search_datadog_logs`, `analyze_datadog_logs`, `search_datadog_spans`,
  `aggregate_spans`, `search_datadog_rum_events`, `aggregate_rum_events`,
  `search_datadog_events`, and `aggregate_events`.

  ## Compliance alignment

  - **GDPR Art. 5(1)(c)** — data minimisation: logs often carry personal data, and each
    agent read covers a bounded period.
  - **SOC 2 CC6.1** — limits how much history the agent channel can reach per call.

  ## Why ingress

  The time range is a request argument; trimming it before the query runs means Datadog never
  runs the oversized query.

  ## Time formats understood

  `now`, relative `now-<n><unit>` with units `s`, `m`, `h`, `d`, `w`; RFC 3339 timestamps
  (`2026-10-01T00:00:00Z`); dates (`2026-10-01`); and Unix timestamps in seconds (10 digits)
  or milliseconds (13 digits). A `from` the policy can't parse is left unchanged.

  ## Configuration

  `max_window_days` at the top of the policy. Raise the window to 14 or 30
  days if your incident reviews routinely look further back.

  ## Examples

  ### Window trimmed

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "datadog-search_datadog_logs", "type": "tool" },
      "payload": { "args": { "query": "service:checkout-api status:error", "from": "now-30d" } }
    }
  }
  ```

  `allow = true`, `transform.transformed_payload` has `from: "now-7d"`.

  ### Unchanged

  ```jsonc
  {
    "input": {
      "action": "tool_pre_invoke",
      "resource": { "name": "datadog-aggregate_spans", "type": "tool" },
      "payload": { "args": { "query": "service:checkout-api", "from": "now-4h" } }
    }
  }
  ```

  `allow = true`, no transform.

  ## Composition

  Pairs with [`datadog/read-only-except-notebooks`](../read-only-except-notebooks/policy.md)
  and [`datadog/redact-secrets-egress`](../redact-secrets-egress/policy.md).

  ## Known limitations

  - **Server name prefix.** Scope is tools whose name starts with `datadog`. Change
    `_is_datadog` if your server is registered under another name.
  - **Unparseable times pass.** Formats outside the list above are not rewritten.
  - **Tool defaults.** When `from` is omitted, Datadog's default applies (1 hour for most
    tools, 7 days for RUM), which is already within the cap.

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
package datadog.ingress.cap_search_window

# Transform-only policy — never denies, only bounds how far back a search looks.
default allow := true

max_window_days := 7

_day_ns := 86400000000000

_max_window_ns := max_window_days * _day_ns

_unit_ns := {
    "s": 1000000000,
    "m": 60000000000,
    "h": 3600000000000,
    "d": 86400000000000,
    "w": 604800000000000,
}

# Normalize separators so `search_datadog_logs` and `search-datadog-logs` match alike.
_tool := replace(lower(object.get(input.resource, "name", "")), "-", "_")

_args := object.get(object.get(input, "payload", {}), "args", {})

_is_datadog if startswith(_tool, "datadog")

_windowed_suffixes := {
    "search_datadog_logs", "analyze_datadog_logs",
    "search_datadog_spans", "aggregate_spans",
    "search_datadog_rum_events", "aggregate_rum_events",
    "search_datadog_events", "aggregate_events",
}

_is_windowed if {
    _is_datadog
    some s in _windowed_suffixes
    endswith(_tool, s)
}

_now := time.now_ns()

# --- Time parsing: returns nanoseconds since epoch, undefined if unparseable ---

_parse_time(s) := _now if {
    is_string(s)
    lower(trim_space(s)) == "now"
}

_parse_time(s) := ns if {
    is_string(s)
    m := regex.find_all_string_submatch_n(`^now-(\d+)([smhdw])$`, lower(trim_space(s)), 1)
    count(m) == 1
    ns := _now - (to_number(m[0][1]) * _unit_ns[m[0][2]])
}

_parse_time(s) := ns if {
    is_string(s)
    regex.match(`^\d{4}-\d{2}-\d{2}T`, trim_space(s))
    ns := time.parse_rfc3339_ns(trim_space(s))
}

_parse_time(s) := ns if {
    is_string(s)
    regex.match(`^\d{4}-\d{2}-\d{2}$`, trim_space(s))
    ns := time.parse_ns("2006-01-02", trim_space(s))
}

_parse_time(s) := ns if {
    is_string(s)
    regex.match(`^\d{10}$`, trim_space(s))
    ns := to_number(trim_space(s)) * 1000000000
}

_parse_time(s) := ns if {
    is_string(s)
    regex.match(`^\d{13}$`, trim_space(s))
    ns := to_number(trim_space(s)) * 1000000
}

# --- Window ---

_raw_to := object.get(_args, "to", "now")

_to_is_now if lower(trim_space(_raw_to)) == "now"

_to_ns := _parse_time(_raw_to)

_from_ns := _parse_time(object.get(_args, "from", null))

_window_too_wide if {
    _is_windowed
    _to_ns - _from_ns > _max_window_ns
}

_new_from := sprintf("now-%dd", [max_window_days]) if _to_is_now

_new_from := time.format([_to_ns - _max_window_ns, "UTC", "2006-01-02T15:04:05Z07:00"]) if not _to_is_now

# --- Transform ---

transform := {"transformed_payload": object.union(_args, {"from": _new_from})} if {
    input.action == "tool_pre_invoke"
    _window_too_wide
}
```
