# Harness 本地与云端拆分

Harness 独立发布执行服务、内核、工具适配器和任务视图。Studio 和 KSADK 保留各自的产品入口与治理，只通过版本化协议发起、观察、取消和继续 Run。对同一协议版本内的引擎修复，部署者只替换 Harness 产物，客户端使用原构建。

## 本地

Studio 或 KSADK 启动独立安装的 Harness，或连接配置的本地服务。桌面进程可以用现有的 JSON-RPC over stdio。服务模式使用同样的 JSON-RPC 方法，通过本机 HTTP 发送请求。工作区和状态目录由启动配置确定，模型密钥由执行服务在运行时读取。

## 云端

Harness 作为独立的 Runtime 工作负载和镜像部署，初期一个服务实例只管理一个已隔离的 Agent 工作区。复用 Runtime 的工作区隔离和持久卷，保持工作区、Run 账本与 Agent 的绑定。Harness 镜像应由 Harness 的独立发布渠道按摘要选取，Studio 和 KSADK 的镜像不安装 Harness。

| 层 | 责任 |
| --- | --- |
| agentengine-server、agentengine-gateway | 维持公开 Agent 会话、鉴权和 Responses 转发。已有 agent-kernel/v1 能力由 Runtime 适配层保持。 |
| agent-runtime-service、agent-platform-operator | 现有 AgentRuntime 宿主通过配置绑定同命名空间的 Harness 服务。独立 Helm 工作负载锁定镜像摘要，持久卷保留工作区和账本。 |
| agentengine-images | 独立 Harness 镜像与启动入口，通过不可变构建输入验证产物。 |
| agentkit-studio、ksadk-python | 用协议调用 Harness，保留宿主审批、业务工具、现有公开入口与旧会话迁移。 |
| ksadk-web、agentengine-hosted-ui | 保留会话和页面外壳，按能力加载 Harness 发布的视图，用沙箱 iframe 与版本化消息桥展示执行过程。 |

工作负载边界内的 Harness 服务不作为浏览器公开入口。运行时请求需要服务凭据。跨进程调用与模型调用使用不同凭据，工作区位置和模型连接配置由部署方绑定。控制面仍负责分配身份和判断访问范围。共享 PVC 不等于共享执行权限；升级须验证旧执行者停止后再由新执行者打开相同状态。 托管部署启用 Bubblewrap 命令策略，启动探测失败就拒绝就绪。命令只能写工作区和临时目录，模型凭据、账本和网络隔离在命令边界之外。

## 网络传输原型

