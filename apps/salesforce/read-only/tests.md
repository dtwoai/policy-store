---
- description: Call to an allowlisted Salesforce read tool (soqlquery). Policy should allow.
  input:
    action: tool_pre_invoke
    kind: tool_pre_invoke
    mode: input
    resource:
      type: tool
      name: salesforce-soqlquery
      uri: null
    payload:
      name: salesforce-soqlquery
      args:
        q: SELECT Id, Name FROM Account
  output:
    expectedResult: allow
- description: Call to a Salesforce write tool (createsobjectrecord). Policy
    should deny with a reason.
  input:
    action: tool_pre_invoke
    kind: tool_pre_invoke
    mode: input
    resource:
      type: tool
      name: salesforce-createsobjectrecord
      uri: null
    payload:
      name: salesforce-createsobjectrecord
      args:
        sobject-name: Account
        body:
          Name: Acme
  output:
    expectedResult: deny
    expectedReason: write operations (create/modify) are blocked
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
