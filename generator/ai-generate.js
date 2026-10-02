#!/usr/bin/env node
// generator/ai-generate.js
// 使用 DeepSeek API 根据自然语言描述自动生成 Remotion 动画工程
// 用法: node ai-generate.js "你的产品描述" [-o 输出目录] [--config-only]

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { validateConfig } = require("./schema");
const { computeTimeline, computeTotalFrames, computeVoiceTracks } = require("./timeline");

// ============================================================
//  API Key 读取
// ============================================================
function getApiKey() {
  // 1. 环境变量优先
  const envKey = process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  // 2. 从本地文件读取
  const keyFile = path.join(__dirname, ".deepseek-key");
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, "utf8").trim();
  }
  throw new Error(
    "DeepSeek API key 未找到。\n" +
    "请设置环境变量 DEEPSEEK_API_KEY，或创建 generator/.deepseek-key 文件写入 key。"
  );
}

// ============================================================
//  System Prompt — 描述完整配置 Schema 供 DeepSeek 生成
// ============================================================
const SYSTEM_PROMPT = `你是一个 Remotion 动画视频配置生成器。根据用户的产品描述，生成一个完整的 JSON 配置文件，用于驱动 Remotion 动画工程。

## 配置顶层结构

\`\`\`json
{
  "id": "PascalCase唯一标识符",
  "title": "左上角工程标题",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "theme": { "bg": "", "panel": "", "panel2": "", "line": "", "text": "", "muted": "", "purple": "", "blue": "", "green": "", "orange": "", "pink": "" },
  "scenes": [],
  "voice": { "enabled": true, "voiceName": "Microsoft Huihui Desktop", "tracks": [] }
}
\`\`\`

## 场景结构

每个场景：
\`\`\`json
{ "name": "英文小写唯一名", "durationInFrames": 120, "overlap": 15, "elements": [] }
\`\`\`

## 可用元素类型（9 种）

### 1. title — 居中渐入大标题
props: { "eyebrow": "上方小标题", "text": "主标题文字", "fontSize": 60, "duration": 120 }

### 2. subtitle — 底部居中字幕（淡入淡出）
props: { "text": "字幕文字", "start": 20, "end": 110, "fontSize": 30 }
注意：start/end 是相对场景起始帧的偏移量

### 3. codeWindow — 代码编辑器窗口（SVG 元素）
props: { "title": "窗口标题", "x": 230, "y": 190, "w": 650, "h": 560, "lines": ["代码行1", "", "代码行3"] }
lines 中以 "+" 开头显示绿色，以 "-" 开头显示橙色，其他正常色

### 4. agentPanel — Agent 对话面板（SVG 元素）
props: { "title": "Agent · workspace", "x": 1060, "y": 190, "w": 570, "h": 560, "request": "用户请求", "subtext": "补充说明", "status": "状态文字", "files": ["+ 文件路径1", "✓ 测试通过"] }

### 5. previewCard — 浅色浏览器预览卡片（SVG 元素）
props: { "heading": "预览标题", "eyebrow": "右上角小字", "button": "按钮文字", "x": 1030, "y": 270 }

### 6. codeFlow — 代码流动条形背景（SVG 元素）
props: { "count": 8, "speed": 5 }

### 7. particles — 环形粒子效果（SVG 元素）
props: { "count": 18, "cx": 1365, "cy": 490, "radius": 260, "duration": 140 }

### 8. callout — 顶部居中说明文字
props: { "text": "说明文字", "top": 90, "fontSize": 27, "duration": 150 }

### 9. brandEnd — 品牌收尾画面（弹性进入）
props: { "brand": "品牌名", "heading": "主标语", "subtext": "副标语", "duration": 115 }

## 坐标系统
- 画布: 1920 × 1080 像素
- SVG 元素 (codeWindow, agentPanel, previewCard, codeFlow, particles) 的 x/y 坐标基于此画布
- 安全区: x=200~1700, y=150~900
- 居中窗口建议: x=230~1060, y=190, w=570~650, h=560

## 创作要求
1. 生成 4-6 个场景，按叙事顺序排列
2. 总时长 15-25 秒（450-750 帧）
3. 每个场景必须包含一个 subtitle 元素
4. 第一个场景用 title 元素展示产品理念
5. 最后一个场景用 brandEnd 元素展示品牌标语
6. 中间场景用 codeWindow + agentPanel + previewCard + codeFlow + particles + callout 灵活组合
7. subtitle 的 text 必须与对应 voice track 的 text 逐字一致
8. 颜色主题要与产品调性匹配（科技→蓝紫系, 温暖→橙粉系, 健康→绿色系, 金融→蓝金系）
9. voice.voiceName 固定填 "Microsoft Huihui Desktop"
10. 最后一个场景的 overlap 设为 0，其他建议设为 15
11. subtitle 的 start 和 end 要在场景的 durationInFrames 范围内

## 示例配置
\`\`\`json
{
  "id": "SmartHomeFilm",
  "title": "SMART HOME / PRODUCT FILM",
  "width": 1920, "height": 1080, "fps": 30,
  "theme": { "bg": "#08090d", "panel": "#11131a", "panel2": "#171a23", "line": "#282c38", "text": "#f4f4f6", "muted": "#8d93a3", "purple": "#9b8cff", "blue": "#6dd8ff", "green": "#75e1a0", "orange": "#ffbd7c", "pink": "#f59ee1" },
  "scenes": [
    { "name": "idea", "durationInFrames": 120, "overlap": 15, "elements": [
      { "type": "title", "props": { "eyebrow": "FROM AN IDEA", "text": "Make your home smarter.", "fontSize": 60, "duration": 120 } },
      { "type": "subtitle", "props": { "text": "从一个想法开始", "start": 20, "end": 110 } }
    ]},
    { "name": "agent", "durationInFrames": 150, "overlap": 15, "elements": [
      { "type": "codeWindow", "props": { "title": "smarthome / workspace", "x": 230, "y": 190, "w": 650, "h": 560, "lines": ["import { Agent } from \\"cursor\\";", "", "export default function Home() {", "  return <SmartHomeConfig />;", "}"] } },
      { "type": "agentPanel", "props": { "title": "Agent · workspace", "x": 1060, "y": 190, "w": 570, "h": 560, "request": "Build a smart home dashboard", "subtext": "with lighting, temperature, and security controls.", "status": "Reading codebase", "files": ["+ src/components/LightControl.tsx", "+ src/components/ThermoPanel.tsx", "✓ tests passed"] } },
      { "type": "callout", "props": { "text": "Agent builds your smart home.", "top": 90, "fontSize": 27, "duration": 150 } },
      { "type": "subtitle", "props": { "text": "Agent 理解你的需求，帮你构建智能家居", "start": 30, "end": 135 } }
    ]},
    { "name": "end", "durationInFrames": 120, "overlap": 0, "elements": [
      { "type": "brandEnd", "props": { "brand": "SMARTHOME", "heading": "Control everything.", "subtext": "从想法到家，始终更接近你的生活", "duration": 115 } },
      { "type": "subtitle", "props": { "text": "SmartHome，让家更智能", "start": 15, "end": 100 } }
    ]}
  ],
  "voice": { "enabled": true, "voiceName": "Microsoft Huihui Desktop", "tracks": [
    { "scene": "idea", "text": "从一个想法开始" },
    { "scene": "agent", "text": "Agent 理解你的需求，帮你构建智能家居" },
    { "scene": "end", "text": "SmartHome，让家更智能。" }
  ]}
}
\`\`\`

## 输出要求
只输出纯 JSON，不要 markdown 代码块，不要任何解释文字。JSON 必须可以通过 JSON.parse 解析。`;

