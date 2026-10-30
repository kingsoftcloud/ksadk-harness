# KSADK Native Harness

KSADK Native Harness 是 **KSADK 体系中的自研 Agent 运行框架**，统一提供任务执行、工具调用、上下文管理、持久化恢复、子智能体协作和任务过程 UI。

本仓库独立维护运行内核、Node 适配层和前端 UI，并通过 npm 包供其他代码库接入。**Studio** 是面向用户的 Agent 开发与运行产品，接入这些包来执行任务和展示过程，负责模型配置、会话、认证及业务服务；**KSADK（包括 ksadk-python）** 可复用同一套运行能力，通过代码配置模型、工具和角色来构建 Agent。Python 接入通过 Node 运行时的进程接口完成，具体边界见下文。

## 三个独立 npm 包

| 包 | 主要职责 | 接入边界 |
| --- | --- | --- |
| `@kingsoftcloud/agentkit-harness-core` | 执行状态机、模型／工具循环、持久化契约、恢复、预算、上下文、子任务与验证规则 | 不导入 Studio、DSH、数据库、文件系统或 HTTP 运行时；由宿主注入端口 |
| `@kingsoftcloud/agentkit-harness-node` | SQLite 存储、模型 HTTP 适配、本地工具、文件与进程操作、浏览器适配及 JSON-RPC 进程入口 | 复用同一份 Core；宿主负责提供模型配置、工作区、权限和外部服务 |
| `@kingsoftcloud/agentkit-harness-ui` | 任务时间线、流式正文、可见思考、工具结果、终端、文件差异、任务面板与子智能体侧栏 | React 由宿主提供；UI 消费事件和观察数据，不执行工具、不决定权限 |

三个包可以分别构建和打包。使用后端时需要 Core 与 Node；使用任务界面时再接入 UI。UI 中的宿主适配入口要求实现对应接口，不会自动创建完整的 Studio 应用。

```text
Studio / 其他 Node 宿主 / Python 进程客户端
                  │
          宿主组装、授权与模型配置
                  │
         Node 适配器 + Core 运行内核
                  │
       状态、回执、事件与展示数据投影
                  │
        UI 包 + 宿主提供的 React / 页面
```

## 主要能力与行为边界

- **任务执行**：组织模型、工具和结果反馈的多步循环；区分模型请求、执行效果、工具回执和展示数据。
- **持久化与恢复**：保存 Run、配置、事件、意图及回执；通过租约和执行归属控制恢复。结果未知的写入或外部副作用不会仅因重连而自动重跑。
- **资源与权限**：在宿主授权的工具、工作区和资源范围内运行；进程、模型调用、工具调用及子任务受对应预算约束。
- **上下文管理**：组装当前环境、指令来源、工具观察和历史；支持裁剪与压缩。新策略在任务准入时固定，历史任务按原配置恢复。
- **子智能体**：由主模型显式调用已批准角色，按角色绑定模型和工具，管理父子归属、预算和结果汇报。任务较长不会自动启动子智能体。
- **工具与能力发现**：提供工作区、命令、浏览器及其他适配能力；MCP、Skills、Hooks 和业务服务需要宿主按契约绑定。
- **任务过程 UI**：展示流式正文、供应商允许展示的思考、工具执行、终端输出、文件修改和子任务过程；不生成虚构思考或执行结果。
- **验收状态**：执行结束与交付验证分开记录。模型声称完成，不等于外部验证通过。

部分能力是可选策略或端口，是否启用取决于宿主组装。库中存在一项能力，不代表最小 RPC 入口已经开放该能力的全部控制方法。

### 如何理解完成状态

调用方应结合 `phase`、`outcome`、`reason` 和验证事实判断结果，不能只读取最终文本。

| 观察 | 含义 |
| --- | --- |
| `phase: completed` | 运行流程已结束；仍需查看 `outcome` |
| `outcome: verified` | 已满足该任务配置的验证要求，不表示覆盖了配置之外的所有质量要求 |
| `outcome: unverified` | 结果尚未得到充分验证，不能当成验收通过 |
| 取消、失败、预算耗尽或结果未知 | 保留相应原因和回执边界；不能由展示层改写成成功 |

