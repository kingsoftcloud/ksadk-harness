import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, parseModelJson, parseNativeJson } from '../dist/index.mjs';

test('strict JSON decoding preserves large source and escaped log strings', () => {
  const source = { code: 'const label = "中文😀";\n'.repeat(80000),
    escaped: '\\"\t\r\n\b\f'.repeat(20000), tail: ['last error', 42, null, false] };
  const wire = JSON.stringify(source);
  for (const parse of [parseNativeJson, parseModelJson]) {
    const result = parse(wire);
    assert.equal(result.code, source.code);
    assert.equal(result.escaped, source.escaped);
    assert.deepEqual(result.tail, source.tail);
    assert.equal(JSON.stringify(result), wire);
  }
});

test('escaped keys retain duplicate rejection and own prototype-named properties', () => {
  for (const parse of [parseNativeJson, parseModelJson]) {
    assert.throws(() => parse('{"a":1,"\\u0061":2}'), { code: 'duplicate_model_json_key' });
    assert.throws(() => parse('{"nested":{"\\u0061":1,"a":2}}'), { code: 'duplicate_model_json_key' });
    const result = parse('{"__proto__":{"polluted":true},"constructor":"own","toString":0}');
    assert.equal(Object.hasOwn(result, '__proto__'), true);
    assert.equal(result.__proto__.polluted, true);
    assert.equal(result.constructor, 'own');
    assert.equal(Object.prototype.polluted, undefined);
  }
});

test('invalid strings, token boundaries and non-finite numbers remain rejected', () => {
  const invalid = ['"unfinished', '"backslash\\', '"raw\nline"', '"raw\tvalue"', '"\\q"', '"\\u00xz"',
    '"valid" trailing', '01', '-01', '1.', '1e', '[1 2]', '{"x" 1}', '{"x":1,}', '[1,]',
    'truefalse', '\u00a0null', '\vnull', '1e9999'];
  for (const parse of [parseNativeJson, parseModelJson]) for (const wire of invalid)
    assert.throws(() => parse(wire), wire);
});

test('text scanning keeps exact integer, negative-zero and nesting boundaries', () => {
  const integer = BigInt('9'.repeat(4300));
  for (const parse of [parseNativeJson, parseModelJson]) {
    const value = parse(` { "n" : ${integer}, "float": 1e20, "zero": -0.0, "small":-0 }\r\n`);
    assert.equal(value.n, integer); assert.equal(value.float, 1e20);
    assert.equal(Object.is(value.zero, -0), true); assert.equal(Object.is(value.small, 0), true);
    assert.throws(() => parse('9'.repeat(4301)), { code: 'model_json_integer_digits_exceeded' });
  }
  for (const [parse, depth] of [[parseNativeJson, 1024], [parseModelJson, 256]]) {
    const wire = '['.repeat(depth) + '1' + ']'.repeat(depth);
    assert.doesNotThrow(() => parse(wire));
    assert.throws(() => parse('[' + wire + ']'), { code: 'model_json_nesting_exceeded' });
  }
});

test('deterministic mixed string/number corpus agrees with native JSON on the shared domain', () => {
  let seed = 0x12aef09;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const atoms = ['"', '\\', '\n', '\t', '\r', '\0', '中文😀', '\u2028', 'key', '9e+2', ''];
  for (let i = 0; i < 500; i++) {
    const text = Array.from({ length: random() % 30 }, () => atoms[random() % atoms.length]).join('');
    const source = { [text]: [text, (random() - 2147483648) / 8, i % 2 === 0, null], suffix: i };
    const wire = JSON.stringify(source);
    for (const parse of [parseNativeJson, parseModelJson]) assert.equal(canonical(parse(wire)), canonical(JSON.parse(wire)));
  }
});
