# slack / deny-direct-messages

**Direction:** ingress (`tool_pre_invoke`) · **Package:** `slack.ingress.deny_direct_messages`

Blocks Slack message-write calls addressed to a direct conversation (1:1 DM, user-ID-as-channel, or group DM). Posts to regular channels, and every non-write Slack tool, pass through untouched.

## What it does

The policy is `default allow := true` and denies a call only when all three hold:

- **Slack-server scoping** — the first hyphen-separated segment of the tool name starts with `slack`.
- **Write-tool detection** — the tool name ends with a known message-write suffix (post/send, update/edit, scheduled, ephemeral, me-message families, with `-`, `_`, and concatenated variants).
- **DM-recipient detection** — the destination is identified by Slack ID prefixes: on the channel argument (`channel`, `channel_id`, `channelId`) a `D` (1:1 DM), `U`/`W` (user ID — Slack auto-opens a DM), or `G` (group DM) value; on a dedicated recipient argument (`user`, `user_id`, `userId`) a user ID (`U`/`W`).

A denied call returns: *"Sending direct messages via Slack is not permitted via this gateway. Contact your InfoSec team if this needs to change."*

## When to use it

Use this to keep Slack usage to channels and prevent DMs (which are harder to audit) from being sent through the gateway, while leaving normal channel posting available.

## Assumptions

- Recipients are matched by Slack **ID prefix**, not by name; the policy fails open on uncertainty rather than over-blocking. A plain-name recipient or an unrecognized argument name won't be matched — add it to the recipient lookups if needed.
- Tool names are matched by **suffix** for portability across gateway MCP-server naming. Confirm exact tool and argument names with the dump-input debug technique, and extend `write_tool_suffixes` if your server differs.

## Tests

See [`tests/`](./tests/):

- [`allow.json`](./tests/allow.json) — posting to a regular channel is allowed.
- [`deny.json`](./tests/deny.json) — posting to a 1:1 DM channel is denied with a reason.

## Composition

Part of the [`slack`](../../../bundles/slack/README.md) bundle. Single-purpose and `default allow := true`, so it composes cleanly with other Slack ingress policies such as [`block-secrets`](../block-secrets/policy.md) and [`deny-channel-creation`](../deny-channel-creation/policy.md).
