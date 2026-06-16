# slack / deny-read-search-summarize-sensitive-channels

**Direction:** ingress (`tool_pre_invoke`) · **Package:** `slack.ingress.deny_sensitive_channel_read`

Blocks read, search, and summarize operations against a configurable set of sensitive Slack channels. Every other Slack tool, and every other channel, passes through untouched.

## What it does

The policy is `default allow := true` and denies a call only when all three hold:

- **Slack-server scoping** — the first hyphen-separated segment of the tool name starts with `slack`, so it matches regardless of how the Slack MCP server is named (`slack-...`, `slack-prod-...`, `slack-mcp-...`).
- **Restricted-tool detection** — the tool name ends with a known suffix across three families: channel history/replies reads, search, and summarize (with `-`, `_`, and concatenated variants).
- **Sensitive-channel detection** — the channel is matched by **ID** against the configured set, both as a direct argument (`channel`, `channel_id`, `channelId`) and as a substring of search-query arguments (`query`, `q`), so channel-mention syntax inside a query (`in:<#C…>`) is also caught.

A denied call returns: *"Reading, searching, or summarizing this Slack channel is not permitted via this gateway. Contact your InfoSec team if this needs to change."*

## When to use it

Use this to keep the contents of specific Slack channels (HR, legal, security incidents, finance, etc.) from being read, searched, or summarized through the gateway, while leaving the rest of Slack usable.

## Assumptions

- Matching is by channel **ID**, not name — these tools receive resolved IDs at call time, so a name-based approach does not fire. Populate the ID set with real channel IDs.
- Tool names are matched by **suffix** for portability across gateway MCP-server naming. Confirm exact tool and argument names with the dump-input debug technique, and extend `restricted_tool_suffixes` / the channel-arg lookups if your server differs.

## Configuration

Edit the `sensitive_channel_ids` set at the top of [`policy.md`](./policy.md). The shipped value `SLACK_CHANNEL_ID` is a placeholder — replace it with your real Slack channel IDs (uppercase, case-sensitive, e.g. `C0B5LHR8DQV`).

## Tests

See [`tests/`](./tests/):

- [`allow.json`](./tests/allow.json) — reading a non-sensitive channel is allowed.
- [`deny.json`](./tests/deny.json) — reading a sensitive channel's history is denied with a reason.

## Composition

Part of the [`slack`](../../../bundles/slack/README.md) bundle. Single-purpose and `default allow := true`, so it composes cleanly with other Slack ingress policies such as [`block-secrets`](../block-secrets/policy.md) and [`deny-channel-creation`](../deny-channel-creation/policy.md).
