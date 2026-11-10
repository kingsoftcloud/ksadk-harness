# Changelog

## 0.0.16 - 2026-11-10

- Expose child-owner shutdown through `ChildLifecyclePort.closeRun` and preserve
  committed approval waits even when the Host disposes at the approval checkpoint.
  Explicit cancellation still cancels the Run and its live descendants.
- Bound command history in model context and the activity view, giving priority
  to unaccounted completions while retaining durable output ownership.
- Clear the required context source error when its paused Run resumes.

## 0.0.15 - 2026-11-09

- Preserve scoped approval outcomes across tool dispatch and keep denied or
  cancelled effects suspended until the Host explicitly resumes the Run.
- Restore paused child joins and keep durable work intact when an idle child
  owner detaches.
- Bound provider diagnostics and preserve task tools across gateway compaction
  and truncated commentary. Guide deferred calls through admitted schemas.
- Show pending file arguments in the task timeline using the same redaction
  rules as settled tools, and stop retrying stale approval offers.
- Resolve an interrupted workspace mutation as unstarted when its original Run
  journal proves publication never began. Keep uncertain writes suspended.
- Preserve durable pending approvals when the DSH Host disposes the idle
  driver during shutdown, so restarting does not turn them into cancellation.

## 0.0.14 - 2026-11-04

- Add opt-in diagnose-before-repeat/v2 admission with a default ten-inference
  tool-diagnosis allowance, independent of unlimited task budgets. Smaller
  configured allowances and explicit null remain supported. Frozen v1 Runs
  retain their original settings; refused actions never dispatch a tool.
- Use one strict Python grammar boundary for command inspection and workspace
  syntax checks. Long Unicode documentation no longer enters Ruff's unsafe
  comment debug renderer; invalid grammar and restricted calls stay guarded.
- Expose committed retry deadlines to the read-only status projection and
  distinguish Host-confirmed model backoff from active context preparation.
  Expired deadlines and inactive owners do not claim a running retry.
- Expose an atomic, read-only SQLite trace view containing compact Run status
  and a cursor-bounded event suffix. Observability consumers no longer need
  to hydrate execution receipts or transcripts to refresh a trace. The view
  does not grant execution authority or change conversation delivery.
- Return scoped discovery guidance when a model calls a deferred tool before
  loading its definition. Rejected calls remain unexecuted, mixed batches do
  not partly dispatch, and unavailable tools never gain a discovery route.
  Feedback follows the admitted direct or wrapper calling convention and
  keeps the existing bounded repair budget.
- Add opt-in response-scoped output restart accounting. An admitted complete
  tool step ends the prior truncation streak; an unbroken truncated response
  remains bounded. Existing Runs retain their frozen accounting policy.
- Freeze the user-facing language preference and propagate it to child owners
  without changing tool permissions or exposing private reasoning.
- Coalesce transient timeline notifications without dropping authoritative
  events. Reuse completed tool rows and mount file diff bodies only when open.
- Hide whitespace-only model rows, retain write identity while arguments stream,
  and use readable task-panel line spacing.
- Fold contiguous file edits into a distinct-file summary, retaining every
  operation and failure in the expandable details. Collapsed edit groups do
  not mount their child rows or diff trees.
- Keep task-list previews within the viewport with usable scroll height and
  make the first click open the preview reliably.
- Commit ownership for persisted foreground command output so its advertised
  task ID can be paged through the normal authorized reader, including after
  a cold restore. Settled foreground commands do not emit a second completion
  notification, and cursor reads never relaunch the process.
- Project confirmed foreground completion from its exact committed launch
  receipt instead of showing an unknown terminal. Rebuild older display caches
  once; unknown or incomplete execution evidence remains unknown.

- Classify known provider error envelopes consistently across Chat, Responses
  and Anthropic JSON/SSE entries. Transient failures use the existing kernel
  retry budget; permanent or unknown failures remain terminal, and partial tool
  arguments never execute. An observed refusal cannot be reopened by a later
  transient error. Provider message bodies are not persisted.
- Add a frozen, opt-in timeout recovery recipe for read-only context sources.
  Retry a timed-out read within the admitted effect budget, discard late data,
  and pause after required-source exhaustion so the same Run can resume with
  fresh context. Permanent binding errors and caller cancellation do not retry;
  source recipes without this policy retain their historical behavior. Workspace
  instruction readers and child restoration bind the same explicit recipe.

## 0.0.13 - 2026-11-04

- Publish the aligned 0.0.13 version across Core, Node and UI. All three
  registry packages identify source commit
  `3687a3bd9f0854d5b7106dc18d9e1c0f24cf47da`.
- This is the published baseline for 0.0.14 and retains the model and runtime
  integration described below.

## 0.0.12 - 2026-11-04

- Integrate the 0.0.10 model compatibility, consecutive retry recovery,
  adaptive compaction and shared resource profiles with the current main line.
- Retain the already merged 0.0.11 history-delivery implementation unchanged.
  Align Core, Node and UI and their internal dependencies on a new version so
  consumers need not choose between the two previously published lineages.

## 0.0.10 - 2026-11-03

- Admit provider-compat/v3 for new Runs: tolerate empty streamed identity deltas,
  accept known MiniMax clean EOF only with finish and usage evidence, preserve
  required GLM reasoning, and project literal types for strict tool-schema dialects.
  Earlier admitted compatibility policies retain their wire behavior.
- Add opt-in adaptive summary budgets and smaller quotes after output exhaustion;
  exhausted summaries pause with their source history intact and can resume.
- Add local-development/v2 with a 900-second CPU budget; explicit Host limits and
  earlier resource profiles retain their values. Allow up to ten provider retries.
- Keep Core, Node and UI package versions aligned; this release has no UI changes.

- Add opt-in `providerRecoveryPolicy: 'provider-recovery/v2'`. Provider
  retries count consecutive failures (any provider response resets the
  streak) instead of accumulating over the whole Run, and exhaustion pauses the
  Run with `reason: 'provider_unavailable'` so the Host can `resume` it with a
  fresh budget. Runs without the policy keep the existing behaviour.

## 0.0.9

- Apply shared diagnostic projection to public Skill disclosure, approval and uncertain tool results, including related Web, command, Memory, A2A and child boundaries; preserve successful output and execution identities.
- Redact bare credentials by structured field/header names, including nested objects and arrays.
- Fail publishing retries when existing npm package source or archive integrity differs from the tested release; verify all packages before publishing and retain release receipts.
- Bind runtime and peer dependency archives to lockfile and registry integrity, verify installed hoisted/nested files, and reject missing evidence or modified dependencies.

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