// ============================================================
//  调用 DeepSeek API
// ============================================================
async function callDeepSeek(apiKey, userPrompt, maxRetries = 2) {
  const url = "https://api.evomap.ai/v1/chat/completions";
  const body = {
    model: "evomap-glm-5.2",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7,
    response_format: { type: "json_object" },
    // 注意: evomap-glm-5.2 是推理模型，思考(reasoning_content)与答案(content)共享
    // max_tokens。预算太小会导致 content 为空（finish_reason=length），无法解析 JSON。
    max_tokens: 16384
  };

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`  重试 ${attempt}/${maxRetries}（加大 token 预算）...`);
        // 空内容通常是推理耗尽预算，重试时加大上限
        body.max_tokens = 32768;
      }
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const content = data.choices[0].message.content;

      if (!content) {
        throw new Error("API 返回空内容");
      }

      return content;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  throw new Error(`DeepSeek API 调用失败（重试 ${maxRetries} 次后）: ${lastErr.message}`);
}

// ============================================================
//  从 LLM 响应中提取 JSON
// ============================================================
function extractConfig(text) {
  // 1. 尝试直接解析
  try {
    return JSON.parse(text);
  } catch {}

  // 2. 尝试从 markdown 代码块中提取
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]);
    } catch {}
  }

  // 3. 尝试提取第一个 { 到最后一个 }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.substring(start, end + 1));
    } catch {}
  }

  throw new Error("无法从 DeepSeek 响应中提取有效 JSON");
}

