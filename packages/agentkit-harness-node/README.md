# @kingsoftcloud/agentkit-harness-node

Standalone Native Harness Node adapters: a durable **SQLite run store** and a
**one-request model HTTP port**, packaged as an independently installable Node
module. It ships the Native Node adapters in this package and externalizes [`@kingsoftcloud/agentkit-harness-core`](../agentkit-harness-core)
for the kernel, contracts, transitions and durable execution. It has **no
Studio/DSH runtime dependency** and **does not duplicate the core kernel**.

## Public surface

```js
import { SqliteRunStore, createNativeModelPort, nativeModelRecoveryPolicy }
  from '@kingsoftcloud/agentkit-harness-node';
```

- `SqliteRunStore` — a `TransactionalRunStore` backed by `node:sqlite` with WAL,
  full synchronous commits, append-only events and immutable ledger items. Host
  recovery discovery (`listScopes`) returns only scope identities.
- `createNativeModelPort({ resolveProfile, fetchImpl?, maxResponseBytes?,
  idleTimeoutMs? })` — one host-resolved HTTP request per attempt. Streams
  text/thinking/tool_delta display deltas and seals a single `ModelResult`. The
  adapter never retries and never executes tools; the kernel owns backoff,
  call budgets and tool execution. Credentials travel only in headers.
- `nativeModelRecoveryPolicy({ protocol, parameters })` — returns
  `'pure-inference/v1'` for the plain inference protocols with no parameter
  extensions, else `'manual'`. Used as `RunConfiguration.modelRecoveryPolicy`.

## External process

The package also ships the `agentkit-native-rpc` bin and `./rpc-entry` export.
It uses versioned JSON-RPC 2.0 over NDJSON on stdin/stdout for `initialize`,
`task/submit`, `task/status`, `task/subscribe`, `task/cancel`, and `task/resume`.
Supply a separate durable business `requestId` on submission. Keep both the run
database and the request ledger across restarts; unknown writes are never
blindly replayed. An ended task with `outcome: unverified` is not validated success.

Set `NATIVE_MODEL_PROTOCOL`, `NATIVE_MODEL_BASE_URL`, `NATIVE_MODEL_API_KEY`, and
`NATIVE_MODEL_NAME`, then start:

```sh
agentkit-native-rpc --db ./runs.sqlite --ledger ./requests.sqlite \
  --workspace ./workspace --permissions workspace:read
```

The workspace must exist. No filesystem permissions are granted by default.
Startup bindings are frozen; recovery rejects changed bindings. This is a local
child-process interface for language-neutral clients, not a Python SDK or a
network multi-tenant server. One host process owns each store.

## Build

```
node scripts/build-native-node.mjs
```

esbuild bundles `src/index.mjs` (which re-exports the shared adapters from the
workspace) into `dist/index.mjs`, externalizing `@kingsoftcloud/agentkit-harness-core`
and Node builtins. The build asserts, from the esbuild metafile, that the
adapter closure contains only `packages/agentkit-harness/src/native/` adapter
sources and no Studio/DSH/host code.

## Install (local tarball)

The package is `private` and is consumed from local tarballs; it is not
published. `scripts/verify-native-standalone.mjs` packs both
`@kingsoftcloud/agentkit-harness-core` and this package, installs them into a
fresh temp directory, and drives a standalone example host against the
installed packages.

## License

Apache-2.0 (see `LICENSE`). `NOTICE` documents the dependency/license audit:
no third-party source is bundled.