- `GET /healthz` 报告服务进程状态、工具策略及宿主回调能力。检查能力无需创建会话。
- `POST /v1/sessions/{id}/rpc` 使用现有 `agentkit.engine/v1` JSON-RPC 请求与响应。首次初始化后执行 Start/Status/Events/Resume/Cancel 或获取任务视图。
- 图像模型在握手中提供 `capabilities.inputImages`，其中声明图片数量和编码字节上限。客户端仅把当前请求内的图片以 `run/start.inputImages` 提交，接受 PNG、JPEG、WebP、GIF 的内联数据。原始像素进入引擎账本和模型请求，公开任务流仅包含展示事件。
- 宿主用 `run/events` 的 `follow: true` 订阅正在执行的 Run。替换后的服务首次收到订阅时，从原账本接续可恢复的 Run；待审批、主动暂停和待核对的操作仍等待对应的决定。已有执行租约时，新服务等待租约到期。
- 宿主在 `initialize.services.durableApprovals` 声明支持后，引擎把内置工具的审批写入原 Run。宿主从 `run/status.pendingApproval` 获取待审批操作，用 `run/approve` 提交 `runId`、`interactionId` 和 `allow` 或 `deny`。服务重启后仍可提交。同一决定重复提交返回已有回执，反向决定会被拒绝。
- 宿主通过 `capabilities.toolPolicy` 协商规则版本，通过 `run/start.toolPolicy` 传入已冻结的 Agent 工具规则。严格模式和要求用户确认的规则需要持久审批能力。确认请求在 `pendingApproval` 标记 `requiresUserApproval`，由宿主请求同一会话的审批决定。直接干预内核流程控制的规则会在接入时明确拒绝。
- 部署方可用 `AGENTKIT_ENGINE_CHILD_ROLES` 配置允许的子任务角色。角色限定引擎模型和显式授权的工作区或命令工具。写入型子任务使用隔离工作区，合并到父工作区时单独审批。子任务的审批由父 Run 对外呈现，重启后保留原子 Run 和审批标识。恢复期间应保留原角色配置。
- `GET /v1/sessions/{id}/host-requests` 领取宿主回调。声明 `scopedHostRequests` 的服务接受 `runId` 和至多 5000 毫秒的 `waitMs`。回调带有 Unix 毫秒时间 `expiresAt`。`POST /v1/sessions/{id}/host-reply` 接收已领取且未过期的原请求 ID。已领取调用的响应失联时由 Run 的恢复规则处理。
- 协商 `agentkit.engine-context/v1` 后，宿主可在 `run/start.hostContext` 声明已锁定的上下文来源。宿主订阅 Run 后，引擎在准备模型上下文时发出 `host/readContext`，宿主核对来源、绑定摘要及授权，并返回限额内的片段。引擎使用本次模型的计数器核对完整内容，按来源的跳过、告警或失败策略处理异常。默认按资料呈现，只有冻结的指令授权可进入模型的系统层。
- 协商 `agentkit.engine-hooks/v1` 后，宿主可在 `run/start.hostHooks` 声明锁定的钩子。引擎在相应的持久执行步骤中发出 `host/invokeHook`，宿主使用已认证的会话身份和已绑定的授权策略运行回调。引擎核对操作标识和输入摘要，再决定是否应用参数变更或继续执行。写入型钩子失联时保留结果未知状态。
- `run/start.executionPolicy` 支持按 Build 固定模型调用次数、工具次数和运行时限。使用 `plan-act-observe` 时，引擎先记录一次无工具规划，再在同一 Run 执行；恢复时继续使用已提交的计划。
- 协商 `agentkit.engine-verification/v1` 后，宿主可为适用的目标声明必需验收。引擎通过 `host/verifyGoal` 传递当前候选的身份和限额内的已提交证据。回调仅执行读取验证，必须回传同一操作与输入摘要。修复由同一 Run 调度，验收通过后才投影最终回复。
- KSADK PluginHost 保留插件配置、MCP 凭据和平台资源授权。引擎只接收已绑定资源的工具定义，通过回调调用资源。平台记忆沿用绑定的 MCP Worker，读取和写入分别由资源租约及宿主写入授权控制。
- `GET /v1/views/{sha256}` 返回经过摘要校验的已归档视图。Run 持久保存自己的视图摘要。Studio 的本机路由和 KSADK 的 `/_ksadk/harness/v1/views/{sha256}` 同源代理都保留这个引用，浏览器只接收视图和公开展示事件。
- 除健康探测外均需 Bearer 认证。会话 ID 限制为 1 至 128 位字母、数字、下划线或短横线。服务自行派生状态子目录。服务默认只监听 loopback。独立云端端点支持配置 TLS 证书和密钥，Studio、KSADK 的远程连接要求 HTTPS。
- `AGENTKIT_ENGINE_MANAGED_CONFIG_FILE` 可为独立服务配置托管命令入口。配置包含固定的 `buildId` 和按签发密钥 ID 索引的 Ed25519 公钥 `controlPublicKeys`。命令、状态和事件同时要求服务认证及对应的 Server permit。此入口支持文本任务和持久命令账本。交互必须另有授权器，现有 Studio 会话投递及 Teams 回调的远程接入仍在迁移。

生产验收需覆盖独立安装、云端授权、工作区绑定、跨版本继续同一 Run、已成功工具不重放、视图更新，以及固定 Studio/KSADK 构建仅替换 Harness 镜像的一次完整回滚演练。
