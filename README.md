# KSADK Native Harness

独立的 TypeScript Native 运行内核、Node 适配器、本地进程接口和任务过程界面。

- `@kingsoftcloud/agentkit-harness-core`：执行、状态和持久化契约。
- `@kingsoftcloud/agentkit-harness-node`：Node 适配器、Native 工具及 JSON-RPC/NDJSON 进程入口。
- `@kingsoftcloud/agentkit-harness-ui`：通过版本化事件接入的任务过程、思考、工具结果、终端输出与侧栏组件；React 由宿主提供。

使用 Node.js 22.19 或更新版本。

```sh
npm ci --ignore-scripts
npm run build
npm run test:core
npm run test:node
npm run test:ui
```

浏览器真实运行测试可单独执行 `npm run test:browser-live`，需要本机可用的 Chromium。普通测试覆盖浏览器适配器的确定性行为。

构建后可分别对三个工作区执行 `npm pack`。Core 与 Node 可安装到独立 Node 程序；UI 由浏览器宿主消费。详细接口见各包 README。Studio 的会话和产品资源适配由 Studio 负责，包不依赖 Studio 或 DSH。当前不发布 npm、不接入 Python。

本仓库沿用源代码中保留的许可证与第三方归属说明。
