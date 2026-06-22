---
- description: SOQL query targeting an allowlisted object (Account). Policy should allow.
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
        q: SELECT Id, Name FROM Account WHERE Industry = 'Tech'
  output:
    expectedResult: allow
- description: SOQL query targeting a non-allowlisted object (User). Policy should
    deny with a reason.
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
        q: SELECT Id, Username FROM User
  output:
    expectedResult: deny
    expectedReason: only permits querying Account, Contact, and Opportunity
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
