import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDiagnosticText, publicErrorMessage, publicErrorCode, publicFailureContent } from '../dist/error-presentation.mjs';

test('public diagnostics redact credentials before applying a display bound', () => {
  const message = 'request failed: Authorization: Bearer fixtureBearerValue; Basic Zml4dHVyZTpwYXNz; '
    + 'https://' + 'reader:' + 'fixturePassword@example.invalid/?access_token=fixtureQueryValue&Signature=fixtureSignature '
    + '{"api_key":"fixture key with spaces","password":"fixture password with spaces"} '
    + 'sk-fixtureStandaloneValue eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fixtureSignature';
  for (const limit of [30, 200, 2048]) {
    const result = redactDiagnosticText(message, limit);
    assert.ok(result.length <= limit);
    assert.doesNotMatch(result, /fixtureBearerValue|Zml4dHVyZTpwYXNz|fixturePassword|fixtureQueryValue|fixtureSignature|fixture key|fixture password|fixtureStandaloneValue|eyJhbGci/);
  }
  assert.match(redactDiagnosticText(message), /request failed/);
});

test('nested failure diagnostics redact arrays, Error causes and stacks without changing effect evidence', () => {
  const secret = 'Authorization: Bearer fixtureBearerValue; https://' + 'reader:' + 'fixturePassword@example.invalid/ password=fixturePassword';
  const error = Object.assign(new Error(secret, { cause: new Error(secret) }), { code: 'Bearer fixtureBearerValue' });
  const input = { ok: false, error, details: [{ explanation: secret }], results: [{ error_message: secret }],
    receipt: { operationKey: 'original-operation', executed: true, path: 'token=original-file' },
    file_content: secret, artifact_uri: 'artifact://original' };
  const projected = publicFailureContent(input);
  for (const value of [projected.error, projected.details, projected.results])
    assert.doesNotMatch(JSON.stringify(value), /fixtureBearerValue|fixturePassword/);
  assert.equal(projected.error.code, 'TOOL_OPERATION_FAILED');
  assert.match(projected.error.message, /upstream|Authorization/);
  assert.deepEqual(projected.receipt, input.receipt);
  assert.equal(projected.file_content, secret);
  assert.equal(projected.artifact_uri, input.artifact_uri);
  assert.equal(input.error.message, secret);
});

test('cyclic and excessively deep diagnostics terminate without exposing an unprojected tail', () => {
  const root = { error: { message: 'token=fixtureValue' } }; root.error.cause = root.error;
  assert.doesNotMatch(JSON.stringify(publicFailureContent(root)), /fixtureValue/);
  const deep = { error: {} }; let next = deep.error;
  for (let i = 0; i < 40; i++) next = next.cause = {};
  next.message = 'password=fixtureValue';
  assert.doesNotMatch(JSON.stringify(publicFailureContent(deep)), /fixtureValue/);
});

test('absent optional diagnostic codes remain byte-stable instead of fabricating an error', () => {
  const payload = { code: '', details: [{ error_type: '', error_code: '' }],
    skill_events: [{ error_code: '', event_id: 'original-event', runtime_id: 'original-runtime' }] };
  assert.deepEqual(publicFailureContent(payload), payload);
});

test('private keys and malformed diagnostic codes cannot become public errors', () => {
  const marker = '-'.repeat(5);
  const key = marker + 'BEGIN PRIVATE KEY' + marker + '\nfixture-private-key\n' + marker + 'END PRIVATE KEY' + marker;
  assert.doesNotMatch(publicErrorMessage(new Error(key)), /fixture-private-key/);
  assert.equal(publicErrorCode({ code: 'Bearer fixtureValue' }, 'TOOL_FAILED'), 'TOOL_FAILED');
  assert.equal(publicErrorCode({ code: 'sk-fixtureStandaloneValue' }, 'TOOL_FAILED'), 'TOOL_FAILED');
  assert.equal(publicErrorCode({ code: 'REQUEST_CANCELLED' }, 'TOOL_FAILED'), 'REQUEST_CANCELLED');
  assert.equal(publicErrorMessage(null), 'Tool operation failed.');
  assert.equal(publicErrorMessage(new Error('file no longer exists')), 'file no longer exists');
});
