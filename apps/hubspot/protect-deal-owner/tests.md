---
- description: Deal update with no owner field (other properties only). Policy should allow.
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
- description: Deal update sets hubspot_owner_id (owner reassignment). Policy
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
              properties:
                hubspot_owner_id: "99887766"
  output:
    expectedResult: deny
    expectedReason: Changing the owner of a deal is not permitted
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