## 环境、安装与构建

- Node.js **22.19.0 或更新版本**，需要该版本提供的 `node:sqlite`。
- 使用 npm 工作区；依赖版本由 `package-lock.json` 固定。
- UI 的宿主需要提供兼容的 React／ReactDOM。独立安装验证使用 React 18.3.1。
- 真实浏览器运行验证需要可用的 Chromium；视觉理解还需要显式绑定支持图片的模型。

在本仓库根目录执行：

```sh
npm ci --ignore-scripts
make check
```

构建产物主要位于 Core、Node 的 `dist/` 及 UI 的 `markdown/dist/`。构建不会安装或启动 ZCode，也不会自动获得模型服务凭据。

### 打包和消费

```sh
npm run pack:all
```

三个可安装的 npm 压缩包输出到 `.artifacts/packages/`，`manifest.json` 记录名称、版本、文件名、SHA-256 和 integrity。消费方应按该清单取同一批 Core、Node、UI 归档，通过 npm 安装实际 `.tgz` 路径。

三个子包是可公开安装的 npm 包；workspace 根目录保持 `private: true`，只用于统一构建和测试。发布由受保护的 GitHub release 工作流执行，并使用 npm provenance：

```sh
# Runtime host + task UI. Node automatically installs Core.
npm install @kingsoftcloud/agentkit-harness-node @kingsoftcloud/agentkit-harness-ui

# Only when using the kernel contract directly:
npm install @kingsoftcloud/agentkit-harness-core
```

The UI package keeps React and ReactDOM as optional peer dependencies so a
Studio or other React host supplies its existing versions. It is intentionally
separate from the Node runtime package; installing the runtime does not pull a
browser UI into a server process.

提交前运行 `make public-gate`。它会检查公开文件面、完整 Git 历史密钥扫描、构建、三套测试、RPC/UI 安装边界、包内容和运行时依赖审计。

## 如何供 Studio 与 Python 仓库使用

### Studio

Studio 安装三个 npm 包，在 Host 中绑定模型、工作区、工具、权限、会话和外部资源；前端接入 UI 的事件投影、React 组件和导航回调。运行时与 UI 包独立维护，Studio 保留产品身份、认证、会话和业务服务的适配职责。

升级时应一起校验包版本、事件契约和产物摘要。不能只改本仓库源码，就认为已经运行中的 Studio 安装包会自动更新。

### ksadk-python 或其他语言宿主

Python 可以通过 Node 子进程调用同一个运行时。Node 包提供 `agentkit-native-rpc`，以 **JSON-RPC 2.0 over NDJSON** 在标准输入／输出通信；这不是 SSE 或 HTTP 服务。

当前进程接口包括：

| 方法 | 用途 |
| --- | --- |
| `initialize` | 协商进程协议和能力 |
| `task/submit` | 使用独立业务 `requestId` 提交任务 |
| `task/status` | 查询任务状态和结果 |
| `task/subscribe` | 按游标订阅任务事件 |
| `task/cancel` | 请求取消 |
| `task/resume` | 在原绑定与恢复规则允许的范围内继续任务 |

模型协议、地址、凭据、名称和工作区由可信启动配置绑定。最小 RPC 入口当前提供受授权的工作区读取／写入工具，不等于完整 Studio 工具目录。扩展工具、完整子任务控制或业务接口，需要宿主继续组装 Node SDK 的端口。

Python 接入方需要实现进程生命周期、请求关联、事件消费、错误映射与存储目录管理；当前仓库没有交付现成的 Python SDK。若 Python 产品包含网页，可以在其前端复用 UI 包，并由 Python／Node 宿主提供事件和控制桥接。

通过代码配置模型、角色、工具、权限、Hooks 和上下文端口，可以构建不同用途的 Agent；相应能力仍需要宿主实际注册和授权。
