import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDiagnosticText, publicErrorMessage, publicErrorCode } from '../dist/error-presentation.mjs';

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
