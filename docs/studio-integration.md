# 前后端包接入

Native 的运行内核、Node 执行适配器和任务过程 UI 分别由三个 npm 包交付。Studio 提供模型与资源配置、鉴权、会话和页面挂载端口，通过包的公开入口装配它们。

## 安装产物

在本仓库执行：

```sh
npm ci --ignore-scripts
npm run build
npm run pack:all
```

三个带内容摘要的 `.tgz` 及 `manifest.json` 位于 `.artifacts/packages/`。消费者应一起安装清单指定的 core、node、ui 三个产物，确保 Node 与宿主使用同一个 Core 实例。React 和 ReactDOM 使用宿主已有版本。

这些是可直接安装的 npm 归档。发布 npm registry、配置企业制品库是独立的分发动作。

## 后端

- `@kingsoftcloud/agentkit-harness-core` 提供唯一的循环、状态机、账本契约、预算和恢复策略。
- `@kingsoftcloud/agentkit-harness-node` 提供 SQLite、模型、工作区、命令、浏览器、工件、子任务和其他执行适配器。
- `@kingsoftcloud/agentkit-harness-node/native/children` 提供子任务角色归一化与完整装配工厂 `createNativeChildren`。宿主传入已绑定的模型、工具、存储、验证和工作区端口；`goalContractFactory` 可指定业务验收契约。
- `native/child-workspace-binding`、`native/child-merge`、`native/tool-authority` 负责工作区隔离绑定、已核算结果的合并及账本权限检查。
- `native/model-surface-host`、`native/child-model-surface`、`native/context-profile`、`native/local-execution-profile` 和 `native/instruction-context` 统一构造执行环境、上下文、输出与指令配置。
- `agentkit-native-rpc` 提供 JSON-RPC/NDJSON 子进程入口，供其他语言连接。Python 高代码 SDK 与 Python 工具双向调用需要后续实现，不能直接传递 Python 函数给 npm 包。

Studio 的适配层保留业务模型选择、凭证解析、资源提供方和宿主注册。它调用上述包入口；执行状态仍由 Native 账本负责。

## 前端与交互

UI 包提供任务对话时间线、真实模型思考与文本增量、工具详情、终端输出、文件差异、上下文压缩标记、右上角可收起状态面板、子智能体侧栏及隔离文件预览。Host 接入模块还负责事件投影、游标读取、刷新与清理，以及恢复、子任务和远端任务的交互状态。

主界面的接入方式为：

```js
import { installTaskTimeline } from '@kingsoftcloud/agentkit-harness-ui/host/task-timeline';

installTaskTimeline(hostContext, {
  ui: { React, ReactDOM },
  hostRemote,
  resolveAgentFromPreset,
});
```

`hostContext` 提供页面槽位、主题、会话事件源和右侧栏挂载能力。`hostRemote` 提供已鉴权的状态、子任务、终端和文件读取接口。`resolveAgentFromPreset` 由 Studio 负责把产品预设匹配到 Agent；UI 包不读取 Studio 配置或凭证。

运行与子任务管理、Native A2A 交互由 `host/native-run-panel` 和 `host/native-a2a` 提供。产品预设识别及其他 runtime 的页面仍通过适配器传入。输入框、宿主审批通道和全局导航继续复用 Studio。

## 源码与验收

`docs/native-source-snapshot.json` 记录源版本和三棵完整源码树的摘要；包含本轮在 Studio 工作区验证过、尚未提交的包内容。可用 `node scripts/sync-from-studio.mjs --check` 检查独立仓库是否与该快照一致。同步脚本仅复制三个 Native 包和明确列出的构建输入，不复制 Studio 配置、用户数据或凭证。

包边界检查：`npm run verify:boundary`。验收使用实际 npm 安装入口，分别检查前端挂载和释放、后端执行与恢复；模型受控检查不代表真实模型质量评测。

打包后可执行 `npm run verify:installed-ui`：在全新临时目录安装清单中的三个归档，检查 SQLite 执行与重开、单一 Core 实例、思考与终端渲染、会话事件源、侧栏挂载和释放。它不使用 Studio 源码重定向。详细结果见 [拆包验收记录](native-extraction-acceptance.md)。
