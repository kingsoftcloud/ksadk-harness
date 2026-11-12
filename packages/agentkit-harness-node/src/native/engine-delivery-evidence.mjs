import { currentDeliveryManifest } from '@kingsoftcloud/agentkit-harness-core';

const safePath = path => typeof path === 'string' && path.length <= 2048
  && !/[\\:\u0000-\u001f\u007f?#]/u.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
const screenshotPath = path => safePath(path) && /\.(?:png|jpe?g|webp)$/i.test(path);

/** Committed effects for this Run only. The snapshot's workspaceModifiedPaths
 * also contains paths inherited from earlier Turns. */
export function engineDeliveryEvidence(record) {
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
  const files = [...changes.values()].filter(file => !screenshots.has(file.path));
  return { files: files.slice(0, 96), screenshots: [...screenshots].slice(-8), truncated: files.length > 96 };
}
