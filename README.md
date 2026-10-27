# KSADK Native Harness

独立的 TypeScript Native 运行内核、Node 适配器和本地进程接口。

- `@kingsoftcloud/agentkit-harness-core`：执行、状态和持久化契约。
- `@kingsoftcloud/agentkit-harness-node`：Node 适配器、Native 工具及 JSON-RPC/NDJSON 进程入口。

使用 Node.js 22.19 或更新版本。

```sh
npm ci --ignore-scripts
npm run build
npm run test:core
npm run test:node
```

浏览器真实运行测试可单独执行 `npm run test:browser-live`，需要本机可用的 Chromium。普通测试覆盖浏览器适配器的确定性行为。

构建后可分别对两个工作区执行 `npm pack`，并在外部 Node 程序中安装产物。详细接口见 Node 包 README。Studio 的会话和产品资源适配由 Studio 负责。

本仓库沿用源代码中保留的许可证与第三方归属说明。
