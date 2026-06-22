---
- description: Contact update with no lifecyclestage field (other properties
    only). Policy should allow.
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
            - objectType: contacts
              id: "12345"
              properties:
                email: lead@example.com
  output:
    expectedResult: allow
- description: Contact update sets lifecyclestage. Policy should deny with a reason.
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
            - objectType: contacts
              id: "12345"
              properties:
                lifecyclestage: customer
  output:
    expectedResult: deny
    expectedReason: Changing the lifecycle stage of a contact is not permitted
---

# Test fixtures

These fixtures are defined in the YAML frontmatter above and run by `pnpm test`
(`scripts/test-policies.mjs`) against the policy in `policy.md`.
