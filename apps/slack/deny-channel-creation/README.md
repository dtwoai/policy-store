# slack / deny-channel-creation

**Direction:** ingress (`tool_pre_invoke`) · **Package:** `slack.ingress.deny_channel_create`

Blocks Slack channel-creation tool calls at the gateway. Every other Slack tool, and every non-Slack tool, passes through untouched.

## What it does

The policy is `default allow := true` and denies a call only when both of these hold:

- **Slack-server scoping** — the first hyphen-separated segment of the tool name starts with `slack`, so it matches regardless of how the Slack MCP server is named on the gateway (`slack-...`, `slack-prod-...`, `slack-mcp-...`).
- **Create-channel detection** — the tool name ends with a known create-channel suffix, covering both verb-first shapes (`-create-conversation`, `-create-channel`, and `_`/concatenated variants) and Slack-API-mirroring shapes (`-conversations.create`, `-conversations-create`, `-conversations_create`).

A denied call returns: *"Creating Slack channels is not permitted via this gateway. Contact your InfoSec team if this needs to change."*

## When to use it

Use this when channel creation should go through a controlled process (request form, admin approval) rather than ad-hoc tool calls, while leaving the rest of Slack usable through the gateway.

## Assumptions

- Tool names are matched by **suffix**, so the policy is portable across gateway MCP-server naming. Confirm the exact names your gateway emits with the dump-input debug technique, and extend `create_channel_suffixes` for any additional channel-creation tool your server exposes.
- The deny is based on the tool name only; no arguments are inspected.

## Tests

See [`tests/`](./tests/):

- [`allow.json`](./tests/allow.json) — a non-create Slack tool is allowed.
- [`deny.json`](./tests/deny.json) — a channel-creation call is denied with a reason.

## Composition

Part of the [`slack`](../../../bundles/slack/README.md) bundle. Single-purpose and `default allow := true`, so it composes cleanly with other Slack ingress policies such as [`block-secrets`](../block-secrets/policy.md).
