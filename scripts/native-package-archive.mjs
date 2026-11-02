import { gunzipSync } from 'node:zlib';

/** Inspect the entire archive before extraction. npm packs regular files and
 * directories; extended headers, links and device entries are not release input.
 */
export function validatePackageArchive(compressed, expectedFiles) {
  const bytes = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  const fail = reason => { throw Error('Unsafe package archive: ' + reason); };
  const text = field => {
    const zero = field.indexOf(0);
    if (zero >= 0 && field.subarray(zero).some(byte => byte !== 0)) fail('invalid text field');
    return field.subarray(0, zero < 0 ? field.length : zero).toString('utf8');
  };
  const number = field => {
    const value = field.toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(value)) fail('invalid numeric field');
    const result = parseInt(value, 8);
    if (!Number.isSafeInteger(result)) fail('oversized numeric field');
    return result;
  };
  if (bytes.length % 512) fail('truncated block');
  const members = new Map(), files = [];
  let offset = 0, ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > bytes.length || bytes.subarray(offset).some(byte => byte !== 0)) fail('invalid end marker');
      ended = true; break;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (number(header.subarray(148, 156)) !== checksum) fail('checksum mismatch');
    const type = header[156];
    if (![0, 48, 53].includes(type) || text(header.subarray(157, 257))) fail('non-regular member');
    const magic = text(header.subarray(257, 263));
    if (magic && magic !== 'ustar') fail('unsupported header');
    const prefix = text(header.subarray(345, 500));
    const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
    const directory = type === 53;
    const path = directory && name.endsWith('/') ? name.slice(0, -1) : name;
    if (path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
      || (path !== 'package' && !path.startsWith('package/')) || (!directory && path === 'package')) fail('invalid path');
    if (members.has(path)) fail('duplicate member');
    const size = number(header.subarray(124, 136));
    if (directory && size !== 0) fail('directory has content');
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length) fail('truncated member');
    members.set(path, directory);
    if (!directory) files.push(path.slice('package/'.length));
    offset = next;
  }
  if (!ended || !files.length) fail('missing file set or end marker');
  for (const path of members.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (members.get(parts.slice(0, i).join('/')) === false) fail('file is a parent directory');
  }
  if (expectedFiles && (files.length !== expectedFiles.length || [...files].sort().some((path, i) => path !== [...expectedFiles].sort()[i])))
    fail('file set differs from npm pack metadata');
  return files;
}
