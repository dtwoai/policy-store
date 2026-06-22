---
- description: Reading a non-sensitive channel's history. Policy should allow.
  input:
    action: tool_pre_invoke
    kind: tool_pre_invoke
    mode: input
    resource:
      type: tool
      name: slack-mcp-conversations-history
      uri: null
    payload:
      name: slack-mcp-conversations-history
      args:
        channel: C0PUBLIC001
        limit: 50
  output:
    expectedResult: allow
- description: Reading a sensitive channel's history (channel arg matches the
    configured ID). Policy should deny with a reason.
  input:
    action: tool_pre_invoke
    kind: tool_pre_invoke
    mode: input
    resource:
      type: tool
      name: slack-mcp-conversations-history
      uri: null
    payload:
      name: slack-mcp-conversations-history
      args:
        channel: SLACK_CHANNEL_ID
        limit: 50
  output:
    expectedResult: deny
    expectedReason: is not permitted via this gateway
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
