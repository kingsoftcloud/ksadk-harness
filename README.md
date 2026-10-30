# KSADK Native Harness

独立的 TypeScript Native 运行内核、Node 适配器、本地进程接口和任务过程界面。

- `@kingsoftcloud/agentkit-harness-core`：执行、状态和持久化契约。
- `@kingsoftcloud/agentkit-harness-node`：Node 适配器、Native 工具及 JSON-RPC/NDJSON 进程入口。
- `@kingsoftcloud/agentkit-harness-ui`：通过版本化事件接入的任务过程、思考、工具结果、终端输出与侧栏组件；React 由宿主提供。

运行环境为 Node.js 22.19 或更新版本。三个 npm 包独立构建和打包，Studio 的会话与产品资源适配由宿主负责。

本仓库保留运行实现、测试、构建脚本、许可证与第三方归属说明。
