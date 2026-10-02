#!/usr/bin/env node
// generator/gen-once.js — 命令行运行器
// 用法: node generator/gen-once.js "产品描述"
// 可选环境变量: STYLE_PACK=<风格包id> 强制指定风格包（见 style-packs.js 的 12 个 id）
//              DEEPSEEK_API_KEY 或 generator/.deepseek-key 提供 API key

const fs = require("fs");
const path = require("path");
const { generateAiFilm } = require("./codegen");

function getApiKey() {
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  const keyFile = path.join(__dirname, ".deepseek-key");
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, "utf8").trim();
  }
  console.error("API key 未找到：请设置 DEEPSEEK_API_KEY 或创建 generator/.deepseek-key");
  process.exit(1);
}

async function main() {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error("用法: node generator/gen-once.js \"产品描述\"");
    console.error('示例: STYLE_PACK=ink-wash node generator/gen-once.js "理财产品宣传片"');
    process.exit(1);
  }
  const apiKey = getApiKey();
  const stylePack = process.env.STYLE_PACK || "(随机)";
  console.error(`[gen-once] 产品描述: ${prompt}`);
  console.error(`[gen-once] 风格包: ${stylePack}`);
  const t0 = Date.now();
  const result = await generateAiFilm({ apiKey, prompt });
  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  console.error(`[gen-once] 完成: ${result.summary.sceneCount} 场景 / ${result.summary.duration} / 用时 ${dt}s`);
  console.error(`[gen-once] 风格包: ${result.stylePack}`);
  console.log(JSON.stringify({ projectPath: result.projectPath, stylePack: result.stylePack, compositionId: result.summary.compositionId, ...result.summary }, null, 2));
}

main().catch((err) => {
  console.error("[gen-once] 失败:", err.message);
  process.exit(1);
});
