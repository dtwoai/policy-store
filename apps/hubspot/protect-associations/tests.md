---
- description: Object update with no associations array. Policy should allow.
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
                amount: "500"
  output:
    expectedResult: allow
- description: Update carries a non-empty associations array on a deal. Policy
    should deny with a reason.
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
              associations:
                - to:
                    id: "67890"
                  types:
                    - associationCategory: HUBSPOT_DEFINED
                      associationTypeId: 5
  output:
    expectedResult: deny
    expectedReason: Modifying associations is not permitted
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
