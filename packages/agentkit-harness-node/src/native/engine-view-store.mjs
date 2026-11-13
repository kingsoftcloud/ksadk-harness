import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicPrivate, openPrivate, privateDirectory } from './local-command-state.mjs';

export const ENGINE_VIEW_CONTRACT = 'agentkit.engine-view/v1';
const SHA256 = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_VIEW_BYTES = 1024 * 1024;

function read(path, limit) {
  let fd;
  try {
    fd = openPrivate(path, constants.O_RDONLY);
    if (fstatSync(fd).size > limit) throw new Error('engine_view_archive_too_large');
    return readFileSync(fd, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function write(path, value) {
  privateDirectory(dirname(path), true);
  atomicPrivate(path, value);
}

export function createEngineViewStore(directory) {
  const file = sha256 => join(directory, 'assets', sha256 + '.json');
  const reference = (stateDir, runId) => join(stateDir, 'view-references', digest(runId));

  function get(sha256) {
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
    const encoded = read(file(sha256), 6 * MAX_VIEW_BYTES + 1024);
    if (encoded === null) return null;
    const view = JSON.parse(encoded);
    if (view?.contract !== ENGINE_VIEW_CONTRACT || view.sha256 !== sha256
      || view.contentType !== 'text/html; charset=utf-8' || typeof view.html !== 'string'
      || Buffer.byteLength(view.html) > MAX_VIEW_BYTES || digest(view.html) !== sha256)
      throw new Error('engine_view_archive_invalid');
    return view;
  }

  return {
    get,
    archive(view) {
      if (!view) return null;
      if (Buffer.byteLength(view.html) > MAX_VIEW_BYTES || digest(view.html) !== view.sha256)
        throw new Error('engine_view_bundle_invalid');
      if (!get(view.sha256)) write(file(view.sha256), JSON.stringify(view));
      return { contract: ENGINE_VIEW_CONTRACT, sha256: view.sha256 };
    },
    reference(stateDir, runId) {
      const sha256 = read(reference(stateDir, runId), 64);
      if (sha256 === null) return null;
      if (!SHA256.test(sha256)) throw new Error('engine_view_reference_invalid');
      return { contract: ENGINE_VIEW_CONTRACT, sha256 };
    },
    pin(stateDir, runId, view) {
      if (!view) return;
      const path = reference(stateDir, runId);
      if (read(path, 64) === null) write(path, view.sha256);
    },
  };
}
