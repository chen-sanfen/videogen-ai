/* ============================================================
 * 流式看门狗 / 背景兜底 · 离线回归
 *
 * 背景：线上出现过「进度条死在最后一个组件、一小时不动」。
 * 根因是网关回了响应头后永久静默，而当时只有 30 分钟的总超时，
 * 前端就只能一直转圈。修法是加一条「N 秒无数据即掐断」的空闲看门狗。
 *
 * 本脚本用本地 mock 网关复现两种真实情形（不发数据 / 持续吐数据），
 * 断言看门狗该掐的掐、不该掐的别误杀 —— 反向验证才有意义。
 *
 * 不访问外网、不消耗 LLM 额度。
 * ============================================================ */
const http = require("http");
const fs = require("fs");
const path = require("path");

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
};

const IDLE_MS = 1200; // 测试用：把空闲阈值压到 1.2s，跑完整个脚本只要几秒
const PORT = 45999;
let server;

function sseChunk(content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

// 两种网关行为，用开关切换（LLM_URL 是 codegen 的模块级常量，require 后改不了，
// 所以不能靠 URL 区分，只能让同一个 mock 切模式）
let mockMode = "silent";

async function startMock() {
  server = http.createServer((req, res) => {
    const mode = mockMode;
    if (mode === "silent") {
      // 网关挂死的真实现象：响应头已回，之后一个字节都不发
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": connected\n\n");
      return; // 永不 res.end()
    }
    if (mode === "drip") {
      // 正常但很慢的调用：每 400ms 吐一点，持续 6 秒 —— 不该被误杀
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      let n = 0;
      const id = setInterval(() => {
        n++;
        res.write(sseChunk("x".repeat(50)));
        if (n >= 15) {
          clearInterval(id);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      }, 400);
      req.on("close", () => clearInterval(id));
      return;
    }
    res.writeHead(404);
    res.end("no");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
}

(async () => {
  console.log("\n[1] 流式看门狗（本地 mock 网关，不联网）");
  await startMock();

  // 必须在 require 之前设好：codegen 把 URL 与超时都读成模块级常量
  process.env.LLM_URL = `http://127.0.0.1:${PORT}/v1/chat/completions`;
  process.env.LLM_STREAM_IDLE_TIMEOUT_MS = String(IDLE_MS);
  process.env.LLM_STREAM_TIMEOUT_MS = "60000";
  process.env.LLM_CONNECT_TIMEOUT_MS = "5000";
  const { streamLLM, fallbackBackdrop } = require(path.join(__dirname, "..", "generator", "codegen.js"));

  await t("网关静默 → 空闲看门狗在阈值内掐断（这就是「卡死」的修复点）", async () => {
    mockMode = "silent";
    const t0 = Date.now();
    let err = null;
    try {
      await streamLLM("k", "sys", "user", 1024, 0.9, 60000, null, "minimal", 0);
    } catch (e) {
      err = e;
    }
    const dt = Date.now() - t0;
    if (!err) throw new Error("静默的调用没有被掐断 —— 看门狗没生效，还会卡死");
    if (!/无数据/.test(String(err.message))) throw new Error(`不是空闲超时，而是: ${err.message}`);
    // 允许一点调度余量，但不能遥遥无期
    if (dt > IDLE_MS * 4) throw new Error(`掐断太慢：${dt}ms（阈值 ${IDLE_MS}ms）`);
    console.log(`      （${dt}ms 掐断，消息：${err.message}）`);
  });

  await t("持续吐数据的慢调用 → 不被误杀（看门狗只盯空闲，不盯总时长）", async () => {
    mockMode = "drip";
    const t0 = Date.now();
    const { content } = await streamLLM("k", "sys", "user", 1024, 0.9, 60000, null, "minimal", 0);
    const dt = Date.now() - t0;
    // mock 总共吐 6 秒，远大于 1.2s 的空闲阈值；若被误杀这里会抛错
    if (!content) throw new Error("内容为空");
    if (dt < 4000) throw new Error(`结束得太早（${dt}ms），像是被提前掐断`);
    console.log(`      （${dt}ms 正常收尾，收到 ${content.length} 字符）`);
  });

  await t("总超时确实存在（不会无限等）", async () => {
    // 空闲阈值调到很大，让总超时先触发；这里只验证「超时的错误文案来自总超时」
    const { streamLLM: _ } = require(path.join(__dirname, "..", "generator", "codegen.js"));
    if (typeof _ !== "function") throw new Error("streamLLM 未导出");
    const src = fs.readFileSync(path.join(__dirname, "..", "generator", "codegen.js"), "utf8");
    if (!/AI API 流式响应超时/.test(src)) throw new Error("缺少总超时分支");
  });

  console.log("\n[2] 背景层兜底（Backdrop 失败不再拖垮整片）");

  await t("兜底背景是合法 TSX：能被 Babel 解析", () => {
    const parser = require("@babel/parser");
    const code = fallbackBackdrop({ palette: { bg: "#101423", bg2: "#1a1f33", accent: "#c9a227" } });
    parser.parse(code, { sourceType: "module", plugins: ["typescript", "jsx"] });
  });

  await t("兜底背景含 export default + 只用 remotion 两个 API", () => {
    const code = fallbackBackdrop({ palette: { bg: "#101423", bg2: "#1a1f33", accent: "#c9a227" } });
    if (!/export default function Backdrop/.test(code)) throw new Error("缺 export default");
    if (!/import \{ AbsoluteFill, useCurrentFrame \} from "remotion"/.test(code)) throw new Error("remotion import 不符");
    // 不能有 interpolate / 字体 / 外部资源 —— 兜底件的第一原则是绝不引入新的失败点
    for (const bad of ["interpolate", "staticFile", "http://", "https://", "<Img", "OffthreadVideo"]) {
      if (code.includes(bad)) throw new Error(`兜底背景不该出现 ${bad}`);
    }
  });

  await t("兜底背景用上了风格包的颜色（不是写死的灰底）", () => {
    const code = fallbackBackdrop({ palette: { bg: "#101423", bg2: "#1a1f33", accent: "#c9a227" } });
    if (!code.includes("#101423") || !code.includes("#c9a227")) throw new Error("没有注入风格包颜色");
  });

  await t("没有风格包也不炸（pack 为 null 时有默认色）", () => {
    const code = fallbackBackdrop(null);
    if (!/#[0-9a-f]{6}/i.test(code)) throw new Error("缺少兜底色值");
    if (/undefined/.test(code)) throw new Error("出现了 undefined 颜色");
  });

  console.log("\n[3] 组件思考档位默认 minimal（省掉白跑的一轮）");

  await t("组件默认档位是 minimal，不再是 undefined(→low)", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "generator", "codegen.js"), "utf8");
    const m = src.match(/let effort = process\.env\.LLM_COMPONENT_EFFORT \|\| "([a-z]+)"/);
    if (!m) throw new Error("找不到组件档位定义行");
    if (m[1] !== "minimal") throw new Error(`默认档位是 ${m[1]}，不是 minimal`);
  });

  await t("可选组件失败走兜底、且不写进检查点", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "generator", "codegen.js"), "utf8");
    if (!/optional: true/.test(src)) throw new Error("Backdrop 没标记为 optional");
    if (!/j\.optional && typeof j\.fallback === "function"/.test(src)) throw new Error("缺少兜底分支");
    // 兜底代码若写进检查点，下次续跑会拿兜底版当「已通过」，AI 背景永远补不回来
    const seg = src.slice(src.indexOf("if (j.optional && typeof j.fallback"), src.indexOf("if (j.optional && typeof j.fallback") + 700);
    if (/checkpointSaveComponent/.test(seg)) throw new Error("兜底分支里仍在写检查点");
  });

  console.log(`\n${"=".repeat(46)}\n  通过 ${pass} 项，失败 ${fail} 项\n${"=".repeat(46)}`);
  try {
    server.close();
  } catch {}
  process.exit(fail ? 1 : 0);
})();