// ============================================================
//  主流程
// ============================================================
async function main() {
  const args = process.argv.slice(2);
  let prompt = null;
  let outDir = "generated-project";
  let configOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && args[i + 1]) { outDir = args[i + 1]; i++; }
    else if (args[i] === "--config-only") { configOnly = true; }
    else if (!args[i].startsWith("-")) { prompt = args[i]; }
  }

  if (!prompt) {
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("  DeepSeek AI → Remotion 动画生成器");
    console.error("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.error("");
    console.error("用法: node generator/ai-generate.js \"产品描述\" [-o 输出目录] [--config-only]");
    console.error("");
    console.error("示例:");
    console.error('  node generator/ai-generate.js "做一个智能家居APP的产品宣传片"');
    console.error('  node generator/ai-generate.js "做一个在线教育平台的产品视频" -o my-film');
    console.error('  node generator/ai-generate.js "做一个健身追踪应用的宣传片" --config-only');
    console.error("");
    console.error("选项:");
    console.error("  -o <目录>       输出目录（默认 generated-project）");
    console.error("  --config-only   只生成配置 JSON，不生成 Remotion 工程");
    process.exit(1);
  }

  const apiKey = getApiKey();

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  DeepSeek AI → Remotion 动画生成器");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log(`  产品描述: ${prompt}`);
  console.log(`  输出目录: ${outDir}`);
  console.log(`  模式: ${configOnly ? "仅配置" : "完整工程"}`);
  console.log("");

  // ---- 步骤 1: 调用 DeepSeek 生成配置 ----
  console.log("[1/3] 正在调用 DeepSeek API 生成配置...");
  const llmResponse = await callDeepSeek(apiKey, prompt);
  console.log("  ✓ DeepSeek 响应已接收");

  // ---- 步骤 2: 提取并验证配置 ----
  console.log("[2/3] 正在解析并验证配置...");
  let config;
  try {
    config = extractConfig(llmResponse);
  } catch (e) {
    console.error("  ✗ 无法从 DeepSeek 响应中提取 JSON");
    console.error("  原始响应已保存到 generator/debug-response.txt");
    fs.writeFileSync(
      path.join(__dirname, "debug-response.txt"),
      llmResponse, "utf8"
    );
    process.exit(1);
  }

  // 自动修复 voice tracks — 如果缺少 scene 字段，按索引映射到场景
  if (config.voice && config.voice.enabled && config.voice.tracks && config.scenes) {
    config.voice.tracks.forEach((track, i) => {
      if (!track.scene && config.scenes[i]) {
        track.scene = config.scenes[i].name;
      }
      delete track.start;
      delete track.duration;
    });
  }

  try {
    validateConfig(config);
  } catch (e) {
    console.error("  ✗ 配置验证失败:", e.message);
    const debugFile = path.join(__dirname, "debug-config.json");
    fs.writeFileSync(debugFile, JSON.stringify(config, null, 2), "utf8");
    console.error(`  原始配置已保存到 ${debugFile} 供调试`);
    process.exit(1);
  }
  console.log("  ✓ 配置验证通过");

  // ---- 保存配置文件 ----
  const outAbs = path.resolve(outDir);
  fs.mkdirSync(outAbs, { recursive: true });
  const configFile = path.join(outAbs, "ai-config.json");
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
  console.log(`  ✓ 配置已保存: ${configFile}`);

  // ---- 打印配置摘要 ----
  const timeline = computeTimeline(config.scenes);
  const totalFrames = computeTotalFrames(timeline);
  const voiceTracks = computeVoiceTracks(config, timeline);

  console.log("");
  console.log("  ┌────────────────────────────────┐");
  console.log("  │        配置摘要                │");
  console.log("  └────────────────────────────────┘");
  console.log(`  Composition ID : ${config.id}`);
  console.log(`  标题           : ${config.title}`);
  console.log(`  场景数         : ${config.scenes.length}`);
  config.scenes.forEach((s, i) => {
    const tl = timeline[i];
    console.log(`    ${i + 1}. ${s.name.padEnd(12)} 帧 ${String(tl.from).padStart(3)}-${String(tl.from + tl.durationInFrames).padStart(3)}  (${s.elements.length} 元素)`);
  });
  console.log(`  总帧数         : ${totalFrames} (${(totalFrames / config.fps).toFixed(1)}秒 @ ${config.fps}fps)`);
  console.log(`  配音轨道       : ${voiceTracks.length}`);
  console.log("");

  if (configOnly) {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  ✓ 配置生成完成（--config-only 模式）");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");
    console.log("后续步骤:");
    console.log(`  node generator/generate.js "${configFile}" -o ${outDir}`);
    return;
  }

  // ---- 步骤 3: 生成 Remotion 工程 ----
  console.log("[3/3] 正在生成 Remotion 工程...");
  const generateScript = path.join(__dirname, "generate.js");
  const rootDir = path.dirname(__dirname);
  execSync(`node "${generateScript}" "${configFile}" -o "${outDir}"`, {
    stdio: "inherit",
    cwd: rootDir
  });

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ✅ Remotion 工程生成完成!");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log(`  输出目录: ${outAbs}`);
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  运行步骤");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
  console.log("  1. 进入目录:");
  console.log(`     cd /d ${outAbs}`);
  console.log("");
  console.log("  2. 链接已有依赖（免安装）:");
  console.log(`     mklink /J node_modules D:\\study\\new\\node_modules`);
  console.log("");
  console.log("  3. 生成中文配音:");
  console.log(`     powershell scripts\\generate-voice.ps1`);
  console.log("");
  console.log("  4. 渲染 MP4:");
  console.log(`     npx remotion render src/index.ts ${config.id} out/film.mp4`);
  console.log("");
  console.log("  5. 或在 Studio 中预览:");
  console.log(`     npx remotion studio src/index.ts`);
  console.log("");
}

main().catch(err => {
  console.error("");
  console.error("错误:", err.message);
  process.exit(1);
});
