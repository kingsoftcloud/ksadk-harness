import { redactError } from './tool-detail.mjs';

const summaries = {
  invalid_delivery_scope: '交付范围声明无效，尚未更新',
  web_definition_mismatch: '网页工具的接入配置不一致，尚未执行',
  web_search_not_configured: '网页搜索服务尚未配置',
  capture_limit_exceeded: '工作区变更清单超出观测上限，命令未执行',
  command_policy_blocked: '命令不符合当前执行规则，尚未执行',
  policy_denied: '当前权限规则未允许这次操作',
  approval_prompts_disabled: '这项操作需要单次授权，当前会话未开启审批',
  approval_rejected: '用户未授权这次操作',
  approval_unavailable: '当前没有可用的审批入口',
  approval_cancelled: '这次审批已取消，操作未执行',
  invalid_arguments: '工具参数校验未通过，操作未执行',
  snippet_not_found: '找不到要替换的原文片段',
  ambiguous_edit: '原文匹配次数与预期不符',
  command_evidence_incomplete: '命令回执尚不完整，需要核对执行结果',
  studio_native_browser_unavailable: '本地浏览器不可用，尚未完成网页验证',
  child_capability_unavailable: '该子智能体缺少任务所需工具，尚未启动',
  child_capability_request_invalid: '子任务所需工具声明无效，尚未启动',
  child_role_unavailable: '所选子智能体不可用，尚未启动',
  canceled: '操作已停止',
  selector_ambiguous: '选择器匹配多个元素，请选择唯一目标',
  selector_not_found: '未找到指定元素，请核对当前页面',
  selector_not_visible: '指定元素当前不可见',
  selector_not_actionable: '指定元素当前无法交互',
  selector_resolution_failed: '无法解析或读取指定目标',
};

function errorValue(error) {
  try { return typeof error === 'string' ? JSON.parse(error) : error; } catch { return null; }
}

const errorCode = value => value?.error_type ?? value?.code ?? value?.error_code ?? value?.error?.code;

export function isRetryableEditFailure(error) {
  return ['snippet_not_found', 'ambiguous_edit'].includes(errorCode(errorValue(error)));
}

export const isCommandPolicyBlock = error => errorCode(errorValue(error)) === 'command_policy_blocked';

export function commandPolicyBlockReason(error) {
  const value = errorValue(error);
  const reason = value?.finding?.detail ?? value?.message ?? value?.error_message;
  return typeof reason === 'string' ? redactError(reason) : null;
}

/** Detailed evidence remains expandable; compact rows do not dump wire JSON. */
export function toolErrorSummary(error, { locale } = {}) {
  const value = errorValue(error);
  if (value && typeof value === 'object') {
    const code = errorCode(value);
    if (String(locale ?? '').startsWith('zh')) {
      if (code === 'snippet_not_found' && Number.isSafeInteger(value.failed_edit_index) && value.failed_edit_index >= 0)
        return `第 ${value.failed_edit_index + 1} 项找不到原文，本批修改未写入`;
      return summaries[code] ?? '工具调用失败，点击查看具体原因';
    }
    return 'Tool call failed; expand for details';
  }
  return redactError(error);
}
