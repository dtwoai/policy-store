---
- description: Egress response from a JIRA tool that is NOT an issue-view tool.
    Out of scope, so the policy applies no transform and the response is
    returned unchanged.
  input:
    action: tool_post_invoke
    kind: tool_post_invoke
    mode: output
    resource:
      type: tool
      name: atlassian-jira-mcp-getjiraproject
      uri: null
    tool_metadata:
      name: atlassian-jira-mcp-getjiraproject
    payload:
      name: atlassian-jira-mcp-getjiraproject
      result:
        key: OPS
        name: Operations
  output:
    expectedResult: allow
  transformApplied: false
- description: Egress response from a JIRA issue-view tool. Policy is in scope, so
    it returns a redaction transform that masks secrets/PII in the response
    body.
  input:
    action: tool_post_invoke
    kind: tool_post_invoke
    mode: output
    resource:
      type: tool
      name: atlassian-jira-mcp-getjiraissue
      uri: null
    tool_metadata:
      name: atlassian-jira-mcp-getjiraissue
    payload:
      name: atlassian-jira-mcp-getjiraissue
      result:
        key: OPS-1421
        fields:
          summary: Prod DB outage runbook
          description: "Connect with postgres://svc:Sup3rSecret@db.internal:5432/app and
            the api_key: sk_live_abcdef0123456789abcdef01. Oncall reachable at
            jane@corp.example."
          connection_string: Server=db.internal;User Id=svc;Password=Sup3rSecret;
  output:
    expectedResult: allow
  transformApplied: true
  transform:
    replacement: "[REDACTED]"
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
