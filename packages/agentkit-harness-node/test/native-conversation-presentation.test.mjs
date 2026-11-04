import test from 'node:test';
import assert from 'node:assert/strict';
import { admitConversationPresentation, validateConversationPresentation, conversationPresentationInstructions } from '../src/native/conversation-presentation.mjs';

test('Chinese user prose admits one frozen public presentation preference, independent of English technical names', () => {
  const value = admitConversationPresentation({ objective: '对比 opencode、ZCode、pi 的 harness，给我调研报告' });
  assert.equal(value.language, 'zh-CN');
  const instructions = conversationPresentationInstructions(value);
  for (const text of ['进度说明', '任务清单', 'TodoWrite', '子任务汇报', '最终答复', '用户最新消息', '代码、命令']) assert.ok(instructions.includes(text));
  assert.deepEqual(validateConversationPresentation(JSON.parse(JSON.stringify(value))), value);
});

test('code is excluded from language inference, explicit locale is respected, and legacy absence does not activate a policy', () => {
  assert.equal(admitConversationPresentation({ objective: 'Explain this code:\n```js\nconst msg = "中文";\n```' }).language, 'en');
  assert.equal(admitConversationPresentation({ objective: '解释代码', locale: 'en' }).language, 'en');
  assert.equal(admitConversationPresentation({ objective: 'このコードを説明してください' }).language, 'ja');
  assert.equal(conversationPresentationInstructions(undefined), '');
  assert.throws(() => validateConversationPresentation({ contract: 'agentkit.conversation-presentation/v1', language: 'zh-CN', permission: 'allow' }));
});
