# Docusign policies

Reusable DTwo policies for Docusign MCP servers — the official remote Docusign MCP Server (`https://mcp.docusign.com/mcp`, the same server behind the Claude / Claude Cowork connector) plus the community `luthersystems/mcp-server-docusign` and CData read-only SQL implementations. The MCP surface spans directory and profile reads (`getUsers`, `getUserInfo`), envelope and agreement reads that carry filled tab values and AI-extracted contract terms (`getEnvelope`, `listRecipients`, `getAllAgreements`, `getAgreementDetails`), externally visible writes (`createEnvelope` with `status: "sent"`, `updateEnvelopeRecipients`, `sendReminder`), workflow controls (`triggerWorkflow`, `cancelWorkflowInstance`, `pauseNewWorkflowInstances`), and — on community servers — whole-PDF export (`download_envelope_document`). Its risk profile is dominated by *legally significant, irreversible action*: a `status: "sent"` envelope emails a real signature request to counterparties under your company's brand, a void permanently invalidates an executed record, and envelopes are PII by construction and routinely carry financial terms, PHI, or SSN/bank tab values — making Docusign a standing SOX/HIPAA evidence surface.

## Available policies

| Policy | Direction | Purpose | Framework bundles |
| ------ | --------- | ------- | ----------------- |
| [force-draft-envelopes](./force-draft-envelopes/policy.md) | ingress | Rewrite envelope-creation calls to `status: "created"` (draft) instead of `"sent"` unless the caller is in the `esign-senders` group; agents stage, humans dispatch. | soc2, sox |
| [guard-external-recipients](./guard-external-recipients/policy.md) | ingress | Deny envelope-creation and recipient-update calls that route any recipient to a domain outside the counterparty allowlist, naming each offending address. | soc2, gdpr-ccpa, hipaa |
| [freeze-destructive-ops](./freeze-destructive-ops/policy.md) | ingress | Deny irreversible operations — `updateEnvelope` voids, `cancelWorkflowInstance`, `pauseNewWorkflowInstances` — except for the `contract-ops` group. | sox, soc2, hipaa, gdpr-ccpa |
| [redact-tab-values-egress](./redact-tab-values-egress/policy.md) | egress | Redact SSN, US bank routing/account numbers, and Luhn-validated payment-card PANs in envelope- and agreement-read responses (transform-only). | soc2, hipaa, gdpr-ccpa, pci-dss |
| [cap-directory-and-document-egress](./cap-directory-and-document-egress/policy.md) | egress | Truncate `getUsers` directory listings to 25 rows for non-admins and deny community `download_envelope_document` base64-PDF export unless the caller is in `contracts-read`. | soc2, hipaa, gdpr-ccpa |

## Tool naming on the DTwo gateway

The official Docusign server sends camelCase, no-prefix tool names on the wire (`createEnvelope`, `updateEnvelope`, `getUsers`, `getAllAgreements`); a DTwo gateway prepends the configured server name (e.g. `docusign-createEnvelope`). The community `luthersystems` server uses snake_case with richer verbs (`create_envelope_from_template`, `download_envelope_document`), and CData uses a `{servername}_run_query` prefix pattern. The policies here match on the *suffix* (`createenvelope`, `create_envelope`, `updateenvelope`, `getusers`, `download_envelope_document`, etc.) and lower-case the tool name so they stay portable across both naming conventions — but confirm the exact tool name your gateway sends using the dump-input debug technique before deploying. Per-tool JSON schemas for the official server are not published on a static page; the argument-shape assumptions in each policy are drawn from the mapped REST bodies and should be verified against a live `tools/list` before relying on exact-match behavior.

## Identity claims

The identity-gated policies read `input.subject.claims.groups` with **placeholder** group names: `esign-senders` (force-draft-envelopes), `contract-ops` (freeze-destructive-ops), and `admin` / `contracts-read` (cap-directory-and-document-egress). Replace these with your own IdP group names at import time. Missing or empty claims fail closed for grants — no group means not exempt (still forced to draft, still denied the void, still truncated, still denied the download). `guard-external-recipients` and `redact-tab-values-egress` require no claims.

## Contributing

To add a Docusign policy:

1. Create `apps/docusign/<policy-slug>/` with `policy.md` and a `tests.yaml` test file.
2. Add a row to the table above.
3. Declare `apps: ["docusign"]` in the policy frontmatter, plus any industry / bundle slugs that apply.
4. Tag any framework bundle slugs the description backs with a control citation (`soc2`, `hipaa`, `pci-dss`, `gdpr-ccpa`, `sox`) in the policy frontmatter `bundles` field; if a matching thematic bundle landing page exists under [`bundles/`](../../bundles/), link to it.
5. Run `pnpm manifest` from the repo root.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full process.
