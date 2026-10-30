# Contributing to KSADK Native Harness

Thanks for helping improve the Native Harness packages. The repository contains
three independently installable npm packages and a private workspace root:

- `@kingsoftcloud/agentkit-harness-core` — host-independent contracts and kernel.
- `@kingsoftcloud/agentkit-harness-node` — Node, SQLite, process and browser adapters.
- `@kingsoftcloud/agentkit-harness-ui` — React task timeline and presentation components.

## Development

Use Node.js `>=22.19.0` and npm. From the repository root:

```sh
npm ci --ignore-scripts
make public-gate
```

The gate builds the packages, runs the Core, Node and UI suites, verifies the
RPC and installed UI boundaries, checks package contents and metadata, audits
the public surface, scans the complete Git history for secrets, and runs the
runtime dependency audit. Keep generated `dist/` and `.artifacts/` output out
of commits.

## Changes and pull requests

Keep changes scoped to the package boundary they affect. New public exports,
protocol fields, recovery behavior, tool permissions and package metadata need
tests and a short README or changelog note when they change consumer behavior.

Pull requests should explain the behavior change, include the commands used for
validation, and call out any compatibility or migration requirement. Do not
include credentials, internal service addresses, customer data, personal paths,
or generated archives in commits.

The `main` branch is protected. Changes land through a reviewed pull request
with the required CI gate passing. Releases are created from a tagged commit;
the npm workflow publishes the three public packages with npm provenance.
