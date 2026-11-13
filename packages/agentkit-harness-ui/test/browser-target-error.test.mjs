import test from 'node:test';
import assert from 'node:assert/strict';
import { toolErrorSummary } from '../src/tool-error.mjs';
test('browser target diagnostics keep ambiguity, absence, visibility and actionability distinct in Chinese', () => {
  const expected = { selector_ambiguous: /多个元素/, selector_not_found: /未找到/, selector_not_visible: /不可见/,
    selector_not_actionable: /无法交互/, selector_resolution_failed: /解析或读取/ };
  for (const [code, text] of Object.entries(expected)) assert.match(toolErrorSummary(JSON.stringify({ error_code: code }), { locale: 'zh-CN' }), text);
});
test('a disabled approval is distinguished from a user denial in the tool row', () => {
  const zh = { locale: 'zh-CN' };
  assert.match(toolErrorSummary({ code: 'approval_prompts_disabled' }, zh), /未开启审批/);
  assert.match(toolErrorSummary({ code: 'approval_rejected' }, zh), /用户未授权/);
});
