# Governance

This document describes how the DTwo Policy Store is governed: who maintains
it, how decisions are made, and how the contribution model will evolve.

## Model: steward-led, curated catalog

The DTwo Policy Store is an **open, steward-led project**. **DTwo, Inc.** is the
steward and current maintainer. The catalog is intentionally **curated**: every
policy that ships here is reviewed by DTwo maintainers for correctness, PARC
compatibility, security, and documentation quality before it is published.

Curation is a **feature, not a gate**. The value of the catalog is that a
security team can trust that each policy compiles, passes its tests, and has
been reviewed against a published checklist — not that anyone can publish
anything. We are explicit about what that review does and does not guarantee in
[SECURITY.md](./SECURITY.md) and the repository README.

## Roles

- **Maintainers** — members of the DTwo maintainers team
  (`@dtwoai/policy-store-maintainers`). Maintainers review and merge changes,
  triage issues, author policies, cut releases, and own the direction of the
  catalog. Maintainers are the code owners (see
  [`.github/CODEOWNERS`](./.github/CODEOWNERS)).
- **Contributors** — anyone who proposes a policy, files an issue, or opens a
  pull request. Contributions are welcome (see
  [CONTRIBUTING.md](./CONTRIBUTING.md)); contribution does not by itself confer
  maintainer status.

## How contributions are accepted (launch model)

At launch, the catalog is **curated-only**: external pull requests are **not
merged directly**. Because these policies run inside other people's decision
paths, we do not merge arbitrary external Rego until an automated trust gate
(`opa check` + test execution + a security-review checklist, enforced in CI)
is in place.

During the curated-only phase:

1. **Propose** a policy by opening an issue describing the app, the problem, the
   intended `allow`/`deny`/`transform` behavior, and example inputs.
2. A **maintainer authors or transcribes** the policy, runs it through review,
   and merges it. Proposers are credited.
3. External PRs may be opened for discussion, but merge access is restricted to
   maintainers and enforced by branch protection and `CODEOWNERS`.

This posture is **deliberately temporary**. The project graduates to open,
DCO-signed external pull requests **when the automated trust gate exists** — the
trigger is the existence of the gate, not a fixed date.

## Decision-making

- **Routine changes** (a new or updated policy, doc fixes) are decided by
  maintainer review under `CODEOWNERS`: at least one maintainer approval and a
  green CI run.
- **Significant changes** (the schema/PARC contract, the manifest format,
  licensing, governance, or the contribution model) require maintainer
  consensus. When consensus cannot be reached, the DTwo maintainers team lead
  makes the final call. Such changes should be proposed in an issue first.

## Licensing and sign-off

- The catalog is licensed under **Apache-2.0** (see [LICENSE](./LICENSE) and
  [NOTICE](./NOTICE)).
- All contributions are made under the **Developer Certificate of Origin
  (DCO)** — contributors sign off their commits (`git commit -s`). See
  [CONTRIBUTING.md](./CONTRIBUTING.md#developer-certificate-of-origin-dco).
- "DTwo" is a trademark of DTwo, Inc.; the license covers copyright only.

## Code of conduct

Participation is governed by our
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Changing this document

Changes to governance follow the "significant changes" path above: propose in
an issue, reach maintainer consensus, and update this file via pull request.
