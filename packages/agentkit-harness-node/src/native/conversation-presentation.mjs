import { invariant } from '@kingsoftcloud/agentkit-harness-core';

const LANGUAGES = { 'zh-CN': '简体中文', en: 'English', ja: 'Japanese', ko: 'Korean' };

/** A presentation preference inferred from user prose, never an authority or a
 * translation of model reasoning. Freeze it once and pass it to child owners. */
export function admitConversationPresentation({ objective = '', locale } = {}) {
  // An unknown language is not an English preference. Preserve the model's
  // existing user-language behavior when this small script detector cannot
  // establish a preference, including unsupported explicit locales.
  if (locale !== undefined && !Object.hasOwn(LANGUAGES, locale)) return undefined;
  const prose = String(objective).replace(/```[^]*?```/g, '').replace(/`[^`]*`/g, '').slice(0, 8000);
  const selected = locale && Object.hasOwn(LANGUAGES, locale) ? locale
    : /[\u3040-\u30ff]/u.test(prose) ? 'ja' : /[\uac00-\ud7af]/u.test(prose) ? 'ko'
      : /\p{Script=Han}/u.test(prose) ? 'zh-CN' : undefined;
  return selected ? { contract: 'agentkit.conversation-presentation/v1', language: selected } : undefined;
}

export function validateConversationPresentation(value) {
  invariant(value && Object.keys(value).sort().join(',') === 'contract,language'
    && value.contract === 'agentkit.conversation-presentation/v1' && Object.hasOwn(LANGUAGES, value.language),
  'native_conversation_presentation_invalid');
  return { ...value };
}

export function conversationPresentationInstructions(value) {
  if (value === undefined) return '';
  const { language } = validateConversationPresentation(value);
  if (language === 'zh-CN') return '会话展示语言：简体中文。面向用户的进度说明、任务清单（包括 TodoWrite 的 content）、子任务汇报和最终答复使用简体中文。用户最新消息中明确指定的语言要求优先。代码、命令、路径、产品名和原文引用保留原样。这项要求只约束公开输出，不要求展示内部推理。';
  return `Conversation presentation language: ${LANGUAGES[language]}. Use it for public progress updates, task-list content, child-task reports and final answers. An explicit language request in the latest user message takes precedence. Preserve code, commands, paths, product names and quotations. This governs public output, not private reasoning.`;
}
