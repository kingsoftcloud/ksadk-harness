import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const FORBIDDEN_PATHS = [
  /^\.artifacts\//,
  /^\.playwright-cli\//,
  /(^|\/)(?:node_modules|\.scratch|\.dsh|\.agentkit|\.codex|\.ssh|profiles)\//,
  /(^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:p12|pfx|p8|key)|.*(?:credentials?|secrets?|tokens?)\.(?:json|ya?ml|toml|ini|env)|.*private[-_]?key.*)$/i,
];

const PRIVATE_MARKERS = [
  ['INTERNAL', '-ONLY'].join(''),
  ['真实', '账号'].join(''),
  ['客户', '信息'].join(''),
  ['内部', '工作区'].join(''),
  ['内部', '主干'].join(''),
  ['仅', '内部'].join(''),
];

export const SENSITIVE_TEXT_PATTERNS = [
  { name: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/i },
  { name: 'internal-forge-host', pattern: /(?:^|[^a-z0-9])(?:[a-z0-9-]+[.])*ezone[.]ksyun[.]com(?:[^a-z0-9]|$)/i },
  { name: 'internal-service-host', pattern: /\b(?:[a-z0-9-]+[.])*(?:inner|internal)[.]api[.]ksyun[.]com\b|\b[a-z0-9.-]+[.](?:internal|intranet|corp)(?![a-z0-9.-])/i },
  { name: 'private-network-address', pattern: /(?:^|[^0-9])(?:10[.](?:[0-9]{1,3}[.]){2}[0-9]{1,3}|192[.]168[.](?:[0-9]{1,3}[.])[0-9]{1,3}|172[.](?:1[6-9]|2[0-9]|3[01])[.](?:[0-9]{1,3}[.])[0-9]{1,3})(?:[^0-9]|$)/ },
  { name: 'embedded-url-credential', pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { name: 'personal-absolute-path', pattern: new RegExp('(?:^|[^a-z0-9])(?:[/]Users[/][^\\s/]+|[/]home[/][^\\s/]+|[A-Z]:\\\\Users\\\\[^\\\\\\s]+)', 'i') },
  { name: 'github-token', pattern: /\b(?:gh[ps]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'provider-api-key', pattern: /\b(?:sk-[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_-]{30,})\b/ },
  { name: 'private-classification-marker', pattern: new RegExp(PRIVATE_MARKERS.join('|'), 'i') },
];

// These are deliberately public SSRF and validation fixtures, not deployment
// endpoints or credentials. Keep the values assembled so this allow-list does
// not weaken the scanner by adding its own detectable literals.
const PUBLIC_SSRF_FIXTURES = new Set([
  ['0', '0', '0', '0'].join('.'), ['10', '0', '0', '0'].join('.'), ['127', '0', '0', '0'].join('.'),
  ['169', '254', '0', '0'].join('.'), ['172', '16', '0', '0'].join('.'), ['192', '0', '0', '0'].join('.'),
  ['192', '0', '0', '170'].join('.'), ['192', '168', '0', '0'].join('.'), ['198', '18', '0', '0'].join('.'),
  ['198', '51', '100', '0'].join('.'), ['203', '0', '113', '0'].join('.'), ['224', '0', '0', '0'].join('.'),
  ['240', '0', '0', '0'].join('.'), ['255', '255', '255', '255'].join('.'), ['100', '64', '0', '0'].join('.'),
  ['127', '0', '0', '1'].join('.'), ['10', '5', '5', '5'].join('.'), ['169', '254', '1', '1'].join('.'),
  ['100', '64', '10', '5'].join('.'),
]);
const METADATA_HOST = ['metadata', 'google', 'internal'].join('.');

function approvedFixture(name, file, match, text) {
  const value = match[0];
  const testFile = /(^|\/)test\//.test(file);
  if (name === 'internal-service-host' && value.toLowerCase().includes(METADATA_HOST))
    return file.endsWith('/local-command-policy-worker.mjs') || file.endsWith('/native-local-command-policy.test.mjs');
  if (name === 'private-network-address') {
    const address = value.match(/\d{1,3}(?:[.]\d{1,3}){3}/)?.[0];
    return PUBLIC_SSRF_FIXTURES.has(address) && (file.endsWith('/web-tools.mjs') || file.endsWith('/native-web-tools.test.mjs')
      || file.endsWith('/native-local-command-policy.test.mjs'));
  }
  if (name === 'embedded-url-credential' && testFile) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    return line.includes('example.com') || line.includes('server.url') || line.includes('127.0.0.1');
  }
  if (name === 'aws-access-key' && file.endsWith('/native-memory-tools.test.mjs')) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index);
    return text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).includes('api_key=');
  }
  return false;
}

export function auditPath(file) {
  return FORBIDDEN_PATHS.filter(pattern => pattern.test(file)).map(() => ({ file, kind: 'forbidden public path' }));
}

export function auditText(file, source) {
  const text = source[0] === 0xff && source[1] === 0xfe
    ? source.subarray(2).toString('utf16le') : source.toString('utf8');
  const hits = [];
  for (const { name, pattern } of SENSITIVE_TEXT_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
      if (approvedFixture(name, file, match, text)) continue;
      hits.push({ file, kind: name, line: text.slice(0, match.index).split('\n').length });
    }
  }
  return hits;
}

export function trackedFiles(root = process.cwd()) {
  return [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', cwd: root })
    .split('\0').filter(Boolean))];
}

async function readRegularFile(path) {
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!info.isFile()) throw new Error('non-regular-file');
  return readFile(path);
}

export async function auditFiles(files, root = process.cwd()) {
  const hits = [];
  for (const file of files) {
    const pathHits = auditPath(file);
    hits.push(...pathHits);
    if (pathHits.length) continue;
    const source = await readRegularFile(resolve(root, file));
    if (source != null) hits.push(...auditText(file, source));
  }
  return hits;
}

export async function run(root = process.cwd()) {
  const hits = await auditFiles(trackedFiles(root), root);
  if (hits.length) {
    for (const hit of hits) console.error(`${hit.line ? `${hit.file}:${hit.line}` : hit.file}: ${hit.kind}`);
    process.exitCode = 1;
    return hits;
  }
  console.log('public surface audit passed: all tracked and non-ignored files and paths checked');
  return [];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await run();
