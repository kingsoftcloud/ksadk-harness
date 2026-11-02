import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { validatePackageArchive } from '../native-package-archive.mjs';

function archive(entries, { end = true } = {}) {
  return gzipSync(Buffer.concat([...entries.map(({ path = 'package/a.txt', type = '0', link = '', body = 'a' }) => {
    const header = Buffer.alloc(512); header.write(path, 0, 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156); header.write(type, 156, 1); header.write(link, 157, 100);
    header.write('ustar\0', 257, 6);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return Buffer.concat([header, Buffer.from(body), Buffer.alloc((512 - body.length % 512) % 512)]);
  }), ...(end ? [Buffer.alloc(1024)] : [])]));
}

test('regular npm member set is verified before extraction', () => {
  assert.deepEqual(validatePackageArchive(archive([{}, { path: 'package/src/', type: '5', body: '' }, { path: 'package/src/b.txt' }]), ['a.txt', 'src/b.txt']), ['a.txt', 'src/b.txt']);
  assert.throws(() => validatePackageArchive(archive([{}]), ['other.txt']), /file set differs/);
});

for (const type of ['1', '2', '3', '4', '6', 'x', 'g', 'L', 'K']) test(`tar type ${type} is rejected before extraction`, () => {
  assert.throws(() => validatePackageArchive(archive([{ type }])), /non-regular member/);
});
for (const path of ['/package/a', 'package/../a', 'package/./a', 'package//a', 'package/a\\b', 'other/a', 'package/a/'])
  test(`non-canonical tar path ${path} is rejected`, () => assert.throws(() => validatePackageArchive(archive([{ path }])), /invalid path/));

test('duplicate, conflicting, malformed and truncated members fail closed', () => {
  assert.throws(() => validatePackageArchive(archive([{}, {}])), /duplicate/);
  assert.throws(() => validatePackageArchive(archive([{}, { path: 'package/a.txt/b' }])), /parent directory/);
  assert.throws(() => validatePackageArchive(archive([{ link: 'elsewhere' }])), /non-regular/);
  assert.throws(() => validatePackageArchive(archive([{}], { end: false })), /end marker/);
  assert.throws(() => validatePackageArchive(gzipSync(Buffer.alloc(12))), /truncated/);
});
