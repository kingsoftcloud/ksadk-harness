// Bundle the engine task view into ONE self-contained HTML document.
// Output: packages/agentkit-harness-node/dist/engine-view.html, which the engine
// serves over agentkit.engine/v1 (`ui/view`). No network access at view time.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
const out = join(here, "../../agentkit-harness-node/dist/engine-view.html");
const result = await build({ entryPoints: [join(here, "../src/engine-view/app.mjs")], bundle: true, write: false, format: "iife",
  platform: "browser", target: ["es2020"], minify: true, legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"', "globalThis.__ENGINE_VIEW_VERSION__": JSON.stringify(pkg.version) } });
const { styles } = await import("../src/styles.mjs");
const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<title>Task</title><style>html,body{margin:0;padding:0;background:transparent}${styles}</style></head>
<body><div id="root"></div><script>${script}</script></body></html>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`engine view ${pkg.version}: ${html.length} bytes, sha256 ${createHash("sha256").update(html).digest("hex").slice(0, 16)}`);
