---
- description: Updating a deal to an open stage (not a closed stage). Policy should allow.
  input:
    action: tool_pre_invoke
    kind: tool_pre_invoke
    mode: input
    resource:
      type: tool
      name: hubspot-manage-crm-objects
      uri: null
    payload:
      name: hubspot-manage-crm-objects
      args:
        updateRequest:
          objects:
            - objectType: deals
              id: "12345"
              properties:
                dealstage: qualifiedtobuy
  output:
    expectedResult: allow
- description: Updating a deal to a closed stage (closedwon). Policy should deny
    with a reason.
  input:
    action: tool_pre_invoke
    kind: tool_pre_invoke
    mode: input
    resource:
      type: tool
      name: hubspot-manage-crm-objects
      uri: null
    payload:
      name: hubspot-manage-crm-objects
      args:
        updateRequest:
          objects:
            - objectType: deals
              id: "12345"
              properties:
                dealstage: closedwon
  output:
    expectedResult: deny
    expectedReason: Closing deals is not allowed
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
