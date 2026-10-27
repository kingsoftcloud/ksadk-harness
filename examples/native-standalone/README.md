# native-standalone example host

A minimal standalone Native Harness host that uses **only** the public npm
names `@kingsoftcloud/agentkit-harness-core` and
`@kingsoftcloud/agentkit-harness-node` — never Studio or `src/` paths. It drives
the real `NativeKernel` sole loop over a SQLite ledger, exposes actual
read/write workspace tools guarded by permissions, observes committed ledger
events, and supports cancellation plus process-restart continuation.

This is an example, not a product. It favors clarity over completeness.

## How it runs

`host.mjs` is driven by flags. In the fresh-install verifier
(`scripts/verify-native-standalone.mjs`) it is copied into the install dir and
run as a child process so it resolves the public packages from `node_modules`.

```
node host.mjs --db <sqlite-path> --workspace <dir> \
  [--scenario happy|cancel|deny|budget|restart|symlink] \
  [--resume] [--cancel-after MS] [--crash-after-write] \
  [--permissions workspace:read,workspace:write] [--evidence PATH]
```

- **Model:** A clearly-labeled FAKE controlled model is used for the
  deterministic scenarios (`FAKE_SCENARIO=<name>`). A real provider can be
  selected with `NATIVE_MODEL_PROTOCOL` / `NATIVE_MODEL_BASE_URL` /
  `NATIVE_MODEL_API_KEY` / `NATIVE_MODEL_NAME` (and optional
  `NATIVE_MODEL_PROFILE_ID`, `NATIVE_MODEL_COMPAT`, `NATIVE_MODEL_MAX_TOKENS`,
  `NATIVE_MODEL_REQUEST_TIMEOUT_MS`). Credentials travel only in request
  headers and are never written to the evidence JSON or the ledger.
- **Tools:** `read` and `write` are real filesystem operations confined to the
  workspace. `confine` rejects paths outside the root and all symlink
  components, including dangling write targets and parent-directory aliases.
  Final file opens also use `O_NOFOLLOW` where supported. This sample assumes
  another local process is not concurrently replacing workspace directories;
  it is not a sandbox for a hostile shared filesystem.
- **Permissions:** each tool declares required permissions; the host grants a
  per-run set via `--permissions`. A missing permission denies the tool with
  `permission_denied` and no side effect.
- **Restart:** `--crash-after-write` hard-exits (code 7) after the durable write
  but before the kernel commits the tool receipt. A second process with
  `--resume` re-opens the same SQLite ledger, `attach`es, and `runUntilIdle`
  recovers the in-flight write as `effect_outcome_unknown` — it is **not**
  replayed.
- **Evidence:** the host writes a JSON file (no secrets) with the final result,
  tool executions, and the committed ledger events/receipts. `onCheckpoint`
  consumes committed events with a sequence cursor. No task verifier is
  installed, so a final answer remains `unverified`; the acceptance script
  independently checks file contents and operation counts.

## Scenarios

| Scenario | Model script | Expected outcome |
| --- | --- | --- |
| `happy` | read → write → final | `completed` / `unverified`, 2 tools, `out.txt` checked externally |
| `cancel` | hang until abort | `canceled` / `user_canceled`, 0 tools, uncertain receipt |
| `deny` | write → final (no `workspace:write`) | `completed`, write denied, no `out.txt` |
| `budget` | tool call under `maxModelCalls=1`+reserve | `failed` / `budget_exhausted`, 0 tools |
| `restart` | one write, then crash (exit 7) | resume → `interrupted` / `effect_outcome_unknown`, no replay |
| `symlink` | three escaped reads plus dangling/parent-alias writes | all `invalid_path`, no outside reads or writes |

## Verify

```
node scripts/verify-native-standalone.mjs
```

builds and packs both local tarballs, installs them into a fresh temp dir,
asserts neither package imports Studio/DSH, and runs every scenario above as an
actual child process against the packed installation. No npm publish, no cloud
runtime, no real credentials. Set `NATIVE_VERIFY_KEEP=1` to keep the temp dir.

## Run manually from local tarballs

From the repository root, build and pack into a new temporary directory. This
does not publish either package:

```sh
node scripts/build-native-harness.mjs
node scripts/build-native-node.mjs
native_demo_dir=$(mktemp -d)
npm pack ./packages/agentkit-harness-core --ignore-scripts --pack-destination "$native_demo_dir"
npm pack ./packages/agentkit-harness-node --ignore-scripts --pack-destination "$native_demo_dir"
cp examples/native-standalone/host.mjs "$native_demo_dir/host.mjs"
cd "$native_demo_dir"
printf '{"private":true,"type":"module"}\n' > package.json
npm install --ignore-scripts --no-audit --no-fund ./*.tgz
mkdir ws
printf 'Example input\n' > ws/note.txt
FAKE_SCENARIO=happy node host.mjs --db ./run.sqlite --workspace ./ws
```

To use a real model, supply the four required `NATIVE_MODEL_*` variables through
your local credential environment, omit `FAKE_SCENARIO`, and run the host with a
new database. Do not place credentials in the example or package metadata.
The separate `verify-native-installed-live.mjs --installed-dir <directory>`
checks a finite real-provider task, including restart after a committed read,
one write, and terminal reattachment without new model calls or effects.
