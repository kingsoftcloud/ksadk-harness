# Changelog

## 0.0.8 - 2026-11-02

- Preserve absent optional diagnostic codes when projecting nested failures, so
  uncertain Skill event evidence remains unchanged. Add a portable adapter
  regression for the consumer integration case found while validating 0.0.7.
- Includes the Workspace diagnostic, archive validation and release guard fixes
  from 0.0.7. Studio should consume this revision.

## 0.0.7 - 2026-11-02

- Sanitize every Workspace failure result, including authorization, filesystem
  and parser diagnostics. Preserve successful file data and execution evidence.
- Recursively project nested failure diagnostics and Error causes/stacks, with
  bounded traversal for cyclic or excessively deep payloads.
- Validate tar member types, canonical paths, duplicates, checksums and the full
  npm file set before extracting release archives.
- Restrict npm publishing and manual retries to a published version-tag Release
  identifying the exact source commit and all three package versions.

## 0.0.6 - 2026-11-01

- Add shared diagnostic projection and public package-integrity verification.
- Recover RPC terminal receipts without executing an operation twice; tolerate
  transient SQLite sidecar unlinking while rejecting unsafe links or main-file drift.
- Verify exports, executable entries, installed archive contents and package boundaries.
- Move portable Core/Node implementation regressions into this repository and
  remove the reverse synchronization of implementation sources from Studio.

## 0.0.2 - 2026-10-30

Switch npm publishing to GitHub Actions Trusted Publisher (OIDC) and publish
the three packages without a long-lived npm token.

## 0.0.1 - 2026-10-30

Initial public release of the Native Harness Core, Node adapters, and React
task UI packages.
