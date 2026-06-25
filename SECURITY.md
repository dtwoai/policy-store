# Security Policy

The DTwo Policy Store is a catalog of **example security policies** (OPA/Rego)
for the DTwo MCP Gateway. Because these policies are imported into other
people's decision paths, we take defects in them seriously. This document
explains **what is in scope here, what belongs to the closed product's process,
and how to report each.**

## Scope — read this first

This repository and the DTwo gateway **product** have separate disclosure
processes. Please route your report to the right place:

### In scope for this repository

Defects in the **catalog policies and tooling** published here, including:

- **Policy evasion / false negatives** — an input that a catalog policy claims
  to block, redact, or rewrite but does not (e.g., a secret that slips past
  `apps/slack/block-secrets`).
- **False positives / over-blocking** — a benign input a catalog policy
  wrongly denies or mangles.
- **Incorrect or misleading policy documentation** — a policy's `description`
  or tag that overstates what the Rego actually enforces.
- **Vulnerabilities in the repository tooling** — the manifest generator,
  CI workflows, or anything under `scripts/` and `.github/`.

### Out of scope here — route to the product process

Vulnerabilities in the **DTwo MCP Gateway product itself** (the engine that
evaluates policies, its APIs, auth, tenancy isolation, hosting, or any
non-public component) are **not** handled in this public repository. Report
those privately to **[security@dtwo.ai](mailto:security@dtwo.ai)** so they are not disclosed in a public
issue. Do not open a public issue or PR for a product vulnerability.

## How to report

**For in-scope issues that are themselves sensitive** (for example, a working
evasion that affects a widely used policy), please report **privately**, not in
a public issue:

1. **Preferred:** open a private report via GitHub's
   **[Security Advisories / Private Vulnerability Reporting](https://github.com/dtwoai/dtwo-policy-store/security/advisories/new)**
   for this repository.
2. **Alternative:** email **[security@dtwo.ai](mailto:security@dtwo.ai)** with the details below.

For ordinary, non-sensitive correctness bugs (a clear false positive, a typo in
a policy doc), a normal **GitHub issue** is fine.

Please include:

- The affected policy path (e.g., `apps/slack/block-secrets/`) and ref/commit.
- A minimal PARC input that demonstrates the problem, and the
  `allow`/`reasons`/`transform` result you observed.
- The result you expected, and why.
- The OPA version you tested with, if applicable.

## Our commitments

- We aim to **acknowledge** a report within **3 business days**.
- We will work with you to confirm the issue, agree on a fix, and credit you in
  the fix (unless you prefer to remain anonymous).
- We ask that you give us a reasonable opportunity to address the issue before
  any public disclosure.

## Safe harbor

We will not pursue or support legal action against anyone who reports a
security issue in good faith, follows this policy, avoids privacy violations
and service disruption, and does not access or modify data that is not theirs.

## A note on the trust model

These policies are reviewed by DTwo maintainers, but they are **starting
points and examples, not warranties**. They compile and pass their own tests
and a maintainer review, but you are responsible for validating that a policy
meets your requirements before relying on it. See the repository README's trust
model and each policy's `description` (in its `policy.md` frontmatter) for its
specific limits and assumptions.
