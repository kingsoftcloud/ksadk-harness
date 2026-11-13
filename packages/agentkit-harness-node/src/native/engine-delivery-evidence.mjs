import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { diffLines } from 'diff';
import { atomicPrivate, openPrivate, privateDirectory } from './local-command-state.mjs';
import { currentDeliveryManifest } from '@kingsoftcloud/agentkit-harness-core';

const safePath = path => typeof path === 'string' && path.length <= 2048
  && !/[\\:\u0000-\u001f\u007f?#]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
const screenshotPath = path => safePath(path) && /\.(?:png|jpe?g|webp)$/i.test(path);

/** Committed effects for this Run only. The snapshot's workspaceModifiedPaths
 * also contains paths inherited from earlier Turns. */
export function engineDeliveryEvidence(record, netChanges) {
  const changes = new Map();
  const screenshots = new Set();
  for (const artifact of currentDeliveryManifest(record.snapshot)?.artifacts ?? []) {
    if (artifact.kind === 'file' && screenshotPath(artifact.path)) screenshots.add(artifact.path);
  }
  const intents = new Map(record.intents.map(intent => [intent.operationKey, intent]));
  for (const receipt of record.receipts) {
    const intent = intents.get(receipt.operationKey);
    if (receipt.status !== 'committed' || intent?.kind !== 'tool' || !Array.isArray(receipt.result?.results)) continue;
    for (const [index, result] of receipt.result.results.entries()) {
      const tool = intent.payload.calls?.[index]?.name;
      const { path, diff_additions: added, diff_deletions: removed, screenshot_path: screenshot } = result.content ?? {};
      if (tool === 'browser_inspect_workspace' && ['ok', 'error'].includes(result.status) && screenshotPath(screenshot)) screenshots.add(screenshot);
      if (result.status !== 'ok') continue;
      for (const changed of result.workspaceChangedPaths ?? []) {
        if (!safePath(changed)) continue;
        const counts = changed === path && [added, removed].every(value => Number.isSafeInteger(value) && value >= 0)
          ? { added, removed } : {};
        // Overlapping edits cannot be counted as a net diff from their tool deltas.
        const first = !changes.has(changed);
        changes.set(changed, { path: changed, ...(first ? counts : {}),
          ...(tool === 'delete_workspace_file' ? { deleted: true } : {}) });
      }
    }
  }
  const files = [...changes.values()].filter(file => !screenshots.has(file.path)).flatMap(file => {
    if (!netChanges) return [file];
    const change = netChanges(file.path);
    return change ? [change] : [];
  });
  return { files: files.slice(0, 96), screenshots: [...screenshots].slice(-8), truncated: files.length > 96,
    ...(netChanges ? { basis: 'run-net-diff/v1' } : {}) };
}

/** Compare the two workspace observations, and only show paths evidenced by
 * this Run's receipts. Never total individual edit deltas. */
export function deliveryNetChanges(before, after) {
  return path => {
    const old = Object.hasOwn(before, path) ? before[path] : null;
    const next = Object.hasOwn(after, path) ? after[path] : null;
    if (old?.digest === next?.digest) return null;
    const file = { path, ...(!next ? { deleted: true } : {}) };
    if (old && typeof old.text !== 'string' || next && typeof next.text !== 'string') return file;
    const delta = diffLines(old?.text ?? '', next?.text ?? '', { timeout: 25, maxEditLength: 10000 });
    if (!delta) return file;
    let added = 0, removed = 0;
    for (const part of delta) {
      if (part.added) added += part.count;
      if (part.removed) removed += part.count;
    }
    return { ...file, added, removed };
  };
}

/** Private snapshots survive engine restart. Only the sealed summary is
 * returned to the host. Runs without a baseline retain their legacy evidence. */
export function createEngineDeliveryJournal(directory, capture) {
  const paths = runId => {
    const key = createHash('sha256').update(runId).digest('hex');
    return { baseline: join(directory, key + '.baseline'), summary: join(directory, key + '.json') };
  };
  const read = path => {
    const fd = openPrivate(path, constants.O_RDONLY);
    try { return JSON.parse(readFileSync(fd, 'utf8')); }
    finally { closeSync(fd); }
  };
  return {
    begin(runId) {
      const { baseline } = paths(runId);
      if (!existsSync(baseline)) {
        privateDirectory(directory, true);
        atomicPrivate(baseline, JSON.stringify(capture()));
      }
    },
    seal(record) {
      const { baseline, summary } = paths(record.snapshot.runId);
      if (!existsSync(baseline)) return;
      try {
        if (record.snapshot.phase === 'completed' && !existsSync(summary)) {
          const evidence = engineDeliveryEvidence(record, deliveryNetChanges(read(baseline), capture()));
          atomicPrivate(summary, JSON.stringify(evidence));
        }
      } finally { unlinkSync(baseline); }
    },
    read(record) {
      const { summary } = paths(record.snapshot.runId);
      return existsSync(summary) ? read(summary) : engineDeliveryEvidence(record);
    },
  };
}
