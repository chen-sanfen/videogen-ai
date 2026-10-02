// generator/codegen.js — AI 直接编写真实 Remotion 组件源码（无模板）
// 架构: 两阶段并行
//   阶段1 规划调用: 产品描述 + 随机创意方向 → 分镜脚本 JSON（快，~10-30s）
//   阶段2 组件调用: 每个分镜一个独立调用 + 背景一个调用（默认并发 8，一波跑完；输出长度有纪律约束）
// 校验: esbuild TSX 语法 / 契约 / 禁用 API / tsc 作用域 → 单组件失败只重试该组件
// 随机性: 每次调用都重新抽「风格包 + 叙事手法 + 视觉母题 + 剪辑节奏 + 色彩处理 + 随机种子」，
//         同一输入也不会得到同样的视觉语言（检查点只在保鲜期内有效，过期即重新随机）。
//
// Web 端两段式流程（generateAiFilm 选项 + renderProjectMp4）：
//   ① 生成预览：withSmoke=false → 只落盘工程文件，不渲染 MP4；
//      前端用 @remotion/player 直接播放同一份 AI 组件，秒级看到画面。
//   ② 渲染导出：renderProjectMp4() → bundle → renderMedia → out/film.mp4（带进度）。
//   预览与导出消费同一份组件代码，预览所见即最终渲染所得。
//   配音（TTS）与配乐都是按需开关：用户在页面上勾选「生成配音 / 背景音乐」才产出，
//   具体合成见 generator/voice.js（神经语音 + 程序化配乐）。
//
// 实时反馈：streamLLM 的 onDelta(chunk, isReasoning) 同时回传正文与「思考」增量——
//   优化描述用它边生成边显示；组件生成用它每 2s 上报「思考中 / 已写 N 字符」，长调用不再像卡死。
//
// 思考强度（reasoning_effort）务必按任务分开设置：本网关对 "low" 会真的产出上万字思考
//   （同样一次改写实测 low 104s、minimal 11.5s 且正文更长），所以短改写类任务用 LLM_OPTIMIZE_EFFORT=minimal，
//   写代码仍保留 low 以保证质量。
//
// 网络可观测性：生成前先做一次极小请求预检（LLM_SKIP_PREFLIGHT=1 可跳过），
// 网络不可达 / key 失效 / 模型名错误会立刻带明确原因抛出，不再伪装成"分镜规划未通过校验"。
// 断点续跑：规划结果 + 已通过组件存到 generator/.checkpoint/，同 prompt、同时长、同「素材/字幕签名」
//         且检查点在保鲜期内（LLM_RESUME_WINDOW_MS，默认 10 分钟）才接着上次跑；LLM_FRESH=1 强制从零开始。
//         签名不一致（例如这次新加了素材或打开了「直接使用」）就作废重来——复用的组件也一律重新过校验，
//         否则会把上一版不符合本次约束的代码搬进新工程（表现为「明明勾了直接使用素材，画面里却没有素材」）。
// 网络类失败不占用校验重试配额，单独等待重试（LLM_NET_RETRY / LLM_NET_RETRY_WAIT_MS）。
// tsc 作用域检查是异步子进程（限流 TSC_CONCURRENCY=4）：同步 spawnSync 会阻塞事件循环 ~1s，
// 期间所有并行的 LLM 流式响应都读不到数据，还会被连接超时误判成"网络故障"。
// 代理：Node 不读 Windows 系统代理，必须显式配置——LLM_PROXY（优先，支持 http://user:pass@host:port）
//       或继承 HTTPS_PROXY / HTTP_PROXY；LLM_NO_PROXY 配直连白名单。预检与生成都走同一套。
// 相关环境变量：LLM_CONNECT_TIMEOUT_MS(60000) LLM_PREFLIGHT_TIMEOUT_MS(15000)
//             LLM_CONNECT_FAIL_LIMIT(3) LLM_MAX_RETRY(6) LLM_REASONING_EFFORT(low)
//             LLM_OPTIMIZE_EFFORT(minimal=改写类任务用最省思考档，实测快 9 倍)
//             LLM_NET_RETRY(4) LLM_NET_RETRY_WAIT_MS(20000) SMOKE_ROUNDS(2)
//             PLAN_ATTEMPTS(2) COMPONENT_ATTEMPTS(3) COMPONENT_CONCURRENCY(8) TSC_CONCURRENCY(4)
//             LLM_CHECKPOINT_DIR(generator/.checkpoint) LLM_FRESH(1=从零开始) LLM_SKIP_PREFLIGHT(1=跳过预检)
//             LLM_RESUME_WINDOW_MS(600000=检查点保鲜期) STYLE_PACK(强制指定风格包)
//             LLM_PROXY / LLM_NO_PROXY LLM_URL LLM_MODEL

const fs = require("fs");
const path = require("path");
// decodePng() 里要 inflate PNG 的 IDAT 数据块，必须显式 require ——
// 少这一行会让素材可见性门槛每次都抛 "zlib is not defined"，
// 被上层的 catch 当成"渲染环境不可用"静默跳过，门槛等于从没生效过。
const zlib = require("node:zlib");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const { spawnSync, spawn } = require("child_process");
const esbuild = require("esbuild");
// 配音 / 配乐合成（神经语音 TTS + 程序化 BGM），全部走异步子进程
const voiceKit = require("./voice.js");
// 素材相关的复用件：describeGrid（九宫格特征转文字）、extractBrief（看懂素材，优化描述与重绘共用）
const { describeGrid, extractBrief } = require("./asset-redraw.js");

const ROOT = path.resolve(__dirname, "..");
const LLM_URL = process.env.LLM_URL || "https://api.evomap.ai/v1/chat/completions";
const LLM_MODEL = process.env.LLM_MODEL || "evomap-glm-5.2";
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
// 流式「空闲」超时：只要还在吐数据就不掐，连续 N 秒一个字节都没有才判定卡死。
// 这是整个流程最容易踩的坑——网关偶发「响应头已回、然后永久静默」，
// 只有总超时的话，用户看到的就是进度条停在最后一个组件、一小时不动。
// 空闲判据才是对的：真在写代码的调用每几秒必有增量，静默的才是真挂了。
const STREAM_IDLE_TIMEOUT_MS = Number(process.env.LLM_STREAM_IDLE_TIMEOUT_MS) || 90000;
// 流式总超时（兜底）：正常组件 30~60s 写完，留 6 分钟足够覆盖超大组件
const STREAM_TIMEOUT_MS = Number(process.env.LLM_STREAM_TIMEOUT_MS) || 360000;
const CONNECT_TIMEOUT_MS = Number(process.env.LLM_CONNECT_TIMEOUT_MS) || 60000; // 连接/首包超时（响应开始后失效）
const PREFLIGHT_TIMEOUT_MS = Number(process.env.LLM_PREFLIGHT_TIMEOUT_MS) || 15000; // 生成前的连通性预检超时
// 组件并发：一次生成 N 场景 + 1 背景，每个调用动辄几分钟；
// 并发开到 8 基本能一波跑完（原来 4 要跑两波，第二波被最慢的那个拖住）。
// 如果网关返回 429（并发限流），把它调低即可。
const COMPONENT_CONCURRENCY = Number(process.env.COMPONENT_CONCURRENCY) || 8;
// 连接层故障连续多少次就放弃（避免断网时把退避重试配额全烧光）
const CONNECT_FAIL_LIMIT = Number(process.env.LLM_CONNECT_FAIL_LIMIT) || 3;
// 网络类失败不占用"校验重试"配额，单独等待重试（链路抖动时不要把重试机会吃光）
const NET_RETRY_LIMIT = Number(process.env.LLM_NET_RETRY) || 4;
const NET_RETRY_WAIT_MS = Number(process.env.LLM_NET_RETRY_WAIT_MS) || 20000;
// 断点续跑：规划结果 + 已通过组件落盘（链路抖动/进程中断后接着跑，不用从头重烧额度）
const CHECKPOINT_DIR = process.env.LLM_CHECKPOINT_DIR || path.join(__dirname, ".checkpoint");
const CHECKPOINT_STATE = path.join(CHECKPOINT_DIR, "state.json");
const CHECKPOINT_COMPONENT_DIR = path.join(CHECKPOINT_DIR, "components");
// 思考看门狗：单个组件思考超过这么多字符还没开始写代码，就判定为病理性长尾
// （实测偶发：思考 7 万字、单次调用卡 5 分钟以上，把整条流程拖成十几分钟），
// 直接中止并换最省思考的档位重试。
const MAX_THINKING_CHARS = Number(process.env.LLM_MAX_THINKING_CHARS) || 12000;
// 断点续跑的保鲜期：超过这个时间就认为用户是"想重新生成一版"，而不是"接着上次跑"
const RESUME_WINDOW_MS = Number(process.env.LLM_RESUME_WINDOW_MS) || 10 * 60 * 1000;

const LLM_HOST = new URL(LLM_URL).hostname;

// ============================================================
//  代理（CONNECT 隧道）
//  Node 的 http/https 请求既不读 Windows 系统代理注册表、也不读系统"代理"开关，
//  所以「开着 Clash/V2Ray 的系统代理」对生成是无效的——必须显式告诉 Node 走代理。
//  LLM_PROXY 优先（例：http://127.0.0.1:7897，Clash 的混合端口；支持 http://user:pass@host:port），
//  其次继承 HTTPS_PROXY / HTTP_PROXY（大小写都认）。只支持 http:// 代理（Clash 混合口即可）。
//  LLM_NO_PROXY / NO_PROXY 可配直连白名单（逗号分隔，支持 example.com 与 .example.com，* = 全部直连）。
// ============================================================
function parseProxyUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(/^\w+:\/\//.test(raw) ? raw : `http://${raw}`);
    if (u.protocol !== "http:") {
      console.error(`  [net] 暂不支持 ${u.protocol}// 代理（只支持 http:// 的 CONNECT 隧道；Clash/V2Ray 用它的 HTTP 端口即可）：已忽略，直连`);
      return null;
    }
    const port = Number(u.port) || 80;
    return {
      host: u.hostname,
      port,
      auth: u.username
        ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || "")}`).toString("base64")}`
        : null,
      label: `${u.hostname}:${port}`,
    };
  } catch (e) {
    console.error(`  [net] 代理地址无法解析（${errLine(e)}）：已忽略，直连`);
    return null;
  }
}

const PROXY_ENV = process.env.LLM_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
const PROXY_EXPLICIT = Boolean(process.env.LLM_PROXY); // 显式 LLM_PROXY：连回环地址也照走（便于本地调试）
const PROXY_URL = parseProxyUrl(PROXY_ENV);
const PROXY_BYPASS = String(process.env.LLM_NO_PROXY || process.env.NO_PROXY || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// 该目标主机是否要走代理（纯函数，便于测试）
function proxyFor(host, { explicit = PROXY_EXPLICIT, proxy = PROXY_URL, bypass = PROXY_BYPASS } = {}) {
  if (!proxy) return null;
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  // 继承来的代理不该拦截本地回环（本地网关 / 测试用 mock 不该被绕出去）
  if (!explicit && (h === "127.0.0.1" || h === "localhost" || h === "::1" || h.endsWith(".localhost"))) return null;
  for (const p of bypass) {
    if (p === "*") return null;
    if (p.startsWith(".") ? h.endsWith(p) || h === p.slice(1) : h === p) return null;
  }
  return proxy;
}

// 经代理建 CONNECT 隧道，返回一条可直接给 http.request 用的 socket（https 目标已在隧道上完成 TLS）。
function connectTunnel(proxy, host, port, isTls, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = `${host}:${port}`;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const req = http.request({
      hostname: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: target,
      headers: { Host: target, ...(proxy.auth ? { "Proxy-Authorization": proxy.auth } : {}) },
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`连接代理 ${proxy.label} 超时 (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    req.on("connect", (res, socket) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        const hint = res.statusCode === 407 ? "（代理要求认证，请用 LLM_PROXY=http://user:pass@host:port）" : "";
        return fail(new Error(`代理 ${proxy.label} 拒绝隧道 HTTP ${res.statusCode}${hint}`));
      }
      if (!isTls) {
        settled = true;
        return resolve(socket);
      }
      // 隧道通了，再对目标做真正的 TLS（证书仍按目标域名校验，代理无法冒充）
      // 目标是 IP 字面量时不发 SNI（TLS 规范不允许，Node 也会告警）
      const isIp = /^[\d.]+$/.test(host) || host.includes(":");
      const tlsSock = tls.connect({ socket, ...(isIp ? {} : { servername: host }), ALPNProtocols: ["http/1.1"] });
      tlsSock.once("secureConnect", () => {
        settled = true;
        resolve(tlsSock);
      });
      tlsSock.once("error", (e) => fail(new Error(`经代理 ${proxy.label} 连接 ${target} 的 TLS 握手失败: ${errLine(e)}`)));
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      const err = new Error(`无法连接代理 ${proxy.label}（${errLine(e)}）`);
      err.code = e.code;
      fail(err);
    });
    req.end();
  });
}

// 预检与生成共用：目标要走代理时，返回 { client, opts, proxy }；否则原样返回
async function withProxy(client, opts, timeoutMs) {
  const proxy = proxyFor(opts.hostname);
  if (!proxy) return { client, opts, proxy: null };
  const isTls = client === https;
  const sock = await connectTunnel(proxy, opts.hostname, opts.port, isTls, timeoutMs);
  // 隧道已就绪（https 的 TLS 也已完成）→ 用 http 在裸 socket 上发请求。
  // 注意：createConnection 必须挂在 Agent 上，请求级的 createConnection 会被 Node 忽略
  // （实测：请求级写法下 Node 自己另开一条直连，https 目标就会明文撞 TLS 端口后被 reset）。
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => sock;
  return { client: http, opts: { ...opts, agent }, proxy };
}

// ============================================================
//  外链抓取（素材网址）
//  与 AI 调用走同一套代理隧道：本机网络常常只有通过代理才能出网，
//  用裸 fetch 抓用户给的网址会直接超时。
// ============================================================
function fetchExternal(rawUrl, { timeoutMs = 15000, maxBytes = 1200 * 1024, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      return reject(new Error(`不是合法的网址：${rawUrl}`));
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return reject(new Error(`只支持 http/https 网址，收到 ${target.protocol}`));
    }
    const isTls = target.protocol === "https:";
    const client = isTls ? https : http;
    const opts = {
      hostname: target.hostname,
      port: target.port || (isTls ? 443 : 80),
      path: target.pathname + target.search,
      method: "GET",
      // 必须真的把超时挂上去：只写 req.on("timeout") 而不设超时，事件永远不会触发，
      // 服务端吊着不回就变成一个永久挂起的请求（前端表现：网址一直卡在"读取中"）。
      timeout: timeoutMs,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PromixBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    };
    // 只 settle 一次：'end' / 'close' / 'error' 可能都触发
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };
    withProxy(client, opts, timeoutMs)
      .then((prepared) => {
        const req = prepared.client.request(prepared.opts, (res) => {
          // 跟随重定向（代理隧道是一次性的，重定向就重新发起）
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
            res.resume();
            const next = new URL(res.headers.location, target).toString();
            return done(resolve, fetchExternal(next, { timeoutMs, maxBytes, redirects: redirects - 1 }));
          }
          const chunks = [];
          let size = 0;
          let truncated = false;
          res.on("data", (c) => {
            size += c.length;
            if (size > maxBytes) {
              // 超过上限就停止下载，但**必须把 Promise 结掉**：
              // 旧版这里只 destroy 不 resolve，凡是超过 400KB 的页面（一大半真实产品页）
              // 都会让请求永久挂起，用户看到的就是"输入网址后什么都没有"。
              // 标题 / og:image / 小标题都在 <head> 里，前面的内容已经够用了。
              truncated = true;
              res.destroy();
              return;
            }
            chunks.push(c);
          });
          const finish = () =>
            done(resolve, {
              status: res.statusCode,
              contentType: String(res.headers["content-type"] || ""),
              text: Buffer.concat(chunks).toString("utf8"),
              finalUrl: target.toString(),
              truncated,
            });
          res.on("end", finish);
          res.on("close", finish); // destroy() / 连接被掐断时 'end' 不会触发，靠它兜底
          res.on("error", (e) => done(reject, new Error(`读取网页内容失败: ${errLine(e)}`)));
        });
        req.on("timeout", () => req.destroy(new Error(`抓取 ${target.hostname} 超时（${timeoutMs / 1000}s）`)));
        req.on("error", (e) => done(reject, new Error(`无法访问 ${target.hostname}: ${errLine(e)}`)));
        req.end();
      })
      .catch((e) => done(reject, e));
  });
}

// 二进制版本（下载 og:image 之类的图片素材）
function fetchBinary(rawUrl, { timeoutMs = 20000, maxBytes = 20 * 1024 * 1024, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(rawUrl);
    } catch {
      return reject(new Error(`不是合法的网址：${rawUrl}`));
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return reject(new Error(`只支持 http/https`));
    const isTls = target.protocol === "https:";
    const opts = {
      hostname: target.hostname,
      port: target.port || (isTls ? 443 : 80),
      path: target.pathname + target.search,
      method: "GET",
      // 同 fetchExternal：不挂超时的话 req.on("timeout") 永不触发，请求会永久挂起
      timeout: timeoutMs,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PromixBot/1.0)", Accept: "image/*,*/*" },
    };
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };
    withProxy(isTls ? https : http, opts, timeoutMs)
      .then((prepared) => {
        const req = prepared.client.request(prepared.opts, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
            res.resume();
            return done(resolve, fetchBinary(new URL(res.headers.location, target).toString(), { timeoutMs, maxBytes, redirects: redirects - 1 }));
          }
          const chunks = [];
          let size = 0;
          res.on("data", (c) => {
            size += c.length;
            if (size > maxBytes) {
              // 超限要 reject 而不是干等：调用方（候选图逐个兜底）会接着试下一张
              res.destroy();
              return done(reject, new Error(`文件超过上限（${Math.round(maxBytes / 1048576)}MB）`));
            }
            chunks.push(c);
          });
          const finish = () =>
            done(resolve, { status: res.statusCode, contentType: String(res.headers["content-type"] || ""), buffer: Buffer.concat(chunks) });
          res.on("end", finish);
          res.on("close", finish); // destroy() 后 'end' 不一定触发，兜底避免永久挂起
          res.on("error", (e) => done(reject, new Error(`下载失败: ${errLine(e)}`)));
        });
        req.on("timeout", () => req.destroy(new Error(`下载 ${target.hostname} 超时`)));
        req.on("error", (e) => done(reject, new Error(`无法访问 ${target.hostname}: ${errLine(e)}`)));
        req.end();
      })
      .catch((e) => done(reject, e));
  });
}

const decodeEntities = (s) =>
  String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();

const metaOf = (html, names) => {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']*)["']`, "i");
    const m = html.match(re);
    if (m && m[1].trim()) return decodeEntities(m[1]);
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, "i");
    const m2 = html.match(re2);
    if (m2 && m2[1].trim()) return decodeEntities(m2[1]);
  }
  return "";
};

// 正文图片候选：og:image 这类标准字段很多站点根本没写，
// 只认 og:image 会让「直接使用网址素材」在大多数页面上悄无声息地什么都拿不到。
// 这里按「越靠前越可能是主视觉」的顺序收集一串候选，下载时逐个兜底。
function pickPageImages(html, base) {
  const out = [];
  const push = (raw) => {
    if (!raw) return;
    const s = decodeEntities(String(raw)).trim();
    if (!s || /^data:/i.test(s)) return;
    let abs;
    try {
      abs = new URL(s, base).toString();
    } catch {
      return;
    }
    if (!/^https?:/i.test(abs)) return;
    if (out.includes(abs)) return;
    out.push(abs);
  };
  // 1) 显式声明的主图（最可信）
  const declared = metaOf(html, ["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"]);
  push(declared);
  // 2) <link rel="image_src">（apple-touch-icon 之类是图标，不是主视觉，跳过）
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel=["']image_src["']/i.test(m[0])) continue;
    const h = m[0].match(/href=["']([^"']+)["']/i);
    if (h) push(h[1]);
  }
  // 3) 正文里的 <img>：跳过 logo / 图标 / 埋点像素这类显然不是主视觉的
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    if (/\b(logo|icon|sprite|favicon|avatar|placeholder|pixel|spacer|blank|tracking)\b/i.test(tag)) continue;
    if (/\bwidth=["']?1["']?[^>]*\bheight=["']?1["']?/i.test(tag)) continue;
    for (const attr of ["src", "data-src", "data-original", "data-lazy-src"]) {
      const c = tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i"));
      if (c) push(c[1]);
    }
    const srcset = tag.match(/\bsrcset=["']([^"']+)["']/i);
    if (srcset) {
      // 取 srcset 里最后一个（通常分辨率最高）
      const last = srcset[1].split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
      if (last) push(last);
    }
  }
  return out.slice(0, 6);
}

// 从一个网址里抽出「可喂给模型的素材特征」：标题 / 摘要 / 正文摘录 / 主图
function inspectUrl(rawUrl) {
  return fetchExternal(rawUrl).then((r) => {
    if (r.status >= 400) throw new Error(`网页返回 HTTP ${r.status}`);
    const html = r.text;
    const u = new URL(r.finalUrl);
    const title =
      metaOf(html, ["og:title", "twitter:title"]) ||
      decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const description = metaOf(html, ["og:description", "description", "twitter:description"]);
    const body = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
      .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")))
      .filter((t) => t.length > 1 && t.length < 80)
      .slice(0, 8);
    // images：候选主图，越靠前越可信。image 是其中第一个（保持旧字段兼容）
    const images = pickPageImages(html, u);
    return {
      url: r.finalUrl,
      host: u.hostname,
      title: title.slice(0, 200),
      description: description.slice(0, 400),
      image: images[0] || "",
      images,
      headings,
      text: decodeEntities(body).slice(0, 800),
    };
  });
}

// ============================================================
//  错误信息处理：把底层网络/网关错误翻译成一句人能看懂的话
// ============================================================
// 错误首行（跳过空行；首行为空的错误过去会被拼成空字符串）
function errLine(e) {
  const msg = String((e && e.message) || "");
  const line = msg.split("\n").map((s) => s.trim()).find((s) => s.length > 0) || "";
  return (line || "（无错误信息）").slice(0, 160);
}

// 连接层故障：DNS / TCP / TLS / 网关迟迟不响应——区别于"网关返回了错误码"
function isConnectFailure(e) {
  const msg = String((e && e.message) || "");
  const code = String((e && e.code) || "");
  if (!msg.trim() && !code) return true; // 空错误消息：断流的典型表现
  if (/连接 AI 网关超时/.test(msg)) return true;
  if (/无法连接代理|连接代理 .* 超时|代理 .* 拒绝隧道|经代理 .* 连接/.test(msg)) return true;
  if (/(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNABORTED)/i.test(`${code} ${msg}`)) return true;
  return /socket hang up|premature close|fetch failed/i.test(msg);
}

// 多行错误压成一行，但保留全部原因（只取首行会把"未通过校验"后面的原因全丢掉）
function flattenError(e) {
  const parts = String((e && e.message) || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return (parts.join("；") || "（无错误信息）").slice(0, 600);
}

// 网络类错误说人话，其余错误保留全部原因
function describeError(e) {
  return isConnectFailure(e) ? explainLLMError(e) : flattenError(e);
}

function explainLLMError(e) {
  const msg = String((e && e.message) || "");
  const code = String((e && e.code) || "");
  // 代理自身的问题：直接说代理，别甩锅给网关
  if (/^(无法连接代理|连接代理 .* 超时|代理 .* 拒绝隧道|经代理 .* 连接)/.test(msg)) {
    const via = PROXY_URL ? `LLM_PROXY=${PROXY_URL.label}` : "代理";
    return `${msg}——请检查 ${via} 是否有可用节点（Clash 换节点 / 更新订阅），或临时去掉代理直连`;
  }
  if (isConnectFailure(e)) {
    const via = PROXY_URL ? `（经代理 ${PROXY_URL.label}）` : "";
    return `无法连接 AI 网关 ${LLM_HOST}${via}（${code || errLine(e)}）——请检查网络 / VPN / 代理后重试`;
  }
  if (msg.includes("429")) return `AI 网关限流 429（并发过高）——稍后重试或调低 COMPONENT_CONCURRENCY`;
  const m5 = msg.match(/^AI API 错误 (5\d\d)/);
  if (m5) return `AI 网关返回 ${m5[1]}（服务端故障）——稍后重试`;
  return errLine(e);
}

// 生成前的预检：发一个极小的真实请求（几十 token，成本可忽略）。
// 目的：网络不可达 / key 失效 / 模型名写错时秒级给出明确报错，
// 而不是先等 20s TCP 超时、再等数分钟退避重试，或让规划阶段白烧一次完整调用。
async function preflightGateway(apiKey) {
  const t0 = Date.now();
  const u = new URL(LLM_URL);
  const payload = Buffer.from(
    JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 16,
      stream: false,
    }),
    "utf-8"
  );
  // 预检也要走代理，否则「代理能通、直连不通」时预检先挂了
  const routed = await withProxy(
    u.protocol === "http:" ? http : https,
    {
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      method: "POST",
      timeout: PREFLIGHT_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Length": payload.length,
      },
    },
    PREFLIGHT_TIMEOUT_MS
  );
  if (routed.proxy) console.error(`  [net] 预检走代理 ${routed.proxy.label}`);
  return new Promise((resolve, reject) => {
    const req = routed.client.request(
      routed.opts,
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const dt = ((Date.now() - t0) / 1000).toFixed(1);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.error(`  [net] 预检通过: ${LLM_HOST} / ${LLM_MODEL} 可用 (${dt}s)`);
            return resolve(true);
          }
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(`AI API key 无效或已过期 (HTTP ${res.statusCode})：请检查 generator/.deepseek-key 或 DEEPSEEK_API_KEY`));
          }
          if (res.statusCode === 404) {
            return reject(new Error(`模型 "${LLM_MODEL}" 在网关上不存在 (HTTP 404)：可用 LLM_MODEL 环境变量指定其他模型`));
          }
          reject(new Error(`AI 网关预检失败 HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`连接 AI 网关超时 (${PREFLIGHT_TIMEOUT_MS / 1000}s)`)));
    req.on("error", (e) => reject(new Error(explainLLMError(e))));
    req.write(payload);
    req.end();
  });
}

// ============================================================
//  风格包驱动的创意方向（style-packs.js 的 12 个完整设计语言包）
//  字体与色板为具体令牌；叠加随机的叙事手法与创意挑战，保证同输入不同产出
// ============================================================
const { STYLE_PACKS, pickStylePack, expandBrief, sceneLayoutCards } = require("./style-packs");

const NARRATIVE = [
  "数据可视化叙事", "隐喻转译", "时间加速", "前后对比", "一步步组装",
  "一镜到底", "倒叙揭示", "角色拟人", "使用旅程流水账", "双线并行（问题线与解法线）",
  "空镜与细节特写交替", "伪纪录片跟拍", "问答式推进", "循环结构（结尾回到开场场景）",
];
const TWISTS = [
  "用几何形状隐喻产品核心能力", "让数字成为主角", "用对比制造戏剧冲突",
  "引入贯穿全片的视觉符号", "让背景层参与叙事", "元素从画面外闯入",
  "中途一次风格骤变但仍服从简报", "让同一个元素在每场以不同形态复现",
  "用负空间（留白轮廓）暗示产品", "让时间在同一画面里分层（过去/现在同框）",
  "把界面元素当作实体道具使用", "用一次「故障→修复」制造紧张与释放",
];
// 视觉母题 / 节奏 / 色彩处理：在风格包之上再叠三层随机维度，让同输入每次产出都不同
const MOTIFS = [
  "统一的圆形语汇（圆点/圆环/圆弧）", "统一的直线语汇（细线/刻度/网格）",
  "纸张与折痕质感", "流体与波纹", "颗粒与噪点", "光斑与折射",
  "拼贴与撕边", "积木与模块堆叠", "轨迹与拖尾", "坐标系与标注线",
];
const RHYTHM = [
  "前慢后快，收尾一击定音", "匀速稳重，靠画面信息密度推进",
  "短促硬切为主，制造高能量", "长镜头缓移，营造沉浸感",
  "三次递进加速（越来越快）", "呼吸式：张—弛—张—收",
];
const GRADES = [
  "低饱和高级灰 + 一处高饱和点睛色", "高对比黑白 + 单色叠加",
  "暖色调包裹 + 冷色作为对比", "双色对撞（互补色互为背景/前景）",
  "柔和渐变过渡，无明显纯色块", "哑光无光泽，全部用平涂",
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ============================================================
//  用户素材简报
//  reference（默认）：只把素材当作气质/色调/内容方向的参考，画面仍全部原创绘制
//  direct：素材原样进画面 —— 已拷进工程 public/assets/，用 staticFile 取用
//  redraw：素材先经「提取主要元素 → 按视频风格重绘」，进画面的是重绘件（同样在 public/assets/ 下）
// ============================================================
function assetKindLabel(a) {
  return a.kind === "video" ? "视频" : a.kind === "url" ? "网址" : "图片";
}

// hasMedia：本次是否真的有「可直接进画面」的文件（= allowMedia）。
// 「勾了直接使用但一个文件都没有」是真实会发生的情况（网页没有主图 / 图片没上传成功），
// 这时如果还按直用文案要求模型写 staticFile("assets/…")，就会和校验器（该模式下 staticFile 是禁止 API）
// 互相打架：模型反复被拒、最后交出一版没有素材的代码，用户看到的还是「素材没生效」。
function assetsBrief(assets, mode, hasMedia = false) {
  if (!Array.isArray(assets) || assets.length === 0) return "";
  const lines = assets
    .map((a, i) => {
      if (a.kind === "url") {
        const parts = [`${i + 1}. 【网址】${a.url}`];
        if (a.host) parts.push(`   - 站点: ${a.host}`);
        if (a.title) parts.push(`   - 标题: ${a.title}`);
        if (a.description) parts.push(`   - 摘要: ${a.description}`);
        if (Array.isArray(a.headings) && a.headings.length) parts.push(`   - 小标题: ${a.headings.slice(0, 6).join(" / ")}`);
        if (a.text) parts.push(`   - 正文摘录: ${String(a.text).slice(0, 400)}`);
        if (a.file) parts.push(`   - 该网页的主图已作为素材下载: ${a.file}（用 staticFile("assets/${a.file}") 取用）`);
        return parts.join("\n");
      }
      const parts = [`${i + 1}. 【${assetKindLabel(a)}】${a.file}`];
      // 重绘件：说清它是从哪张原始素材重绘来的、AI 从中提取到了什么，
      // 否则模型只看到一个陌生文件名，无从判断画面里该配什么文案与配色。
      if (a.redrawn) {
        parts.push(`   - 这是 AI 重绘件（${a.redrawKind === "bitmap" ? "位图" : "矢量 SVG"}），原始素材: ${a.originalFile || "未知"}`);
        if (a.redrawNote) parts.push(`   - ${a.redrawNote}`);
      }
      const dim = a.width && a.height ? `${a.width}x${a.height}（宽高比 ${(a.width / a.height).toFixed(2)}）` : "未探测到尺寸";
      parts.push(`   - 原始尺寸: ${dim}`);
      if (a.palette && a.palette.length) parts.push(`   - 主色调: ${a.palette.join(" / ")}`);
      if (typeof a.brightness === "number") parts.push(`   - 平均明度: ${a.brightness.toFixed(2)}（0=纯黑 1=纯白）`);
      if (a.note) parts.push(`   - 用户备注: ${a.note}`);
      return parts.join("\n");
    })
    .join("\n");

  // 直用 / 重绘模式，但没有任何可用文件：说清楚「为什么没有素材进画面」，改用文字与图形的路子
  if ((mode === "direct" || mode === "redraw") && !hasMedia) {
    return `\n\n【用户提供的素材 —— 本次没有可直接进画面的文件】\n${lines}\n\n使用规则（硬约束）：\n- 本次没有任何可引用的素材文件（网页没有提供可下载的主图，或文件没能上传成功），因此**禁止**使用 <Img> / <OffthreadVideo> / staticFile，画面全部用 SVG / CSS / 程序化图形原创绘制。\n- 把上面网址的标题 / 摘要 / 小标题 / 正文摘录里的具体信息，转写成分镜的文案与画面元素（这是本次素材唯一的可用价值）。`;
  }

  if (mode === "direct" || mode === "redraw") {
    const noFileUrl = assets.some((a) => a && a.kind === "url" && !a.file);
    const isRedraw = mode === "redraw";
    return `\n\n【用户提供的素材 —— 必须直接作为画面内容使用${
      isRedraw ? "（这些文件是 AI 在原始素材基础上重绘的版本）" : ""
    }】\n${lines}\n\n使用规则（硬约束，违反就是没完成任务）：\n- 这些素材已经放进工程 public/assets/ 目录，用 staticFile("assets/文件名") 取到：图片用 <Img src={staticFile("assets/x.jpg")} />，视频用 <OffthreadVideo src={staticFile("assets/x.mp4")} />。\n- 只允许引用上面列出的文件名，绝对不要编造不存在的文件。\n- 每个分镜至少要让一件素材作为画面主体或重要构成元素出现，不能只画抽象图形。${
      isRedraw
        ? `\n- 【重绘件的用法】这些文件已经按本片风格重绘过：把它们当作画面的主视觉直接使用，**不要再对它们做去色 / 强滤镜 / 大面积裁切**，也不要因为「不确定原图是什么」而弃用它们、改画抽象图形——重绘件的画面内容就是上面「AI 提取主体」那一条所描述的东西，请据此配对应的文案与配色。`
        : ""
    }\n\n【可见性硬指标 —— 用户勾了「${
      isRedraw ? "AI 重绘素材" : "直接使用素材"
    }」，就是要看见它，看不见等于没做】\n生成完会逐分镜真实渲染、和「素材替换成全透明图」的同一帧做像素比对，达不到下面任何一条都会被判定失败并重写：\n- 尺寸：宽高用固定像素数（如 700x480），**不要**写成 \`宽度 * spring(...)\` 这类乘式——spring 在入场前返回 0，会把素材压成 0 宽 0 高，画面里彻底没有它。\n- 不透明：入场动画必须在**前 10 帧内**结束，之后 opacity 恒为 1，不能停在 0 或 0.2。\n- 面积：素材（或其容器）至少占画面 25% 的面积，并作为视觉主体；不要塞成角落里的小图标。\n- 不被裁切：素材及其容器不能 \`overflow: hidden\` 裁到看不见，也不能被后画的任何图层完整盖住。\n- 位置：直接放在 AbsoluteFill 里做绝对定位，不要用 SVG 的 <foreignObject>（它不参与逐帧渲染，用户看不到）。\n- 素材必须保持原始宽高比（objectFit: "cover" 或 "contain"），不得拉伸变形。\n- 允许在素材上叠加文字、遮罩、渐变、边框、光效、裁切与位移，但主体内容不得被文字挡住。` +
      (noFileUrl
        ? `\n- 上面有网址没有附带下载到的主图：这类网址不要引用任何文件，改用它的标题 / 摘要 / 小标题文字作为该分镜的文案来源。`
        : "");
  }

  return `\n\n【用户提供的素材 —— 仅作参考，不进入画面】\n${lines}\n\n使用规则（硬约束）：\n- 这些素材**不会出现在视频里**，它们的用途是让你理解用户想要的气质、色调与内容方向。\n- 请以上面的主色调作为整片的配色基准（保持同一色系与明暗关系），把标题 / 摘要里的具体信息融进字幕与画面元素。\n- 画面仍然全部用 SVG / CSS / 程序化图形原创绘制，禁止使用 <Img> / <OffthreadVideo> / staticFile。`;
}

// 用户点选「参考某个已生成工程」时，把那份工程的风格直接搬过来。
// 支持多选：mergeStyleRefs() 会把多个工程合成一个 ref，这里按合并后的形态描述。
function styleRefBrief(ref, styles) {
  if (!ref) return "";
  const names = ref.projectNames && ref.projectNames.length ? ref.projectNames : ref.projectName ? [ref.projectName] : [];
  const parts = [`\n\n【用户指定：沿用参考工程的风格】`];
  if (names.length === 1) {
    parts.push(`- 参考工程: ${names[0]}` + (ref.title ? `（${ref.title}）` : ""));
  } else if (names.length > 1) {
    parts.push(`- 参考工程（多选，共 ${names.length} 个）: ${names.join(" + ")}`);
    parts.push(
      `- **这是「融合参考」**：把这几份工程的风格语汇融合成一套**统一**的新风格，而不是每个分镜各用一份。` +
        `先在脑子里取它们的交集与共性（共同的构图习惯、动效语汇、材质处理），再补上各自最有辨识度的 1~2 个特征，` +
        `让整片看起来像同一个设计师的手笔。相互冲突的地方以第一个工程为主。`
    );
  }
  if (ref.styleTags && ref.styleTags.length) parts.push(`- 参考风格词（合并去重）: ${ref.styleTags.join(" / ")}`);
  if (ref.packId) {
    const pack = styles.find((p) => p.id === ref.packId);
    if (pack) {
      parts.push(`- 主风格包「${pack.name}」的全部设计令牌（色彩 / 字体 / 图形语言 / 动效语言）必须逐字沿用，不要另起炉灶。`);
      parts.push(expandBrief(pack));
    }
  }
  if (ref.extraPackIds && ref.extraPackIds.length) {
    const others = ref.extraPackIds.map((id) => (styles.find((p) => p.id === id) || {}).name).filter(Boolean);
    if (others.length) {
      parts.push(`- 另外几份参考还带来了这些风格倾向（作为点缀融合，不要盖过主风格包）: ${others.join(" / ")}`);
    }
  }
  if (ref.palette && ref.palette.length) parts.push(`- 参考工程实际用到的颜色（尽量沿用）: ${ref.palette.join(" / ")}`);
  if (ref.sampleCode) {
    parts.push(`- 下面是参考工程分镜的真实源码，请沿用它的代码风格、视觉语汇与动效手法（不要照抄内容，构图与文案必须按本次产品重写）：\n\`\`\`tsx\n${ref.sampleCode}\n\`\`\``);
  }
  return parts.join("\n");
}

// 返回 { pack, direction }：pack 携带 requiredFonts 供静态校验；direction 为展开后的简报文本
function randomDirection(styleRef) {
  // 用户指定了参考工程 → 直接沿用那份工程的风格包；否则随机抽（STYLE_PACK 环境变量可强制）
  const forcedPack = styleRef && styleRef.packId ? STYLE_PACKS.find((p) => p.id === styleRef.packId) : null;
  const pack = forcedPack || pickStylePack();
  const seed = Math.floor(Math.random() * 9000) + 1000;
  const extra = [
    `- 叙事手法：${pick(NARRATIVE)}`,
    `- 视觉母题：${pick(MOTIFS)}`,
    `- 剪辑节奏：${pick(RHYTHM)}`,
    `- 色彩处理：${pick(GRADES)}`,
    `- 创意挑战：${pick(TWISTS)}`,
    `- 随机种子：${seed}（本条仅供你打破惯性——在符合上面所有约束的前提下，凡是有自由选择余地的地方，都按这个种子做出与"最常见做法"不同的选择）`,
  ];
  return {
    pack,
    direction: expandBrief(pack) + "\n" + extra.join("\n") + styleRefBrief(styleRef, STYLE_PACKS),
  };
}

// ============================================================
//  「参考某个已生成工程的风格」
//  从磁盘上的工程里抽出：风格包（显式记录优先，否则按配色反推）、配色、样例代码。
//  这三样一起喂给模型，风格延续效果比只给几个风格词强得多。
// ============================================================
function extractPalette(code) {
  const counts = new Map();
  for (const m of String(code).matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = "#" + m[1].toLowerCase();
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([hex]) => hex);
}

// 老工程没记 stylePack 时，用配色命中数反推它当年用的是哪个风格包
function detectPackFromCode(code) {
  const lower = String(code).toLowerCase();
  let best = null;
  for (const p of STYLE_PACKS) {
    const hexes = Object.values(p.palette || {}).map((v) => String(v).toLowerCase());
    const hit = hexes.filter((h) => h.startsWith("#") && lower.includes(h)).length;
    if (hit >= 3 && (!best || hit > best.hit)) best = { id: p.id, hit };
  }
  if (best) console.error(`[codegen] 按配色反推出参考工程的风格包: ${best.id}（命中 ${best.hit} 个令牌色）`);
  return best ? best.id : "";
}

function buildStyleRef(projectName) {
  // 只接受工作区根目录下的普通目录名，杜绝 ../ 之类的路径穿越
  if (!projectName || !/^[A-Za-z0-9._-]+$/.test(projectName) || projectName.startsWith(".")) {
    throw new Error(`非法的工程名：${projectName}`);
  }
  const dir = path.join(ROOT, projectName);
  const previewPath = path.join(dir, "preview.json");
  if (!fs.existsSync(previewPath)) throw new Error(`工程 ${projectName} 没有 preview.json，无法作为风格参考`);
  let preview;
  try {
    preview = JSON.parse(fs.readFileSync(previewPath, "utf8"));
  } catch (e) {
    throw new Error(`工程 ${projectName} 的 preview.json 解析失败: ${errLine(e)}`);
  }
  const sceneFiles = (preview.scenes || []).map((s) => path.join(dir, "src", "scenes", s.file));
  let all = "";
  for (const f of sceneFiles) {
    try {
      all += fs.readFileSync(f, "utf8") + "\n";
    } catch {}
  }
  let sampleCode = "";
  if (sceneFiles[0]) {
    try {
      // 只取一个分镜的前 90 行：足以表达视觉语汇，又不至于把上下文挤爆
      sampleCode = fs.readFileSync(sceneFiles[0], "utf8").split("\n").slice(0, 90).join("\n");
    } catch {}
  }
  const packId = preview.stylePack || detectPackFromCode(all);
  console.error(`[codegen] 风格参考就绪: ${projectName} · 风格包=${packId || "未识别（靠配色+样例代码延续）"} · 配色 ${extractPalette(all).slice(0, 5).join(" ")}`);
  return {
    projectName,
    projectNames: [projectName],
    title: preview.title || "",
    packId,
    styleTags: preview.styleTags || [],
    palette: extractPalette(all),
    sampleCode,
  };
}

// 参考风格「多选」：把多个工程合成一份 ref，供风格沿用使用。
// 合并策略：风格包按多数派定主、其余作为点缀；配色/风格词去重拼接；样例代码最多取两份，避免上下文爆掉。
function mergeStyleRefs(projectNames) {
  const names = [...new Set((projectNames || []).map((s) => String(s || "").trim()).filter(Boolean))];
  if (!names.length) return null;
  const refs = names.map((n) => buildStyleRef(n));
  if (refs.length === 1) {
    const only = refs[0];
    return { ...only, projectNames: [only.projectName], extraPackIds: [] };
  }

  // 风格包投票：票多者为主
  const votes = new Map();
  for (const r of refs) if (r.packId) votes.set(r.packId, (votes.get(r.packId) || 0) + 1);
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const packId = ranked.length ? ranked[0][0] : refs[0].packId || "";
  const extraPackIds = ranked.slice(1).map(([id]) => id);

  const palette = [];
  for (const r of refs) {
    for (const c of r.palette || []) {
      const lower = String(c).toLowerCase();
      if (!palette.some((x) => x.toLowerCase() === lower)) palette.push(c);
      if (palette.length >= 10) break;
    }
    if (palette.length >= 10) break;
  }
  const styleTags = [];
  for (const r of refs) {
    for (const t of r.styleTags || []) {
      if (!styleTags.includes(t)) styleTags.push(t);
      if (styleTags.length >= 10) break;
    }
    if (styleTags.length >= 10) break;
  }
  // 样例代码取前两份、各 55 行：两份足以表达共性，再多就淹没了本次产品本身
  const sampleCode = refs
    .slice(0, 2)
    .map((r) => (r.sampleCode || "").split("\n").slice(0, 55).join("\n"))
    .filter(Boolean)
    .join("\n\n/* ---------- 另一份参考 ---------- */\n\n");

  console.error(
    `[codegen] 融合参考 ${names.length} 个工程: ${names.join(" + ")} · 主风格包=${packId || "未识别"}` +
      (extraPackIds.length ? ` · 点缀=${extraPackIds.join(",")}` : "")
  );
  return {
    projectName: names[0],
    projectNames: names,
    title: refs.map((r) => r.title).filter(Boolean).slice(0, 3).join(" / "),
    packId,
    extraPackIds,
    styleTags,
    palette,
    sampleCode,
  };
}

// ============================================================
//  Prompts
// ============================================================
// ---- 时长约束（用户可自定义生成时长） ----
// 分镜帧数可行区间：45 帧(1.5s) ~ 400 帧(13.3s)；用户目标时长 4s ~ 120s
const MIN_SCENE_FRAMES = 45;
const MAX_SCENE_FRAMES = 400;
const MIN_TARGET_SECONDS = 4;
const MAX_TARGET_SECONDS = 120;

// 目标帧数 → 分镜数量（每分镜约 6 秒，3~10 个），让短视频不空、长视频不挤
function planSceneCount(targetFrames) {
  return Math.min(10, Math.max(3, Math.round(targetFrames / (FPS * 6))));
}

function plannerPrompt(targetFrames) {
  const rules = targetFrames
    ? `1. 规划 ${planSceneCount(targetFrames)} 个分镜（数量由用户指定的总时长推导，不要少给），按叙事顺序：第 1 个开场点题，中间分镜信息密度高、各自讲一个卖点，最后一个收尾点出品牌/主张。
2. 【总时长硬约束】全片目标 ${(targetFrames / FPS).toFixed(1)} 秒 = ${targetFrames} 帧（含分镜之间的 overlap 重叠）。各分镜 durationInFrames 建议取 ${Math.round(targetFrames / planSceneCount(targetFrames))} 帧左右（允许 ±25%，可用范围 ${MIN_SCENE_FRAMES}~${MAX_SCENE_FRAMES}）；overlap 取 12~24 的整数；最后一个分镜 overlap 为 0。系统会按该约束做一次精确对齐，你只需把内容填满、不要写"快速掠过的过场"来凑数。`
    : `1. 5-7 个分镜，按叙事顺序：第 1 个开场点题，中间分镜信息密度高、各自讲一个卖点，最后一个收尾点出品牌/主张。
2. durationInFrames 取 90~200 的整数；overlap 取 12~24 的整数；最后一个分镜 overlap 为 0。`;
  return `你是一位顶尖的 Remotion 动效导演。根据产品描述和随机「创意方向简报」，规划一条 ${WIDTH}x${HEIGHT} @${FPS}fps 产品宣传片的分镜脚本。

只输出一个 JSON 对象（纯 JSON，不要 markdown 代码块，不要解释文字）：
{"id":"PascalCase英文标识","title":"画面标题","styleTags":["3-6个风格词"],"scenes":[{"name":"小写英文唯一名","durationInFrames":110,"overlap":18,"subtitle":"该分镜中文字幕，8~22字"}]}

规则：
${rules}
3. subtitle 为中文一句话，8~22 字，所有 subtitle 串起来完整讲述产品，彼此不重复。语气克制、有质感，避免口语化与推销套话（如"大家好""今天给大家介绍""快来购买""绝绝子""家人们"等）；字幕是画面上的文案，宜精炼、可读、有画面感，可书面、可诗意、可用金句短句，但不要写成嘴上说的大白话。各分镜字幕的修辞与句式应随内容切换——开场大气点题、卖点用克制陈述或设问、收尾用主张金句——相邻分镜在句式与节奏上要有变化，避免全程一个腔调。
4. id 与产品相关但不拘泥（PascalCase 英文）。
5. 风格词要具体反映创意方向简报；在统一调性下，各分镜的风格词应在细节上有所变化（如主基调外点缀不同质感/技法词），让整片视觉语言有层次而非每镜重复同一组词。`;
}

const COMPONENT_PROMPT = `你是一位顶尖的 Remotion 动效工程师。为一条 ${WIDTH}x${HEIGHT} @${FPS}fps 的产品宣传片编写其中一个分镜组件的真实 TSX 源码。

## 组件契约（必须全部满足）
1. 文件第一行到最后一行就是完整的 TSX 文件内容——不要任何解释文字、不要 markdown 代码块。
2. 形如 export default function 组件名({ subtitle }: { subtitle: string })。
3. 必须把 subtitle 文本逐字呈现在画面中——位置、字体、字号、颜色、出入场动画完全原创设计，但文字内容一字不改。
4. useCurrentFrame() 是该分镜内的局部帧（从 0 开始）；画布 1920x1080，占据明确构图位置或铺满。
5. 只能 import "react" 和 "remotion"（AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Sequence, Easing 等）。不得使用图片、字体文件、音频等外部资源，视觉全部用 SVG / CSS / 程序化图形。（interpolate 照常从 remotion 引入即可，构建时会被自动替换为带兜底的包装，不要自己 import 别的模块。）
6. 完全确定性：禁止 Math.random、Date.now、performance.now。伪随机用帧驱动，如 const rnd = (i: number) => Math.abs(Math.sin(i * 127.1) * 43758.5453) % 1;
7. 不使用 <Audio>（配音由全局层处理）。
8. 内容丰富：至少 3 组不同的动画视觉元素（图形/文字/组合），错落有层次地出场，动效要服从创意方向简报。
9. 代码必须能通过 vite 的 Babel 转换；类型可宽松（可用 any）。特别地：不得出现【重复声明】——同一个模块的 import 必须合并成一条（不要写两条 from "remotion" 的 import），顶层函数/变量也不得与任何 import 同名。
10. 字体硬规则：所有文字的 fontFamily 必须逐字使用【创意方向简报·字体令牌】给出的 font-family 字符串原文（中文标题/中文正文/英文数字各用对应栈），禁止回落默认 sans-serif，禁止使用简报未列出的字体。
11. 代码长度纪律：整个文件控制在 200~300 行（含 import 与类型），追求"少而精"——3~4 组视觉元素就够，不要堆砌重复的辅助函数、不要写用不到的常量数组、不要长篇注释。冗长代码既慢又容易出错。
12. SVG 数值硬规则：r / cx / cy / x / y / width / height / strokeWidth / rx 等几何属性必须是合法正值——凡是会随动画变化的数值，一律用 Math.max(0, …) 兜底（如 r={Math.max(0, spring(...) * 40)}），禁止出现 -0.00003 这类负数半径，否则浏览器控制台会持续报错。
13. interpolate 硬规则：inputRange 必须【严格递增】，且与 outputRange 等长，元素只能是有限数。
14. 禁止"自造框架兜底"：不得定义与 import 同名的 useCurrentFrame / useVideoConfig / interpolate / interpolateColors / spring / Easing / AbsoluteFill / Sequence / staticFile / Img 等函数或变量（典型错误写法：function useCurrentFrame() { return (window as any).__remotion_frame ?? 0; }，或把整套 API 在文件末尾再实现一遍）。这些都由 Remotion 运行时提供，自造一遍会与 import 撞名，Babel 报 Duplicate declaration，预览整页白屏。
   ⚠️ 最容易踩的坑：把「随索引递增的起始帧」和「固定数值的结束帧」混写——
   错误示例：interpolate(frame, [10 + i * 4, 22 + i * 4, 45, 55], [0, 0.7, 0.7, 0])
   i 变大后起始帧会越过后面的固定帧（i=6 时得到 [34, 46, 45, 55]），Remotion 直接抛错、整个分镜白屏。
   正确写法（任选其一）：
   a) 区间全部由同一个变量族推导：interpolate(frame, [10 + i * 4, 22 + i * 4], [0, 0.7])
   b) 区间全部写死字面量：const STOPS = [16, 26, 40, 60];
   c) 必须混用时夹取上界，保证单调：const t0 = Math.min(10 + i * 4, 40); interpolate(frame, [t0, Math.min(t0 + 12, 44), 45, 55], [0, 0.7, 0.7, 0])
   d) 拿不准就用 spring() 代替（spring 只有 from/to，不存在这个约束）
   循环渲染多个元素时为每个元素单独算好区间，不要让后写死的帧号小于前面动态算出的帧号。`;

const BACKDROP_PROMPT = `你是一位顶尖的 Remotion 动效工程师。为一条 ${WIDTH}x${HEIGHT} @${FPS}fps 的产品宣传片编写全局环境背景组件的真实 TSX 源码。

## 组件契约（必须全部满足）
1. 文件第一行到最后一行就是完整的 TSX 文件内容——不要任何解释文字、不要 markdown 代码块。
2. export default function Backdrop() —— 无 props，用 AbsoluteFill 铺满 1920x1080。
3. useCurrentFrame() 在这里是全局绝对帧（整个视频的帧号，视频总时长见分镜说明）。
4. 只能 import "react" 和 "remotion"。不得使用外部资源，全部用 SVG / CSS / 程序化图形。
5. 完全确定性：禁止 Math.random、Date.now、performance.now。伪随机用帧驱动。
   散布装饰元素（贴纸/纸屑/星点/波点等）尤其注意：位置、大小、旋转一律预先算好——写成固定常量数组（如 [{x:120,y:80,r:12},...]）或用索引公式（x = (i * 137 + 60) % 1800），绝不在渲染期调用 Math.random。
6. 塑造创意方向简报中的整体环境氛围与世界观，持续微动，但克制、不抢内容层（内容层会绘制在背景之上）。
7. 代码必须能通过 vite 的 Babel 转换；类型可宽松（可用 any）。特别地：不得出现【重复声明】——同一个模块的 import 必须合并成一条（不要写两条 from "remotion" 的 import），顶层函数/变量也不得与任何 import 同名。
8. 字体硬规则：背景层如出现任何文字，fontFamily 必须逐字使用【创意方向简报·字体令牌】给出的字体栈原文。
9. 代码长度纪律：整个文件控制在 120~200 行，克制而精确，不要堆砌装饰元素与辅助函数。
10. SVG 数值硬规则：r / cx / cy / x / y / width / height 等几何属性必须是合法正值——凡随动画变化的数值一律 Math.max(0, …) 兜底，禁止出现负数半径（浏览器控制台会持续报错）。
11. interpolate 硬规则：inputRange 必须严格递增、与 outputRange 等长、元素只能是有限数。禁止把「随索引递增的帧号」与「写死的帧号」混写在同一个区间里（i 变大后越过后面的固定帧就会抛 "inputRange must be strictly monotonically increasing" 导致整帧白屏）。要么区间全部由同一变量族推导，要么全部写死字面量数组，要么用 Math.min/Math.max 夹取上界。
12. 禁止"自造框架兜底"：不得定义与 import 同名的 useCurrentFrame / useVideoConfig / interpolate / spring / Easing / AbsoluteFill 等函数或变量——它们由 Remotion 运行时提供，自造一遍会与 import 撞名，Babel 报 Duplicate declaration，预览整页白屏。`;

// 「本次关闭字幕」时追加的约束：subtitle 只作画外音文案，不进画面
const NO_SUBTITLE_CLAUSE = `

## 本次特别约定：关闭字幕
用户明确选择了「不生成字幕」。因此：
- 组件签名仍然要保留 \`({ subtitle }: { subtitle: string })\`（文案要留给配音用），
- 但**严禁在画面任何位置绘制、渲染、显示 subtitle 文本**——不要有字幕条、不要有底部文案区、不要用 subtitle 变量做任何可见元素。
- 构图要按「没有字幕」重新平衡：不要为了给字幕让位而在画面底部留出空白带，主体可以占满整个画面。
- subtitle 只当作你自己理解这条片子叙事的背景信息。`;

/**
 * 配音方案提示词：一次额外调用产出「音色 + 逐分镜情绪 + 朗读断句 + 配乐情绪」。
 * 关键设计：
 *   - 音色只能从固定白名单里选（音色自带性格，比调参数更能去 AI 味）；
 *   - 每句单独给情绪，因为韵律轮廓是由情绪推出来的（见 voice.js 的 EMOTIONS）；
 *   - 文案会被改写成「适合朗读」的口语，而不是照抄字幕——字幕要读得顺，书面语念出来很假。
 */
function voiceoverPrompt(manifest, { withBgm }) {
  // 每个分镜的朗读字数预算：保守按 3.5 字/秒（含停顿）估算。
  // 这是硬约束（代码里也会强制裁剪）——写超了配音会溢出到下一个分镜，变成两人同时说话。
  const sceneLines = manifest.scenes
    .map((s, i) => {
      const sec = s.durationInFrames / FPS;
      const budget = voiceBudgetChars(sec);
      return `${i + 1}. ${s.name}（${sec.toFixed(1)}s，配音总字数上限 ${budget} 字）字幕:「${s.subtitle}」`;
    })
    .join("\n");
  const voiceList = voiceKit.NEURAL_VOICES.map(
    (v) => `- ${v.id} —— ${v.name}（${v.gender}）${v.traits} ｜ 适合：${v.fit}`
  ).join("\n");
  const moodList = voiceKit.MUSIC_MOOD_NAMES.join(" / ");
  const emotionList = Object.keys(voiceKit.EMOTIONS).join(" / ");
  return `你是一位中文广告片的声音导演，负责为一条 ${(manifest.scenes.reduce((a, s) => a + s.durationInFrames, 0) / FPS).toFixed(0)} 秒的品牌片做配音与配乐设计。

## 分镜表
${sceneLines}

## 可选音色（voice 字段只能填这里的 id，必须选一个）
${voiceList}

## 可选情绪（emotion 字段只能填这里的名字）
${emotionList}
${withBgm ? `\n## 可选配乐情绪（music 字段只能填这里的一个）\n${moodList}\n` : ""}
## 输出格式（只输出 JSON，不要 markdown 代码块、不要任何解释）
{"voice":"音色id","voiceReason":"为什么这个音色适合（20字内）","scenes":[{"scene":"分镜名（必须与上面分镜表一致）","emotion":"情绪名","lines":["第一句","第二句"]}]${withBgm ? ',"music":{"mood":"配乐情绪","intensity":1.0,"reason":"为什么这段配乐适合（20字内）"}' : ""}}

## 硬规则
1. **文案要重写，不要照抄字幕**：字幕是给人看的，配音文案是按嘴念的——必须念出来自然、有呼吸感（可口语、可短句，但别写成市井叫卖）。在"好念"的前提下**语气风格要随内容变化**：开场沉稳点题、卖点克制陈述或轻设问、收尾抛金句或留白；各镜的语体、句式、节奏不要千篇一律，避免全程一个口播腔。配音的语气应与对应字幕协调呼应（字幕克制留白→配音内敛，字幕犀利设问→配音带锋芒），不要字幕文艺、配音却突然叫卖。可调整语序、拆句、换同义词，但**不能改变原意、不能虚构数据或功效**。
2. 每个分镜给 1~3 句，每句 8~22 字。**必须守住上面每个分镜给的字数上限**——那个上限是按分镜时长和正常语速算出来的，写超了配音念不完，会溢出到下一个分镜跟它抢话。宁可少说，不要多说。
3. lines 里的每一句都会单独做一次语音合成，句间有停顿。所以**断句要按语义和呼吸来切**，不要把一整段话塞进一句。
4. emotion 决定这句话的音高与语速起伏曲线，**同一分镜内的多句可以给不同情绪**（例如前半句"悬念铺陈"后半句转"激昂热血"），这正是让配音有起伏的关键，不要一个情绪用到底。
5. 全片情绪要有明确的走向（比如 悬念铺陈 → 轻快明亮 → 激昂热血 → 动情收束），不要平铺；**语体风格也要有设计**——相邻分镜的句式长短、修辞（陈述/设问/金句/留白）应做切换，让整片"声音语言"有层次，而非每镜同一副腔调。
6. voice 只选一个，全片统一。根据产品的品类与情绪基调选，不要默认选晓晓。
7. 全片不要出现"大家好""今天给大家介绍""快来购买""绝绝子""家人们"这类套路口播腔或网感推销话术。
${withBgm ? "8. music.intensity 取 0.4~1.4：画面安静的片子给 0.5~0.8，燃向的给 1.1~1.4。配乐是背景衬底，必须给配音让路，所以宁低勿高。\n" : ""}`;
}

// ============================================================
//  配音方案：调用 AI → 归一化 → 合成音频 → 写回 manifest
// ============================================================

/**
 * 一个分镜的朗读字数预算。
 * 实测中文慢速朗读（悬念/动情这类负速率情绪）约 3.0~4.0 字/秒（已含标点停顿），
 * 取 3.5 字/秒并留 0.45s 头尾余量，保证最慢的情绪也念得完。
 * 宁可留一点纯音乐的空档，也不要溢出到下一分镜抢话。
 */
function voiceBudgetChars(durationSec) {
  return Math.max(6, Math.floor((Number(durationSec) - 0.45) * 3.5));
}

/**
 * 按分镜时长把 AI 给的句子裁到装得下为止。
 * AI 经常「按意思写」而不管时长，写超了配音就会溢出到下一个分镜、两句话同时响。
 * 这里是硬保证：从前往后累加，超预算的句子直接丢弃（至少保留第一句，哪怕它本身略超）。
 */
function clampLinesToBudget(lines, budget) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const len = line.replace(/\s/g, "").length;
    if (out.length && used + len > budget) break;
    out.push(line);
    used += len;
    if (out.length >= 3) break;
  }
  return out;
}

async function planVoiceover(apiKey, manifest, { direction, prompt, withBgm, onProgress }) {
  const t0 = Date.now();
  const sys = voiceoverPrompt(manifest, { withBgm });
  const userMsg = `【产品描述】\n${prompt}\n\n${direction}`;
  const content = await callLLM(apiKey, sys, userMsg, 4096, 0.85);
  const raw = extractJson(content);
  if (!raw || !Array.isArray(raw.scenes)) throw new Error("配音方案输出无法解析为 JSON");

  // 归一化：音色白名单、情绪白名单、分镜名对齐、逐句清洗
  const voice = voiceKit.NEURAL_VOICE_IDS.includes(raw.voice) ? raw.voice : voiceKit.NEURAL_VOICE_IDS[0];
  const byName = new Map((raw.scenes || []).map((s) => [String(s.scene || "").trim(), s]));
  const scenes = [];
  for (let i = 0; i < manifest.scenes.length; i++) {
    const src = byName.get(manifest.scenes[i].name) || (raw.scenes || [])[i] || {};
    const raw2 = (Array.isArray(src.lines) ? src.lines : [])
      .map((s) => String(s).replace(/^["'「『]+|["'」』]+$/g, "").replace(/\s+/g, " ").trim())
      .filter((s) => s.length >= 2)
      .slice(0, 3);
    // AI 没给可用文案就退回字幕原文（仍然能出声，只是不够口语）
    const fallback = [String(manifest.scenes[i].subtitle || "").trim()].filter(Boolean);
    const candidates = raw2.length ? raw2 : fallback;
    const budget = voiceBudgetChars(manifest.scenes[i].durationInFrames / FPS);
    const lines = clampLinesToBudget(candidates, budget);
    if (candidates.length > lines.length) {
      console.error(
        `  [voice] ${manifest.scenes[i].name} 配音文案超出 ${budget} 字预算，已裁掉 ${candidates.length - lines.length} 句（避免溢出到下一分镜抢话）`
      );
    }
    scenes.push({
      scene: manifest.scenes[i].name,
      emotion: voiceKit.normalizeEmotion(src.emotion),
      lines,
    });
  }
  const music = withBgm
    ? {
        mood: voiceKit.normalizeMood(raw.music && raw.music.mood),
        intensity: Math.min(1.4, Math.max(0.4, Number(raw.music && raw.music.intensity) || 1)),
        reason: String((raw.music && raw.music.reason) || "").slice(0, 60),
      }
    : null;
  const plan = { voice, voiceReason: String(raw.voiceReason || "").slice(0, 60), scenes, music };
  if (typeof onProgress === "function") onProgress({ ms: Date.now() - t0, plan });
  console.error(
    `[codegen] 配音方案就绪 (${((Date.now() - t0) / 1000).toFixed(0)}s) · 音色=${voice} 句数=${scenes.reduce((a, s) => a + s.lines.length, 0)}` +
      (music ? ` · 配乐=${music.mood}(强度 ${music.intensity})` : "")
  );
  return plan;
}

/**
 * 把合成结果写回 manifest.voice：
 *   每句音频在本分镜内「居中排布」，句间插入情绪决定的停顿。
 *   装不下时先压停顿、再顶格靠前摆放（语音本身绝不裁剪——吞字比溢出更难接受）。
 *   真正的兜底在 planVoiceover 的字数预算里，正常不会走到溢出分支。
 */
function applyVoicePlan(manifest, plan, synth, timeline, { bgm }) {
  if (!synth || !synth.ok) return { ok: false, tracks: [], warnings: [] };
  const warnings = [];
  const raw = synth.files || [];
  const tracks = [];
  // 顺序摆放的游标：下一句的起点绝不早于上一句的结束 +2 帧。
  // 这是「不可能两人同时说话」的结构性保证——不依赖任何估算是否准确。
  let audioEnd = -Infinity;
  for (const st of timeline) {
    const group = raw.filter((f) => f.scene === st.name);
    if (!group.length) continue;
    const clipFrames = group.map((g) => Math.max(1, Math.round(g.seconds * FPS)));
    // 留 8 帧头尾余量，避免话音贴着分镜切换
    const avail = Math.max(1, st.durationInFrames - 8);
    // 句间停顿：情绪给的基础值，但全组停顿加起来不超过分镜余量的一半
    let gaps = group.slice(0, -1).map((g) => Math.round((g.pause || 0.2) * FPS));
    const speech = clipFrames.reduce((a, b) => a + b, 0);
    if (gaps.length) {
      const room = Math.max(0, avail - speech);
      const gapSum = gaps.reduce((a, b) => a + b, 0);
      const cap = Math.max(0, Math.min(gapSum, Math.floor(room / 2)));
      if (gapSum > cap) gaps = gaps.map((g) => (gapSum ? Math.round((g * cap) / gapSum) : 0));
    }
    const spoken = speech + gaps.reduce((a, b) => a + b, 0);
    const overflow = spoken - avail;
    if (overflow > 4) {
      warnings.push(`${st.name} 的配音比该分镜长 ${(overflow / FPS).toFixed(1)}s（语音不裁剪，会轻微压到下一分镜）`);
    }
    // 起点：既不能早于本分镜开始后 3 帧，也不能早于上一句结束（+2 帧安全间隔）；
    // 两者都满足时取「居中」位置，让话语不总挤在分镜开头。
    const earliest = Math.max(st.from + 3, audioEnd + 2);
    const centered = st.from + Math.max(3, Math.round((avail - spoken) / 2) + 4);
    let cursor = Math.max(earliest, centered);
    group.forEach((g, i) => {
      tracks.push({
        file: g.file,
        scene: st.name,
        text: g.text,
        emotion: g.emotion,
        from: cursor,
        duration: clipFrames[i],
      });
      cursor += clipFrames[i] + (gaps[i] || 0);
      // cursor 在最后一次循环后正好落在最后一句的结束帧（末尾没有 gap）
      audioEnd = cursor - (gaps[i] || 0);
    });
  }
  manifest.voice = {
    enabled: tracks.length > 0,
    provider: synth.provider,
    voiceName: plan.voice,
    voiceReason: plan.voiceReason,
    tracks,
    bgm: bgm || null,
  };
  return { ok: true, tracks, warnings };
}


// 提示词优化：用户往往只写一句很含糊的话（"做个智能家居APP宣传片"），
// 直接丢给规划模型，分镜就会空泛、卖点雷同。这里先用一次轻量调用把它扩写成
// 一份「可直接执导」的产品描述简报（定位 / 卖点 / 场景 / 风格 / 叙事线索）。
// 提速与随机性：
//   ① 调用方传入 onDelta → 前端边生成边显示（首字 1~3s 就出现，体感不再是干等 30s）；
//   ② 目标长度压到 170~250 字，输出 token 少一半，真实耗时同步下降；
//   ③ 每次点击换一个随机「创意视角」，并显式要求与上一版不重复 → 同输入每次都不一样。
const OPTIMIZER_PROMPT = `你是一位顶尖的产品宣传片策划。用户可能只给你一句很短、含糊的产品描述，也可能已经写好一份相当完整的创意方案（含具体场景、情绪、视觉风格、叙事线索、人称口吻等）；你要把它扩写成一份可以直接交给视频导演的「产品描述简报」。

只输出扩写后的描述正文本身（纯文本；不要 markdown 标题、不要列表符号、不要代码块、不要解释你做了什么、不要输出 JSON）。
中文，170~250 字，组织成 2~3 个自然段，句子紧凑，不要凑字数。

必须包含（原始描述里没提到的，按产品所属品类做合理推断，不要反问用户、不要留空）：
1. 主体 / 产品是什么（一句话定位）。产品名与品类只能来自「用户原始描述」或「网址素材里的真实文字」；
   如果都没有，就**严格按素材「画面理解（AI 提取）」里的视觉特征来指代主体**（例如"画面主体是一块深灰褐色、表面带细腻纹理的块状物，置于纯净白底之上"），
   **不得凭空编造具体品类**（智能音箱 / 手表 / 手机 / 化妆品…）——你并没有真的看到商品，只能描述它呈现出来的视觉特征。
2. 3~4 个核心功能卖点，每条都要落到「用户能看到什么画面」，禁止"高效便捷""体验流畅""赋能"这类空话。
3. 2~3 个典型使用场景（什么时间、什么地点、用户在做什么动作）。
4. 情绪基调与视觉风格倾向（给出 2~3 个具体的风格词，例如：冷峻科技、温暖治愈、复古胶片、极简黑白）。
5. 一条叙事线索建议：开场怎么抓人 → 中段怎么逐个讲卖点 → 结尾落在什么主张上。

硬规则：
- 严格保留原始描述里的产品、行业与语言；不换品类、不加具体品牌名、不杜撰数据（禁止"提升 300%""行业第一"这类无法核实的话）。
- 不要出现"请输入""请补充""建议你"这类对话口吻，整段就是可用的成品描述。
- 不要用引号包裹整段，直接写正文。
- 用户会给出【本次创意视角】或【本次处理方式】：
  · 若标明「必须采纳」的创意视角——那是针对「含糊描述」的发挥方向，请据此组织场景与卖点顺序，并与其它版本做出明显差异。
  · 若标明「必须遵循」的处理方式（用户已给完整方案）——则这只是文字润色建议，**严禁**替换或新增与用户设定冲突的内容。
- 当用户的原始描述已经是一份完整的创意方案（明确写了场景、情绪基调、视觉风格、叙事线索、人称/口吻等），这些就是**不可更改的硬约束**：
  你只能做文字润色、节奏打磨、在不矛盾的前提下补全细节（例如把"午后窗边"扩写得更具体），
  **严禁**把用户已指定的场景、角色、情绪、叙事结构换成别的东西，也**严禁**用"意想不到的场景 / 反差 / 工厂 / 仓库"等概念去覆盖用户的设定。无论何种情况，都不得把用户已写明的场景改成别的事物。
- 若本次给了【用户素材】，必须真正把它用起来，而不是只当没看见：
  · 网址素材的标题 / 摘要 / 小标题 / 正文摘录是真实文字，产品名、卖点、行业都优先从这里取；
  · 图片 / 视频的实测色彩、明暗、构图、光影、留白决定「视觉风格倾向」与画面基调；
  · 给了「画面理解（AI 提取）」的素材，**主体与所有视觉描述（配色 / 材质感 / 构图 / 光影 / 留白 / 主体位置）必须严格按它写**，
    不得出现素材里没有的颜色或元素；**没给画面理解的素材，只能做气质层面的呼应，严禁编造图中具体有什么物体**（你没有真的看到图）。
- 【用户素材就是成片画面的视觉事实】若给了带「画面理解」的图片 / 视频：请把它当作画面的事实依据——
  先据此写准配色、材质、构图、光影、留白，再围绕这些事实组织卖点与场景；不要另起一套与素材不符的画面。
  描述要**抓住素材的视觉重点**（主色域、主体所在、明暗节奏、留白处），而不是套一个通用产品宣传模板把素材埋掉。
- 【不编造产品】你没有任何视觉模型，看不到图里具体是什么商品。因此产品名 / 品类 / 品牌只能来自
  ①用户原始描述 或 ②网址素材的真实文字；两者都没有时，就用素材「画面理解」里的视觉特征来指代主体
  （颜色 + 形状 + 材质感 + 构图 + 留白），**绝对禁止**自行发明"智能音箱""智能手表""手机"等具体品类。
  场景与卖点可以合理联想，但画面的视觉描述必须忠于素材实测。`;

// 每次点击「AI 优化描述」随机抽一个创意视角，保证同一句输入也能产出不同版本的描述
const OPTIMIZE_ANGLES = [
  "用户一天的使用旅程，从清晨到深夜",
  "从一个具体痛点造成的窘境切入，再用产品反转让局面扭转",
  "把产品能力拆成三个可视化动作，一个动作一个卖点",
  "极端对比：没有它时的忙乱 vs 有它时的从容",
  "用一个贯穿全片的具体视觉符号把各段串起来",
  "让产品以第一人称自述（\"我负责……\"），带点性格",
  "用数字与数据可视化的方式呈现效率变化",
  "用两个人物之间的一段短对话推进叙事",
  "聚焦\"第一次打开它\"的三分钟体验",
  "把产品放进一个意想不到的场景里，用反差制造记忆点",
  "反证法：先讲如果没有它会怎样，再给出解法",
  "用一个具体时间点或倒计时制造推进张力",
  "聚焦一个被忽视的细节，从细节放大到产品价值",
  "把使用场景放进不同的城市/空间，用空间切换推进节奏",
];

function pickOptimizeAngle() {
  return OPTIMIZE_ANGLES[Math.floor(Math.random() * OPTIMIZE_ANGLES.length)];
}

// 素材用法不同，优化描述该怎么写也不同：先说清规则，模型才不会一律当成「参考一下就行」
const OPTIMIZE_ASSET_RULE = {
  reference:
    "【这些素材的用法：仅参考】素材不会真的进画面。请把素材的色调 / 明暗 / 气质，以及网址里的真实信息，" +
    "融进本片的「视觉风格倾向」与场景选择；但**不要**写成「画面里出现这张照片 / 这段视频」，成片画面仍是原创绘制。",
  direct:
    "【这些素材的用法：直接使用】这些图片 / 视频 / 网址主图会**原样出现在成片画面里**。" +
    "描述里的产品外观、使用环境、主色调必须与素材内容对得上——素材里是什么样的东西，就写什么样的，" +
    "别写成另一个产品；并点明哪些画面是留给素材本体呈现的。",
  redraw:
    "【这些素材的用法：AI 重绘】素材会被提取主体后按本片风格重绘，重绘件作为画面主体进片。" +
    "描述请围绕「画面理解」里的主体与构图展开，让分镜主体与素材主体保持一致。",
};

/**
 * 把用户素材整理成给优化器看的一段简报（含该类用法下的硬规则）。
 * 没有素材就返回空串——调用方直接拼进 userMessage，空串不产生多余内容。
 *
 * @param {Array} assets 已归一化的素材（可带 brief：AI 提取出的主体理解）
 * @param {"reference"|"direct"|"redraw"} mode
 */
function buildOptimizeAssetsBrief(assets, mode = "reference") {
  const list = (Array.isArray(assets) ? assets : []).filter(Boolean);
  if (!list.length) return "";

  const blocks = list.map((a, i) => {
    const kindCn = a.kind === "url" ? "网址" : a.kind === "video" ? "视频" : "图片";
    const name = a.label || a.file || a.title || a.host || a.url || "未命名素材";
    const body = [];

    // ① AI 提取出的主体理解（有就用；没有就只给实测特征，模型不得编造）
    const b = a.brief && typeof a.brief === "object" ? a.brief : null;
    if (b) {
      const bits = [];
      if (b.subject) bits.push(`主体：${b.subject}`);
      if (Array.isArray(b.elements) && b.elements.length) bits.push(`主要元素：${b.elements.slice(0, 6).join("、")}`);
      if (b.composition) bits.push(`构图：${b.composition}`);
      if (b.mood) bits.push(`气质：${b.mood}`);
      if (bits.length)
        body.push(`画面理解（AI 提取，成片画面的视觉事实来源，配色/材质/构图/光影/留白必须据此）：${bits.join("；")}`);
    }

    // ② 网址：真实文字信息，这是最可靠的内容来源
    if (a.kind === "url") {
      if (a.url) body.push(`网址：${a.url}`);
      if (a.title) body.push(`网页标题：${a.title}`);
      if (a.description) body.push(`网页摘要：${a.description}`);
      if (Array.isArray(a.headings) && a.headings.length) body.push(`网页小标题：${a.headings.slice(0, 6).join(" / ")}`);
      if (a.text) body.push(`正文摘录：${String(a.text).slice(0, 300)}`);
    }

    // ③ 实测画面特征（浏览器 canvas 采样，客观事实）
    const feats = [];
    if (Number(a.width) && Number(a.height)) feats.push(`尺寸 ${Number(a.width)}x${Number(a.height)}`);
    if (Array.isArray(a.palette) && a.palette.length) feats.push(`实测主色 ${a.palette.slice(0, 5).join(" / ")}`);
    const br = Number(a.brightness);
    if (Number.isFinite(br)) feats.push(`平均明度 ${br.toFixed(2)}（${br < 0.35 ? "偏暗" : br > 0.65 ? "偏亮" : "中调"}）`);
    const grid = describeGrid(a.grid);
    if (grid) feats.push(`九宫格分布 ${grid}`);
    if (feats.length) body.push(`实测画面特征：${feats.join("；")}`);
    // 视频只取了中段一帧的特征，别让模型以为这就是整支视频的全部内容
    if (a.kind === "video") body.push("（注：视频只采样了中段一帧，以上仅代表该帧的色调与明暗）");

    if (!body.length) return `${i + 1}. 【${kindCn}】${name}`;
    return `${i + 1}. 【${kindCn}】${name}\n   ${body.join("\n   ")}`;
  });

  const rule = OPTIMIZE_ASSET_RULE[mode] || OPTIMIZE_ASSET_RULE.reference;
  return `\n\n【用户提供的素材（本次必须纳入考虑）】\n${blocks.join("\n")}\n\n${rule}`;
}

// 清掉模型偶尔带出的包装（代码块 / "优化后的描述：" 前缀 / 首尾引号 / 结尾说明）
function sanitizeOptimizedPrompt(text, fallback) {
  let t = String(text || "").trim();
  t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```\s*$/, "").trim();
  t = t.replace(/^\s*(优化后(的)?(描述|提示词|文案)?|扩写后(的)?(描述|提示词)?|prompt)\s*[:：]\s*/i, "");
  t = t.replace(/^["“「]([\s\S]*)["”」]$/, "$1").trim();
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (!t) return fallback;
  return t.slice(0, 1200).trim();
}

/**
 * 判断用户原始描述是否已经是「完整创意方案」。
 * 命中越多创作性关键词、且篇幅足够，越说明场景/情绪/叙事/人称已被用户明确指定——
 * 这种情况下优化器应原样保留，只做润色补全，绝不能让随机视角去覆盖它。
 */
const DETAIL_MARKERS = [
  /场景/,
  /午后|清晨|夜晚|窗边|台灯|展览|陈列|逆光|陈列空间/,
  /第一人称|我负责|自述/,
  /叙事线索/,
  /情绪基调|情绪/,
  /视觉风格|风格倾向/,
  /镜头|特写|微距|留白/,
  /开场|结尾|中段/,
  /复古|鎏金|奢华|厚重|浓郁|极简沉稳/,
  /暖黄|亮黄|深棕|金橙|高饱和|平滑的亮黄/,
];
function isDetailedBrief(text) {
  const t = String(text || "");
  if (t.length < 200) return false; // 太短一定是含糊描述
  let hits = 0;
  for (const re of DETAIL_MARKERS) if (re.test(t)) hits++;
  return hits >= 4;
}

/**
 * 把一句含糊描述扩写成可执导的产品简报。
 * @param {string} apiKey
 * @param {string} rawPrompt 用户原始描述（续点优化时请传最初那句，而不是上一版结果）
 * @param {{ angle?: string, avoid?: string[], onDelta?: (d: string) => void,
 *           assets?: Array, assetMode?: string }} opts
 *        angle  本次创意视角（不传则随机）
 *        avoid  已生成过的版本正文，用于要求本版不重复
 *        onDelta 增量回调，用于前端流式显示
 *        assets / assetMode 用户素材与用法三态：素材内容要真的参与扩写，
 *                否则用户传了产品图，优化出来的描述却跟图毫无关系
 */
async function optimizePrompt(apiKey, rawPrompt, opts = {}) {
  const cleaned = String(rawPrompt || "").trim();
  if (!cleaned) throw new Error("提示词为空，无法优化");

  // 用户已给完整方案：强制「保留式润色」，不让随机视角把 TA 指定的场景/情绪/叙事覆盖掉
  const detailed = isDetailedBrief(cleaned);
  const angle = detailed
    ? "用户已给出完整创意方案（场景、情绪、视觉风格、叙事、人称均已指定）：请原样保留其全部设定，只做文字润色、节奏打磨与必要细节补全，不得替换或新增与之冲突的设定"
    : opts.angle || pickOptimizeAngle();
  const angleLabel = detailed ? "本次处理方式（必须遵循）" : "本次创意视角（必须采纳）";
  const avoid = (opts.avoid || []).filter((s) => String(s || "").trim()).slice(-3);
  const avoidBlock = avoid.length
    ? `\n\n【已经生成过的版本——本版需不同（${
        detailed
          ? "场景/情绪/叙事结构须保持一致，仅在文字表达、细节铺陈、节奏上与前版拉开差异"
          : "换场景、换卖点顺序、换画面细节与用词，重合度越低越好"
      }）】\n${avoid.map((s, i) => `版本${i + 1}：${String(s).slice(0, 400)}`).join("\n")}`
    : "";
  const assetsBrief = buildOptimizeAssetsBrief(opts.assets, opts.assetMode);
  const userMessage = `【原始描述】\n${cleaned}\n\n【${angleLabel}】${angle}${assetsBrief}${avoidBlock}`;

  const t0 = Date.now();
  // 优化只是"短改写"，用最省思考的档位：实测本网关 low→104s / minimal→11.5s，且 minimal 正文更长更聚焦。
  // max_tokens 给足：一旦被截断（finish=length）会正文为空需要重试，反而更慢。
  const effort = process.env.LLM_OPTIMIZE_EFFORT || "minimal";
  const content = await callLLM(apiKey, OPTIMIZER_PROMPT, userMessage, 8192, 1.0, opts.onDelta || null, effort);
  const optimized = sanitizeOptimizedPrompt(content, cleaned);
  console.error(
    `[optimize] 视角「${angle}」完成: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${cleaned.length} → ${optimized.length} 字符`
  );
  return { optimized, angle };
}

// ============================================================
//  LLM 调用（流式 SSE，避免网关 600s 非流式硬超时）
// ============================================================
async function streamLLM(apiKey, systemPrompt, userMessage, maxTokens, temperature, timeoutMs, onDelta = null, reasoningEffort = undefined, maxReasoningChars = 0) {
  // 思考强度：本网关对 "low" 会真的产出一万多字思考（实测 104s），"minimal" 则几乎不思考（11.5s）。
  // 因此调用方可以逐次指定——短改写类任务用 minimal，写代码仍用 low 保质量。
  const effort = reasoningEffort !== undefined ? reasoningEffort : process.env.LLM_REASONING_EFFORT || "low";
  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature,
    max_tokens: maxTokens,
    stream: true,
    ...(effort && effort !== "none" ? { reasoning_effort: effort } : {}),
  });
  const payload = Buffer.from(body, "utf-8");
  const u = new URL(LLM_URL);

  // 先建隧道（若配了代理）。这一步失败就是网络类故障，直接抛出交给上层重试。
  const routed = await withProxy(
    u.protocol === "http:" ? http : https,
    {
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Length": payload.length,
      },
    },
    CONNECT_TIMEOUT_MS
  );
  const client = routed.client;

  return new Promise((resolve, reject) => {
    // 连接/首包超时：TCP 握手或网关迟迟不回（断网 / 网关挂死）时快速失败。
    // 用自己的定时器而不是请求的 timeout 选项——后者在响应开始后无法可靠解除
    // （推理模型可能静默思考很久，会被误杀）。
    // 计时从「socket 真正分配」开始：请求创建后可能先排队等我方事件循环，
    // 那段时间是本地 CPU 造成的（例如校验里的 tsc），不该算成网络超时、误杀正常请求。
    let connectTimer = null;
    const armConnectTimer = () => {
      if (connectTimer) return;
      connectTimer = setTimeout(() => {
        req.destroy(new Error(`连接 AI 网关超时 (${CONNECT_TIMEOUT_MS / 1000}s)`));
      }, CONNECT_TIMEOUT_MS);
    };

    const req = client.request(
      routed.opts,
      (res) => {
        // 响应开始了：撤掉连接超时，改由 STREAM_TIMEOUT_MS 兜底
        clearTimeout(connectTimer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            reject(new Error(`AI API 错误 ${res.statusCode}: ${text.slice(0, 300)}`));
          });
          return;
        }
        // 解析 SSE 流
        let buffer = "";
        let content = "";
        let finish = "unknown";
        let gotData = false;
        let reasoningChars = 0;

        // 双看门狗：
        //   totalTimer —— 总时长上限，防止「一直在吐但永远吐不完」的病理性调用
        //   idleTimer  —— 空闲看门狗，每收到一个 chunk 就重置；网关静默时才是它触发
        // 只留总超时的话，网关「回了响应头就永久静默」会让整个生成挂到超时才动，
        // 前端表现就是进度条死在最后一项、用户以为程序崩了。
        let settled = false;
        const totalTimer = setTimeout(() => {
          settled = true;
          req.destroy(new Error(`AI API 流式响应超时 (${Math.round(timeoutMs / 1000)}s)`));
        }, timeoutMs);
        let idleTimer = null;
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            settled = true;
            clearTimeout(totalTimer);
            req.destroy(new Error(`AI API 流式响应中断（${Math.round(STREAM_IDLE_TIMEOUT_MS / 1000)}s 无数据）`));
          }, STREAM_IDLE_TIMEOUT_MS);
        };
        const clearAll = () => {
          clearTimeout(totalTimer);
          if (idleTimer) clearTimeout(idleTimer);
        };
        armIdle();

        res.on("data", (chunk) => {
          if (!settled) armIdle(); // 还在吐数据 → 没卡，重新计时
          buffer += chunk.toString("utf-8");
          // SSE 事件以 \n\n 分隔
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const evt of events) {
            for (const line of evt.split("\n")) {
              if (line.startsWith("data: ")) {
                const dataStr = line.slice(6).trim();
                if (dataStr === "[DONE]") continue;
                try {
                  const parsed = JSON.parse(dataStr);
                  const delta = parsed.choices?.[0]?.delta;
                  // 思考增量（部分模型/网关会单独给 reasoning_content）：只用于进度反馈，不计入正文
                  const rc = delta?.reasoning_content || delta?.reasoning;
                  if (rc) {
                    reasoningChars += rc.length;
                    // 思考看门狗：本网关偶发"思考几万字还没开始写代码"的病理长尾（实测单组件卡 5 分钟以上）。
                    // 超过阈值直接掐掉本次调用，交给上层换更省思考的档位重试。
                    if (maxReasoningChars > 0 && reasoningChars > maxReasoningChars) {
                      settled = true;
                      clearAll();
                      req.destroy(
                        new Error(`思考过长（已 ${reasoningChars} 字仍未开始写代码，阈值 ${maxReasoningChars}），已中止本次调用`)
                      );
                      return;
                    }
                    if (onDelta) {
                      try {
                        onDelta(rc, true);
                      } catch {}
                    }
                  }
                  if (delta?.content) {
                    content += delta.content;
                    // 增量回调：给前端做「边写边显示 / 已输出 N 字符」的实时反馈
                    if (onDelta) {
                      try {
                        onDelta(delta.content, false);
                      } catch {}
                    }
                  }
                  if (parsed.choices?.[0]?.finish_reason) finish = parsed.choices[0].finish_reason;
                  gotData = true;
                } catch {}
              }
            }
          }
        });

        res.on("end", () => {
          clearAll();
          if (!content && !gotData) {
            reject(new Error("AI 返回内容为空且无流式数据"));
          } else {
            resolve({ content, finish });
          }
        });

        res.on("error", (e) => {
          clearAll();
          reject(e);
        });
      }
    );

    req.on("socket", armConnectTimer);
    req.on("error", (e) => { clearTimeout(connectTimer); reject(e); });
    req.write(payload);
    req.end();
  });
}

// 瞬时故障判定：429 并发限制 / 网关断流（ECONNRESET 等）/ 5xx / 空响应 / 空错误消息。
// 这类故障在 callLLM 内部退避重试消化掉，不烧掉上层组件的 3 次重试配额。
function isTransientLLMError(e) {
  const msg = String((e && e.message) || "");
  const code = String((e && e.code) || "");
  if (!msg.trim()) return true; // 空错误消息：网关断流的典型表现
  if (msg.includes("429")) return true;
  if (/(ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|EAI_AGAIN|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH)/i.test(code + " " + msg)) return true;
  if (/socket hang up|premature close|network|fetch failed|连接 AI 网关超时/i.test(msg)) return true;
  if (/^AI API 错误 5\d\d/.test(msg)) return true; // 网关 5xx
  if (msg.includes("AI 返回内容为空")) return true; // 空流，重试无害
  return false;
}

async function callLLM(apiKey, systemPrompt, userMessage, maxTokens, temperature = 0.9, onDelta = null, reasoningEffort = undefined, maxReasoningChars = 0) {
  const t0 = Date.now();
  // 瞬时故障：指数退避重试（4s→8s→16s→32s→60s，含抖动），最多 6 次尝试
  const MAX_RETRY = Number(process.env.LLM_MAX_RETRY) || 6;
  let lastErr = null;
  let connectFailStreak = 0; // 连续连接层失败次数
  for (let retry = 0; retry < MAX_RETRY; retry++) {
    if (retry > 0) {
      const waitMs = Math.min(60000, 4000 * Math.pow(2, retry - 1)) + Math.random() * 3000;
      console.error(`  [stream] 瞬时故障，退避 ${Math.round(waitMs / 1000)}s 后第 ${retry + 1} 次尝试: ${explainLLMError(lastErr)}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      const { content, finish } = await streamLLM(apiKey, systemPrompt, userMessage, maxTokens, temperature, STREAM_TIMEOUT_MS, onDelta, reasoningEffort, maxReasoningChars);
      const dt = ((Date.now() - t0) / 1000).toFixed(0);
      if (retry > 0) console.error(`  [stream] 第 ${retry + 1} 次尝试成功 (总耗时 ${dt}s)`);
      console.error(`  [stream] 完成: ${dt}s, ${content.length} 字符, finish=${finish}`);
      if (!content) throw new Error(`AI 返回内容为空 (finish_reason=${finish}, ${dt}s)`);
      return content;
    } catch (e) {
      lastErr = e;
      if (!isTransientLLMError(e) || retry === MAX_RETRY - 1) throw e;
      // 连接层连续失败 = 网络多半真的断了，再退避重试只是白等
      connectFailStreak = isConnectFailure(e) ? connectFailStreak + 1 : 0;
      if (connectFailStreak >= CONNECT_FAIL_LIMIT) {
        throw new Error(`${explainLLMError(e)}（连续 ${connectFailStreak} 次连接失败，已停止重试）`);
      }
    }
  }
  throw lastErr || new Error("AI 调用失败（未知原因）");
}

// ============================================================
//  解析
// ============================================================
function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function stripFences(code) {
  return code
    .replace(/^\s*```(?:tsx|typescript|jsx|ts)?\s*\r?\n?/, "")
    .replace(/\r?\n?\s*```\s*$/, "")
    .trim();
}

// ============================================================
//  内容不变量：场景名 / 文件名的确定性归一化
//  配音不再由这里决定——它在规划之后由 planVoiceover() 单独产出一份「配音方案」，
//  再交给 voiceKit 合成音频；manifest.voice 由 applyVoicePlan() 回填。
// ============================================================
function repairManifest(manifest) {
  manifest.scenes = manifest.scenes.map((s, i) => ({
    ...s,
    // 确定性归一化：场景名强制小写+连字符，文件名按序号分配
    name: String(s.name || `scene-${i + 1}`)
      .replace(/([a-z])([A-Z])/g, "$1-$2")  // camelCase → kebab-case
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || `scene-${i + 1}`,
    file: `Scene${i + 1}.tsx`,
  }));
  manifest.voice = { enabled: false, provider: "none", voiceName: "", tracks: [], bgm: null };
  return manifest;
}

// ============================================================
//  时长对齐：用户填了目标时长时，把 AI 给的分镜时长精确缩放到目标总帧数
// ============================================================
// 总时长 = ΣdurationInFrames − Σoverlap（overlap 是相邻分镜的重叠帧数）。
// AI 给的时长只是「相对比例」，这里按比例分配后把余量均摊到还有余量的分镜上，
// 尽量精确命中目标；目标超出可行区间（太短/太长）时贴合边界并如实报告实际时长。
function fitManifestToDuration(manifest, targetFrames) {
  const scenes = manifest.scenes;
  if (!Array.isArray(scenes) || !scenes.length || !targetFrames) return null;

  const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  const overlaps = scenes.map((s, i) =>
    i === scenes.length - 1 ? 0 : clampInt(s.overlap, 12, 24, 18)
  );
  const overlapSum = overlaps.reduce((a, b) => a + b, 0);
  const need = targetFrames + overlapSum; // 各分镜帧数之和

  const weights = scenes.map((s) => Math.max(1, Number(s.durationInFrames) || FPS * 6));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const d = weights.map((w) => clampInt((need * w) / wsum, MIN_SCENE_FRAMES, MAX_SCENE_FRAMES, FPS * 6));

  // 把与目标的差额均摊给仍有余量的分镜（比例分配后通常只剩几十帧的零头）
  let diff = need - d.reduce((a, b) => a + b, 0);
  for (let guard = 0; guard < 60 && diff !== 0; guard++) {
    const idx = d
      .map((_, i) => i)
      .filter((i) => (diff > 0 ? d[i] < MAX_SCENE_FRAMES : d[i] > MIN_SCENE_FRAMES));
    if (!idx.length) break;
    const per = Math.trunc(diff / idx.length) || (diff > 0 ? 1 : -1);
    for (const i of idx) {
      const next = clampInt(d[i] + per, MIN_SCENE_FRAMES, MAX_SCENE_FRAMES, d[i]);
      diff -= next - d[i];
      d[i] = next;
      if (diff === 0) break;
    }
  }

  scenes.forEach((s, i) => {
    s.durationInFrames = d[i];
    s.overlap = overlaps[i];
  });
  const actual = d.reduce((a, b) => a + b, 0) - overlapSum;
  return { targetFrames, actualFrames: actual, exact: actual === targetFrames, scenes: scenes.length };
}

// ============================================================
//  校验
// ============================================================
function validateManifest(manifest, durRange = { min: 60, max: 240 }) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") return ["manifest 缺失或不是对象"];
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(String(manifest.id || ""))) errors.push("manifest.id 必须是 PascalCase 英文标识符");
  if (!manifest.title) errors.push("manifest.title 缺失");
  const scenes = manifest.scenes;
  if (!Array.isArray(scenes) || scenes.length < 3 || scenes.length > 10) {
    errors.push("scenes 数量须在 3-10 之间");
    return errors;
  }
  const names = new Set();
  const subs = new Set();
  scenes.forEach((s, i) => {
    if (!s.name || !/^[a-z][a-z0-9-]*$/.test(s.name)) errors.push(`scene[${i}].name 须为小写英文/数字/连字符`);
    else if (names.has(s.name)) errors.push(`scene[${i}].name 重复: ${s.name}`);
    else names.add(s.name);
    if (
      !Number.isInteger(s.durationInFrames) ||
      s.durationInFrames < durRange.min ||
      s.durationInFrames > durRange.max
    )
      errors.push(`scene[${i}].durationInFrames 须为 ${durRange.min}-${durRange.max} 的整数`);
    if (!Number.isInteger(s.overlap) || s.overlap < 0 || s.overlap > 30)
      errors.push(`scene[${i}].overlap 须为 0-30 的整数`);
    const sub = String(s.subtitle || "").trim();
    if (sub.length < 4) errors.push(`scene[${i}].subtitle 缺失或过短`);
    else if (subs.has(sub)) errors.push(`scene[${i}].subtitle 与其他分镜重复`);
    else subs.add(sub);
  });
  return errors;
}

// tsc 作用域检查：拦截 AI 代码里"使用了但从未定义"的标识符（typo / 漏写辅助函数）。
// esbuild 只查语法不做作用域分析，这类错误要到 Remotion 渲染到该帧才 ReferenceError，
// 代价是数分钟的渲染时间。这里用 tsc --noEmit 只筛 TS2304 Cannot find name，其余类型错误忽略。
// tsc 进程池：必须异步 + 限流。spawnSync 会阻塞事件循环约 1s，
// 期间所有并行的 LLM 流式响应都读不到数据（TCP 缓冲顶着），看起来像"卡住"，
// 还会连带触发其它请求的连接超时误判。限流则避免 4 路并发校验把 CPU 打满。
const TSC_CONCURRENCY = Number(process.env.TSC_CONCURRENCY) || 4;
let tscRunning = 0;
const tscQueue = [];
function tscAcquire() {
  if (tscRunning < TSC_CONCURRENCY) {
    tscRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve) => tscQueue.push(resolve));
}
function tscRelease() {
  tscRunning--;
  const next = tscQueue.shift();
  if (next) {
    tscRunning++;
    next();
  }
}

function tscRun(tscBin, tmpFile) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(
      process.execPath,
      [
        tscBin, "--noEmit", "--skipLibCheck",
        "--jsx", "react-jsx", "--esModuleInterop", "--allowSyntheticDefaultImports",
        "--module", "esnext", "--moduleResolution", "bundler",
        "--target", "es2022", "--lib", "es2022,dom,dom.iterable",
        tmpFile,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);
    const done = (text) => { clearTimeout(killer); resolve(text); };
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", () => done(""));
    child.on("close", () => done(out + err));
  });
}

// tscUndefinedErrors 每次检查都要在 ROOT 下建一个 .tsc-check-XXXX 临时目录，
// 正常路径会在 finally 里删掉；但生成被中断 / 进程被杀时就会留下。
// 实测长时间使用会累积到几百个（曾一次清出 440 个），所以启动时扫一遍过期残留。
// 两个约束：只删 10 分钟前的（单次 tsc 检查只需几秒，且服务启动后 ~1s 才开扫，
// 绝不会误删在用的），且必须分片让出事件循环 —— 曾试过同步删，残留多时直接把服务
// 卡死，端口在 listen 但一个请求都回不了（Windows 删目录开销大）。
const TSC_TMP_PREFIX = ".tsc-check-";
const TSC_TMP_MAX_AGE_MS = 10 * 60 * 1000;

function listStaleTscDirs(maxAgeMs = TSC_TMP_MAX_AGE_MS) {
  let ents = [];
  try { ents = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  const now = Date.now();
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory() || !e.name.startsWith(TSC_TMP_PREFIX)) continue;
    const p = path.join(ROOT, e.name);
    try {
      if (now - fs.statSync(p).mtimeMs >= maxAgeMs) out.push(p);
    } catch {}
  }
  return out;
}

// 分片清理：每个 tick 最多干 sliceMs 毫秒就让出事件循环，所以服务照常响应。
// 返回实际删掉的数量。
function sweepStaleTscDirs(maxAgeMs = TSC_TMP_MAX_AGE_MS, maxRemove = 1000, sliceMs = 30) {
  const targets = listStaleTscDirs(maxAgeMs).slice(0, maxRemove);
  if (!targets.length) return Promise.resolve(0);
  return new Promise((resolve) => {
    let i = 0;
    let removed = 0;
    const step = () => {
      const deadline = Date.now() + sliceMs;
      while (i < targets.length && Date.now() < deadline) {
        try { fs.rmSync(targets[i], { recursive: true, force: true }); removed++; } catch {}
        i++;
      }
      if (i < targets.length) return setImmediate(step);
      if (removed) console.error(`[codegen] 清理了 ${removed} 个过期的 tsc 临时目录`);
      resolve(removed);
    };
    setImmediate(step);
  });
}

async function tscUndefinedErrors(name, code) {
  const tscBin = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tscBin)) return []; // typescript 不可用时静默跳过，不阻塞生成
  let tmpDir = null;
  await tscAcquire();
  try {
    tmpDir = fs.mkdtempSync(path.join(ROOT, TSC_TMP_PREFIX)); // 临时目录在 ROOT 下 → 能解析 ROOT/node_modules 的 react/@types/remotion
    const tmpFile = path.join(tmpDir, name.replace(/[^\w.-]/g, "_") + ".tsx");
    fs.writeFileSync(tmpFile, code);
    const text = await tscRun(tscBin, tmpFile);
    // TS2304: Cannot find name 'X'；TS2552: Cannot find name 'X'. Did you mean 'Y'?（后者：作用域内有近似名）
    // TS2300 / TS2440 / TS2451: Duplicate identifier 'X'（同名重复声明，esbuild/vite 同样直接报错）
    const seen = new Set();
    const errs = [];
    const collect = (re, build) => {
      let mm;
      while ((mm = re.exec(text)) !== null) {
        if (!seen.has(mm[1])) {
          seen.add(mm[1]);
          errs.push(build(mm[1]));
        }
      }
    };
    collect(
      /error TS(?:2304|2552): Cannot find name '([^']+)'/g,
      (n) => `文件 ${name} 使用了未定义标识符 ${n}（渲染到该帧会 ReferenceError，请定义它或改用已定义的变量/函数）`
    );
    // 重复声明：esbuild 不做类型检查、能打包，但 vite 的 babel 转换会直接抛
    // "Identifier 'x' has already been declared"，整个页面白屏 —— 必须挡在生成阶段
    collect(
      /error TS(?:2300|2440|2451): Duplicate identifier '([^']+)'/g,
      (n) => `文件 ${name} 重复声明了标识符 ${n}（同名 import/变量/函数出现两次，vite 会报 Identifier '${n}' has already been declared 并整页白屏；请只保留一处，注意同一模块的 import 要合并成一条）`
    );
    return errs;
  } catch {
    return []; // 检查器自身故障时不阻塞生成
  } finally {
    tscRelease();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

// 静态检查：Easing.<method> 必须是 Remotion 实有的。AI 常臆造 Easing.quint/quart/sine 等，
// 静态不报、渲染到调用帧才 TypeError（Remotion 实有 in/out/inOut/quad/cubic/poly/sin/circle/exp/bounce/elastic/back/bezier/linear/ease）。
const REMOTION_EASING_OK = new Set(["linear", "ease", "in", "out", "inOut", "quad", "cubic", "poly", "sin", "circle", "exp", "bounce", "elastic", "back", "bezier"]);
function easingWhitelistErrors(name, code) {
  const errors = [];
  const re = /Easing\.([A-Za-z_$][\w$]*)/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(code)) !== null) {
    if (!REMOTION_EASING_OK.has(m[1]) && !seen.has(m[1])) {
      seen.add(m[1]);
      errors.push(`文件 ${name} 用了不存在的 Easing.${m[1]}（Remotion 无此方法，渲染到该帧 TypeError；可用 in/out/inOut/quad/cubic/poly/sin/circle/exp/bounce/elastic/back/bezier）`);
    }
  }
  return errors;
}

// 静态检查：spring({...}) 必须含 fps。缺 fps → spring 计算出 NaN，渲染报错。
function springMissingFpsErrors(name, code) {
  const errors = [];
  const codeNoImports = code.replace(/import[\s\S]*?from\s*["'][^"']+["']/g, "");
  let i = 0;
  while ((i = codeNoImports.indexOf("spring(", i)) !== -1) {
    const j = codeNoImports.indexOf("{", i);
    if (j === -1 || j > i + 24) { i += 6; continue; } // 不是 spring({...}) 形态
    let depth = 0, end = -1;
    for (let k = j; k < codeNoImports.length; k++) {
      if (codeNoImports[k] === "{") depth++;
      else if (codeNoImports[k] === "}") { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end === -1) { i += 6; continue; }
    const obj = codeNoImports.slice(j, end + 1);
    if (!/\bfps\b/.test(obj)) {
      errors.push(`文件 ${name} spring({...}) 缺少 fps（须 const {fps}=useVideoConfig() 后传入，否则 spring 计算出 NaN，渲染报错）`);
    }
    i = end + 1;
  }
  return errors;
}

// 合并同一个模块的多条 import 语句（去重 + 并成一行）。
//
// 为什么必须有：AI 经常这样写 ——
//     import { AbsoluteFill, spring, useVideoConfig } from "remotion";
//     import { interpolate } from "remotion";        ← 单独第二条，本身合法
// 而「补 import」只读第一条，认为 interpolate 缺失 → 把它补回第一条，
// 于是同名标识符被声明两次；紧接着 routeInterpolateToSafe 又把第一条的
// interpolate 摘到 safeInterp，第二条就永久残留成
//     import { interpolate } from "../safeInterp";
//     import { interpolate } from "remotion";   ← 重复声明
// vite/babel 直接报 "Identifier 'interpolate' has already been declared"，预览整页白屏。
// 这里在「补 / 摘 / 装配」三处都先归一化，从源头和兜底两头堵住。
function dedupeImports(code) {
  const src = String(code || "");
  const re = /^[ \t]*import\s+([^;]*?)\s+from\s*["']([^"']+)["'];?[ \t]*(\r?\n)?/gm;
  const hits = [...src.matchAll(re)];
  if (!hits.length) return { code: src, merged: [] };

  const groups = new Map(); // 模块 → 各条 import 的 specifier 原文
  for (const h of hits) {
    // import type {...} 的合并语义不同（可能整体 type-only），遇到就整体跳过，宁可不动
    if (/(^|[,\s{])type\s/.test(h[1])) return { code: src, merged: [] };
    if (!groups.has(h[2])) groups.set(h[2], []);
    groups.get(h[2]).push(h[1]);
  }

  const rebuilt = new Map(); // 模块 → 合并后的 import 语句
  const merged = [];
  for (const [mod, specs] of groups) {
    if (specs.length <= 1) continue;
    const defaults = [];
    const named = new Map(); // 本地名 → 原文（保留 `X as Y` 写法）
    for (const spec of specs) {
      const brace = spec.match(/\{([\s\S]*)\}/);
      if (brace) {
        for (const raw of brace[1].split(",")) {
          const t = raw.trim();
          if (!t) continue;
          const local = t.split(/\s+as\s+/).pop().trim();
          if (!named.has(local)) named.set(local, t);
        }
      }
      const head = spec.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
      if (head) {
        const local = head.split(/\s+as\s+/).pop().trim();
        if (!defaults.includes(local)) defaults.push(local);
      }
    }
    // 两个不同的默认导入无法共存于一行，放弃合并这一组（保持原样更安全）
    if (defaults.length > 1) continue;
    const parts = [...defaults];
    if (named.size) parts.push(`{ ${[...named.values()].join(", ")} }`);
    if (!parts.length) continue;
    rebuilt.set(mod, `import ${parts.join(", ")} from "${mod}";`);
    merged.push(mod);
  }
  if (!rebuilt.size) return { code: src, merged: [] };

  const used = new Set();
  const out = src.replace(re, (full, spec, mod, nl) => {
    if (!rebuilt.has(mod)) return full;
    if (used.has(mod)) return ""; // 同模块的后续行删除
    used.add(mod);
    return rebuilt.get(mod) + (nl || "");
  });
  return { code: out, merged };
}

// 从某个模块的 import 行里摘掉指定名字（按本地名匹配，兼容 `X as Y`）；摘空则整行删除。
// 用于 routeInterpolateToSafe：safeInterp 已接管 interpolate 后，
// remotion 那行里不能还留着同名项，否则又是重复声明。
function stripNamesFromModule(code, moduleName, names) {
  const src = String(code || "");
  if (!names.length) return { code: src, removed: [] };
  const re = new RegExp(`^[ \\t]*import\\s+([^;]*?)\\s+from\\s+["']${moduleName}["'];?[ \\t]*(\\r?\\n)?`, "m");
  const hit = src.match(re);
  if (!hit) return { code: src, removed: [] };
  const spec = hit[1];
  const brace = spec.match(/\{([\s\S]*)\}/);
  if (!brace) return { code: src, removed: [] };
  const entries = brace[1].split(",").map((s) => s.trim()).filter(Boolean);
  const removed = [];
  const kept = entries.filter((e) => {
    const local = e.split(/\s+as\s+/).pop().trim();
    if (names.includes(local)) { removed.push(e); return false; }
    return true;
  });
  if (!removed.length) return { code: src, removed: [] };
  const head = spec.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
  const parts = [];
  if (head) parts.push(head);
  if (kept.length) parts.push(`{ ${kept.join(", ")} }`);
  const line = parts.length ? `import ${parts.join(", ")} from "${moduleName}";${hit[2] || ""}` : "";
  return { code: src.replace(re, line), removed };
}

// 确定性修复：AI 有时会给自己「兜底」定义与 remotion / react 同名的函数或变量 ——
//   function useCurrentFrame() { return (window as any).__remotion_frame ?? 0; }
//   function useVideoConfig() { ... }
//   const Easing = { ... }   const AbsoluteFill = ...
// 有时甚至把整套 API 都自造一遍。它们和文件顶部的 import 撞名，Babel 直接抛
//   Duplicate declaration "useCurrentFrame"
// 预览整页白屏。正确做法是保留 import、丢掉这些自造兜底
// （Remotion 运行时本来就有真实现，自造的那份只会遮蔽真实现）。
//
// 判定放宽到「与任意模块的导入撞名」：顶层声明和 import 同名在任何情况下都是
// 编译错误，不存在合法用法，所以删掉声明、留下 import 永远是对的
// （interpolate 是从 ../safeInterp 导入的，不能只盯 remotion/react）。
// 用 TypeScript 编译器 API 精确定位顶层声明，避免正则误伤函数体内同名变量。
function dropShadowedApiDeclarations(name, code) {
  let ts;
  try { ts = require("typescript"); } catch { return { code, removed: [] }; }
  let sf;
  try {
    sf = ts.createSourceFile("component.tsx", String(code), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);
  } catch { return { code, removed: [] }; }

  const importedFrom = new Map(); // 本地名 → 来源模块
  const decls = [];               // 顶层声明
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause) {
      const mod = String(st.moduleSpecifier.text);
      const c = st.importClause;
      if (c.name) importedFrom.set(c.name.text, mod);
      const nb = c.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const local = el.name || el.propertyName;
          if (local) importedFrom.set(local.text, mod);
        }
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      decls.push({ name: st.name.text, kind: "函数", node: st });
    } else if (ts.isClassDeclaration(st) && st.name) {
      decls.push({ name: st.name.text, kind: "类", node: st });
    } else if (ts.isEnumDeclaration(st) && st.name) {
      decls.push({ name: st.name.text, kind: "枚举", node: st });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) decls.push({ name: d.name.text, kind: "变量", node: st });
      }
    }
  }

  const hits = decls.filter((d) => importedFrom.has(d.name));
  if (!hits.length) return { code, removed: [] };

  // 整行连行尾换行一起删；从后往前删，避免前面删除影响后面的偏移
  const ranges = hits
    .map((h) => ({
      h,
      s: String(code).lastIndexOf("\n", h.node.getStart(sf) - 1) + 1,
      e: (() => { const i = String(code).indexOf("\n", h.node.getEnd()); return i === -1 ? String(code).length : i + 1; })(),
    }))
    .sort((a, b) => b.s - a.s);

  let out = String(code);
  const removed = [];
  for (const r of ranges) {
    out = out.slice(0, r.s) + out.slice(r.e);
    const from = importedFrom.get(r.h.name);
    removed.push(`${r.h.name}（自造${r.h.kind}与 ${from} 的导入同名）`);
    console.error(`  [repair] ${name} 删除自造${r.h.kind} ${r.h.name}（与 ${from} 的导入同名，会导致 Babel Duplicate declaration）`);
  }
  return { code: out, removed };
}

// 确定性修复：AI 常漏写 remotion import 头（esbuild 不报错，渲染时才 ReferenceError）。
// 校验前把用到但没导入的 API 补进 import 行——纯机械修复，不改变视觉输出。
// 注意：必须先 dedupeImports 把同模块的多条 import 并成一条，
//       否则「只读第一条」的补全逻辑会把同名标识符补成两份（见 dedupeImports 注释）。
// 解析一条 import 语句的 specifier 原文，返回它声明的本地名（兼容 `X as Y`、默认导入）
function specifierNames(spec) {
  const names = [];
  const brace = String(spec).match(/\{([\s\S]*)\}/);
  if (brace) {
    for (const raw of brace[1].split(",")) {
      const t = raw.trim();
      if (t) names.push(t.split(/\s+as\s+/).pop().trim());
    }
  }
  const head = String(spec).replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
  if (head) names.push(head.split(/\s+as\s+/).pop().trim());
  return names.filter(Boolean);
}

// 全文件所有 import 声明的本地名（不限模块）。
// 「谁没导入」必须看全文件：只盯 remotion 那一条，会把已从 safeInterp 等模块
// 导入的名字误判为缺失，再补一份到 remotion → 又变成重复声明。
function collectImportedNames(code) {
  const names = new Set();
  for (const m of String(code).matchAll(/^[ \t]*import\s+([^;]*?)\s+from\s*["'][^"']+["']/gm)) {
    for (const n of specifierNames(m[1])) names.add(n);
  }
  return names;
}

// 只补确定存在于 remotion 的 API，避免凭空 import 一个不存在的名字。
const AUTO_IMPORTABLE = ["AbsoluteFill", "useCurrentFrame", "useVideoConfig", "interpolate", "spring", "Sequence", "Easing", "Img", "OffthreadVideo", "staticFile", "delayRender", "continueRender", "CancelRender"];

function repairComponentImports(name, code) {
  // 先把同一模块的多条 import 并成一条，再去比对「谁没导入」
  // （只读第一条 remotion import 的老逻辑会把同名标识符补成两份）
  const deduped = dedupeImports(code);
  if (deduped.merged.length) {
    console.error(`  [repair] ${name} 合并重复 import（${deduped.merged.join(" / ")}）`);
    code = deduped.code;
  }
  // 再清掉与 remotion/react 导入同名的自造声明（否则 Babel 报 Duplicate declaration）
  const shadowed = dropShadowedApiDeclarations(name, code);
  if (shadowed.removed.length) code = shadowed.code;
  const used = AUTO_IMPORTABLE.filter((api) => new RegExp("\\b" + api + "\\b").test(code));
  if (!used.length) return { code, added: [] };
  const remImport = code.match(/import\s+([^;]*?)\s+from\s+["']remotion["'];?/);
  // 是否已导入要看全文件，不能只看 remotion 那一行（否则会把已从 safeInterp 等
  // 模块导入的名字误判为缺失，再补一份到 remotion，又变成重复声明）
  const imported = collectImportedNames(code);
  const remNames = remImport ? specifierNames(remImport[1]) : [];
  const missing = used.filter((api) => !imported.has(api));
  if (!missing.length) return { code, added: [] };
  if (remImport) {
    const merged = [...new Set([...remNames, ...missing])].sort();
    const fixed = `import { ${merged.join(", ")} } from "remotion";`;
    console.error(`  [repair] ${name} 补 remotion import: ${missing.join(", ")}`);
    return { code: code.replace(remImport[0], fixed), added: missing };
  }
  const line = `import { ${missing.join(", ")} } from "remotion";\n`;
  console.error(`  [repair] ${name} 补 remotion import: ${missing.join(", ")}`);
  // 放在 react import 之后（若有），否则放文件最前面
  const reactImport = code.match(/import[\s\S]*?from\s*["']react["'];?\n/);
  return reactImport
    ? { code: code.replace(reactImport[0], reactImport[0] + line), added: missing }
    : { code: line + code, added: missing };
}

// ============================================================
//  插值安全网（interpolate）
//  实测故障：AI 把「随索引递增的起始帧」和「固定结束帧」混写——
//      interpolate(frame, [10 + i * 4, 22 + i * 4, 45, 55], [...])
//  当 i ≥ 6 时就变成 [34, 46, 45, 55]，Remotion 直接抛
//      "inputRange must be strictly monotonically increasing but got [34,46,45,55]"
//  整个分镜白屏。静态检查只能拦纯字面量，这种「变量参与」的写法只好在运行期兜底。
//  做法：每个工程注入一个 src/safeInterp.ts，把场景/背景/胶水里的 interpolate
//  改成走这层包装 —— 非递增 / 重复 / NaN / 长度不一致 / easing 数组长度不符
//  全部在求值前修正。宁可视觉略有失真，也绝不让画面崩掉。
// ============================================================
const SAFE_INTERP_MODULE = `// 本文件由 Promix 生成器自动注入，请勿手改（重新生成工程会覆盖）。
// 目的：AI 写的 interpolate 偶尔不满足 Remotion 的硬约束（inputRange 严格递增、
// 与 outputRange 等长、元素必须是有限数），一旦触发就抛异常、整个分镜白屏。
// 这里统一包一层，把不合法的参数修正后才能求值。
import {
  interpolate as rawInterpolate,
  interpolateColors as rawInterpolateColors,
} from "remotion";

const EPS = 1e-3;

function sanitizeInputRange(range: any): any[] {
  const arr = Array.isArray(range) ? range.slice() : [];
  // 字符串 / 元组等非数字区间原样交给 remotion 处理
  if (!arr.length || typeof arr[0] !== "number") return arr;
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "number" || !Number.isFinite(arr[i])) {
      arr[i] = i === 0 ? 0 : arr[i - 1] + 1;
    }
  }
  for (let i = 1; i < arr.length; i++) {
    if (!(arr[i] > arr[i - 1])) {
      arr[i] = arr[i - 1] + Math.max(EPS, Math.abs(arr[i - 1]) * 1e-6);
    }
  }
  return arr;
}

function sanitizeOutputRange(range: any, len: number): any[] {
  const arr = Array.isArray(range) ? range.slice(0, len) : [];
  return arr.map((v: any) => (typeof v === "number" && !Number.isFinite(v) ? 0 : v));
}

function sanitizeOptions(options: any, stops: number): any {
  if (!options || typeof options !== "object") return options;
  const out: any = { ...options };
  // easing 传成数组时长度必须恰好是 inputRange.length - 1，否则 remotion 抛错
  if (Array.isArray(out.easing) && out.easing.length !== Math.max(1, stops - 1)) {
    delete out.easing;
  }
  return out;
}

function prep(input: any, inputRange: any, outputRange: any) {
  const ir = sanitizeInputRange(inputRange);
  const n = Math.min(ir.length, Array.isArray(outputRange) ? outputRange.length : 0);
  return {
    input: typeof input === "number" && !Number.isFinite(input) ? 0 : input,
    ir: ir.slice(0, n),
    or: sanitizeOutputRange(outputRange, n),
    stops: n,
  };
}

export function interpolate(input: number, inputRange: any, outputRange: any, options?: any): any {
  if (!Array.isArray(inputRange) || !Array.isArray(outputRange)) {
    return (rawInterpolate as any)(input, inputRange, outputRange, options);
  }
  const r = prep(input, inputRange, outputRange);
  if (r.stops === 0) return 0;
  if (r.stops === 1) return r.or[0];
  return (rawInterpolate as any)(r.input, r.ir, r.or, sanitizeOptions(options, r.stops));
}

export function interpolateColors(input: number, inputRange: any, outputRange: any, options?: any): any {
  if (!Array.isArray(inputRange) || !Array.isArray(outputRange)) {
    return (rawInterpolateColors as any)(input, inputRange, outputRange, options);
  }
  const r = prep(input, inputRange, outputRange);
  if (r.stops === 0) return r.or[0] || "transparent";
  if (r.stops === 1) return r.or[0];
  return (rawInterpolateColors as any)(r.input, r.ir, r.or, sanitizeOptions(options, r.stops));
}

export default interpolate;
`;

// 组件文件里 interpolate 要用的相对路径：src/scenes/Scene1.tsx → "../safeInterp"
function safeInterpImportPath(filePath) {
  const depth = filePath.split("/").length - 1; // 目录层数（src 记 1 层）
  return depth <= 1 ? "./safeInterp" : "../".repeat(depth - 1) + "safeInterp";
}

// 纯数字字面量的 inputRange 直接挤压成严格递增（生成期就地修好，不必让 AI 重试）
function squeezeLiteralInputRanges(code) {
  let fixed = 0;
  const out = code.replace(
    /(^|[^.\w$])(interpolate|interpolateColors)\s*\(\s*([^,]*?)\s*,\s*\[((?:\s*-?\d+(?:\.\d+)?\s*,)*\s*-?\d+(?:\.\d+)?\s*)\]\s*,/g,
    (full, head, fn, first, body) => {
      const nums = body.split(",").map((s) => parseFloat(s.trim()));
      const next = nums.slice();
      for (let i = 1; i < next.length; i++) {
        if (!(next[i] > next[i - 1])) next[i] = next[i - 1] + 1;
      }
      if (next.join(",") === nums.join(",")) return full;
      fixed++;
      return `${head}${fn}(${first}, [${next.join(", ")}],`;
    }
  );
  return { code: out, fixed };
}

// 把 interpolate / interpolateColors 改成从 "safeInterp" 导入。
// 幂等且自愈：已有 safeInterp 导入时校正相对路径层级并清掉 remotion 里的同名残留；
//            没有时才从 remotion 摘出来。
function routeInterpolateToSafe(fileName, code) {
  const want = safeInterpImportPath(fileName);
  const moved = [];
  let next = String(code);

  // 先把同模块的多条 import 并成一条：只处理第一条 remotion import 会漏掉
  // 藏在第二条里的同名项，摘出去后就成了两处都声明 interpolate
  const deduped = dedupeImports(next);
  if (deduped.merged.length) {
    console.error(`  [repair] ${fileName} 合并重复 import（${deduped.merged.join(" / ")}）`);
    next = deduped.code;
  }

  const safeRe = /import\s*\{([^}]*)\}\s*from\s*["']([^"']*safeInterp)["'];?/;
  const safe = next.match(safeRe);
  if (safe) {
    // 兜底：safeInterp 已接管的名字，remotion 那行里若还留着同名项就是重复声明
    // （历史工程、检查点里可能已经是这种坏形态，必须在装配时自愈）
    const safeNames = safe[1].split(",").map((s) => s.trim()).filter(Boolean);
    const stripped = stripNamesFromModule(next, "remotion", safeNames);
    if (stripped.removed.length) {
      next = stripped.code;
      moved.push(...safeNames);
      console.error(`  [repair] ${fileName} 清掉 remotion import 中与 safeInterp 重复的: ${stripped.removed.join(", ")}`);
    }
    if (safe[2] !== want) {
      next = next.replace(safeRe, `import { ${safe[1].trim()} } from "${want}";`);
      return { code: next, moved, pathFixed: safe[2], changed: next !== String(code) };
    }
    return { code: next, moved, pathFixed: null, changed: next !== String(code) };
  }

  const remImport = next.match(/import\s+([^;]*?)\s+from\s+["']remotion["'];?/);
  if (!remImport) return { code: next, moved, pathFixed: null, changed: next !== String(code) };
  const spec = remImport[1];
  const braceMatch = spec.match(/\{([\s\S]*)\}/);
  const named = braceMatch ? braceMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
  const names = named.filter((n) => n === "interpolate" || n === "interpolateColors");
  if (!names.length) return { code: next, moved, pathFixed: null, changed: next !== String(code) };
  const kept = named.filter((n) => !names.includes(n));
  const prefix = spec.replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim(); // 默认导入（若有）
  const remLine = [prefix, kept.length ? `{ ${kept.join(", ")} }` : ""].filter(Boolean).join(", ");
  next = remLine ? next.replace(remImport[0], `import ${remLine} from "remotion";`) : next.replace(remImport[0], "");
  // 放在 remotion import 之后（保持 import 块聚拢）
  const safeImport = `import { ${names.join(", ")} } from "${want}";\n`;
  const anchor = next.match(/import[\s\S]*?from\s*["']remotion["'];?\n/);
  next = anchor ? next.replace(anchor[0], anchor[0] + safeImport) : safeImport + next;
  moved.push(...names);
  return { code: next, moved, pathFixed: null, changed: next !== String(code) };
}

// routeInterpolateToSafe() 的逆向视图：把「已装配形态」还原成「AI 原始输出形态」，只用于校验。
// 背景：检查点里存的是装配形态的组件（interpolate 已改成从 ./safeInterp 导入），
// 而校验器认的是 AI 原始输出（只允许 import react/remotion），
// 不还原就会把每个检查点组件都误判成「只能 import react/remotion」而全部作废 —— 续跑直接失效。
function preAssemblyView(code) {
  const safeRe = /import\s*([^;]*?)\s*from\s*["'][^"']*safeInterp["'];?/;
  const hit = String(code || "").match(safeRe);
  if (!hit) return code;
  const names = hit[1].replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!names.length) return code;
  const next = code.replace(safeRe, "");
  const remRe = /import\s*\{([^}]*)\}\s*from\s*["']remotion["'];?/;
  const rm = next.match(remRe);
  if (!rm) return next;
  const merged = [...rm[1].split(",").map((s) => s.trim()).filter(Boolean), ...names];
  return next.replace(remRe, `import { ${[...new Set(merged)].join(", ")} } from "remotion";`);
}

// 组件连续失败时把"最后一次生成的代码 + 校验原因"落盘，便于事后排查
// （报错只在终端刷一下，UI 上看到的往往只有一句"未通过校验"）
function dumpFailure(fileName, attempt, code, errors) {
  try {
    const dir = path.join(__dirname, "failed");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), code, "utf8");
    fs.appendFileSync(
      path.join(dir, "report.log"),
      `\n[${new Date().toISOString()}] ${fileName} 尝试${attempt} 未通过:\n  ${errors.join("\n  ")}\n`,
      "utf8"
    );
  } catch {}
}

// 注意：async（tsc 作用域检查是异步子进程），调用处必须 await
async function validateComponentCode(name, code, isScene, requiredFonts, allowMedia = false, allowedAssetFiles = [], subtitles = true) {
  const errors = [];
  if (code.length < 400) return [`文件 ${name} 内容过短（${code.length} 字节），不是完整组件`];
  if (!/\bexport\s+default\b/.test(code)) errors.push(`文件 ${name} 缺少 export default`);
  if (isScene && subtitles && !/subtitle/.test(code)) errors.push(`场景文件 ${name} 必须使用 subtitle 属性渲染字幕`);
  // 关闭字幕时反过来查：把函数签名的固定部分剥掉后，正文里不该再出现 subtitle
  if (isScene && !subtitles) {
    const body = code.replace(/export\s+default\s+function[^{]*\(\s*\{\s*subtitle\s*\}\s*:\s*\{[^}]*\}\s*\)[^{]*\{/, "");
    if (/\bsubtitle\b/.test(body)) {
      errors.push(`文件 ${name} 在「关闭字幕」模式下不得渲染 subtitle 文本（本次不生成字幕）：请删掉所有使用 subtitle 的元素，只保留画面`);
    }
  }
  if (/<Audio/.test(code)) errors.push(`文件 ${name} 不得使用 <Audio>（配音由全局层处理）`);
  const importRe = /import\s+[^;]*?\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = importRe.exec(code)) !== null) {
    if (m[1] !== "react" && m[1] !== "remotion") errors.push(`文件 ${name} 只能 import react/remotion，发现: ${m[1]}`);
  }
  if (/\brequire\s*\(/.test(code)) errors.push(`文件 ${name} 不得使用 require`);
  // 静态检查：remotion API 必须真正从 remotion 导入（AI 常漏写 import 头，esbuild 不报运行时 ReferenceError）
  const remImport = code.match(/import\s+([^;]*?)\s+from\s+["']remotion["']/);
  const importedRem = new Set(
    remImport
      ? remImport[1].replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean)
      : []
  );
  const REMOTION_APIS = ["AbsoluteFill", "useCurrentFrame", "useVideoConfig", "interpolate", "spring", "Sequence", "Easing", "Audio", "Img", "OffthreadVideo", "staticFile", "delayRender", "continueRender", "CancelRender", "prefetch"];
  // 直用模式下 Img / OffthreadVideo / staticFile 是允许的（素材直接进画面）
  const MEDIA_APIS = ["Img", "OffthreadVideo", "staticFile"];
  for (const api of REMOTION_APIS) {
    if (allowMedia && MEDIA_APIS.includes(api)) continue;
    if (new RegExp("\\b" + api + "\\b").test(code) && !importedRem.has(api)) {
      errors.push(`文件 ${name} 使用了 ${api} 但未从 remotion 导入（运行时会 ReferenceError）`);
    }
  }
  // 静态检查：interpolate 的纯数字字面量 inputRange 必须严格递增（Remotion 运行时约束）
  const interpRe = /interpolate\s*\(\s*[^,]+,\s*\[((?:\s*-?\d+(?:\.\d+)?\s*(?:,\s*-?\d+(?:\.\d+)?\s*)*)?)\]/g;
  let im;
  while ((im = interpRe.exec(code)) !== null) {
    const nums = im[1].split(",").map((s) => parseFloat(s.trim())).filter((n) => !Number.isNaN(n));
    for (let k = 1; k < nums.length; k++) {
      if (!(nums[k] > nums[k - 1])) {
        errors.push(`文件 ${name} interpolate inputRange [${nums.join(",")}] 必须严格递增`);
        break;
      }
    }
  }
  for (const bad of ["Math.random", "Date.now", "performance.now", "fetch(", "localStorage", ...(allowMedia ? [] : ["staticFile"])]) {
    if (code.includes(bad)) errors.push(`文件 ${name} 含禁止 API: ${bad}`);
  }
  // 直用模式下还必须真的用上素材（否则就是没按用户的意思做）
  if (allowMedia) {
    // 服务端逐帧渲染不支持 SVG foreignObject —— 里面的图片会整块消失（预览可见、导出没有）
    if (/foreignObject/i.test(code)) {
      errors.push(`文件 ${name} 使用了 <foreignObject>（服务端渲染不支持，素材会消失）：请把 <Img>/<OffthreadVideo> 作为普通 HTML 元素直接放在 AbsoluteFill 里，用绝对定位构图`);
    }
    if (!/staticFile\s*\(\s*["'`]assets\//.test(code)) {
      errors.push(`文件 ${name} 在「直接使用素材」模式下未引用 public/assets/ 下的素材（必须用 staticFile("assets/…") 调用 <Img> 或 <OffthreadVideo>）`);
    }
    // 引用不存在的素材文件会在渲染时 404
    if (allowedAssetFiles && allowedAssetFiles.length) {
      const refs = [...code.matchAll(/staticFile\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
      for (const r of refs) {
        const base = r.replace(/^assets\//, "");
        if (!allowedAssetFiles.includes(base)) {
          errors.push(`文件 ${name} 引用了不存在的素材 "${base}"（可用：${allowedAssetFiles.join(", ")}）`);
        }
      }
    }
  }
  // 字体硬校验：场景代码必须使用风格包指定字体（Backdrop 不强制文字，不校验）
  if (isScene && requiredFonts && requiredFonts.length) {
    const hit = requiredFonts.some((f) => code.includes(f));
    if (!hit) {
      errors.push(`文件 ${name} 未使用风格包指定字体：fontFamily 须包含 ${requiredFonts.slice(0, 5).join(" / ")} 中至少一个字体名`);
    }
  }
  // 静态检查：remotion hooks 必须真的被调用。AI 常写 `const {fps} = useVideoConfig;`（少括号），
  // 解构函数对象得到 undefined，渲染到该场景时报 inputRange NaN 才暴露。
  const codeNoImports = code.replace(/import[\s\S]*?from\s*["'][^"']+["']/g, "");
  for (const hook of ["useVideoConfig", "useCurrentFrame"]) {
    const useRe = new RegExp("\\b" + hook + "\\b(?!\\s*\\()");
    if (useRe.test(codeNoImports)) {
      errors.push(`文件 ${name} 使用了 ${hook} 但未加括号调用（必须 ${hook}()，否则解构出 undefined，渲染时报 NaN）`);
    }
  }
  errors.push(...easingWhitelistErrors(name, code));
  errors.push(...springMissingFpsErrors(name, code));
  try {
    esbuild.transformSync(code, { loader: "tsx" });
  } catch (e) {
    return [...errors, `文件 ${name} TSX 语法错误: ${String(e.message).split("\n")[0]}`]; // 语法都不过，无需 tsc
  }
  errors.push(...(await tscUndefinedErrors(name, code)));
  return errors;
}

// ============================================================
//  时间轴
// ============================================================
function computeTimeline(scenes) {
  let cursor = 0;
  return scenes.map((scene, i) => {
    const from = i === 0 ? 0 : cursor - (scenes[i - 1].overlap || 0);
    cursor = from + scene.durationInFrames;
    return { name: scene.name, from, durationInFrames: scene.durationInFrames };
  });
}

// ============================================================
//  阶段 1：规划
// ============================================================
async function planScenes(apiKey, prompt, direction, targetFrames = 0) {
  let lastErrors = [];
  const MAX_ATTEMPTS = Number(process.env.PLAN_ATTEMPTS) || 2;
  // 用户指定了总时长时分镜时长由对齐逻辑精确落位，校验区间放宽到可行范围
  const durRange = targetFrames
    ? { min: MIN_SCENE_FRAMES, max: MAX_SCENE_FRAMES }
    : { min: 60, max: 240 };
  let attempt = 0;
  let netRetry = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    const feedback = lastErrors.length
      ? `\n\n【上一轮 JSON 的问题——必须修复】\n${lastErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")}\n请重新输出完整 JSON。`
      : "";
    const userMessage = `【产品描述】\n${prompt}\n\n${direction}${feedback}`;
    const t0 = Date.now();
    let content;
    try {
      content = await callLLM(apiKey, plannerPrompt(targetFrames), userMessage, 8192, 0.9);
    } catch (e) {
      // 网络类失败不计入规划尝试次数，等链路恢复后重试
      if (isConnectFailure(e) && netRetry < NET_RETRY_LIMIT) {
        netRetry++;
        console.error(`  [net] 规划 AI 调用遇网络故障，${NET_RETRY_WAIT_MS / 1000}s 后重试（不占用规划配额 ${netRetry}/${NET_RETRY_LIMIT}）: ${explainLLMError(e)}`);
        await new Promise((r) => setTimeout(r, NET_RETRY_WAIT_MS));
        attempt--;
        continue;
      }
      const label = attempt < MAX_ATTEMPTS ? `将重试 ${attempt}/${MAX_ATTEMPTS}` : `已重试 ${MAX_ATTEMPTS} 次仍失败`;
      lastErrors = [`规划 AI 调用失败（${label}）: ${explainLLMError(e)}`];
      if (isConnectFailure(e)) lastErrors.push("这是网络 / VPN / 代理问题，不是分镜内容问题；恢复网络后直接重跑即可。");
      console.error(`[codegen] 规划调用异常 (${((Date.now() - t0) / 1000).toFixed(0)}s): ${lastErrors[0]}`);
      continue;
    }
    console.error(`[codegen] 规划调用返回 (${((Date.now() - t0) / 1000).toFixed(0)}s, ${content.length} 字符)`);
    const manifest = extractJson(content);
    if (!manifest) {
      lastErrors = ["输出无法解析为 JSON 对象"];
      continue;
    }
    // 先修复再校验（名字归一化、voice 重建等确定性处理）
    const repaired = repairManifest(manifest);
    // 用户指定了总时长 → 把分镜时长精确缩放到目标帧数（AI 给的时长只当比例用）
    let fit = null;
    if (targetFrames) {
      fit = fitManifestToDuration(repaired, targetFrames);
      if (fit) {
        console.error(
          `[codegen] 时长对齐: 目标 ${(fit.targetFrames / FPS).toFixed(1)}s(${fit.targetFrames}帧) → ` +
            `实际 ${(fit.actualFrames / FPS).toFixed(1)}s(${fit.actualFrames}帧) · ${fit.scenes} 分镜` +
            (fit.exact ? "（精确命中）" : "（受分镜帧数上下限约束，已贴近目标）")
        );
      }
    }
    lastErrors = validateManifest(repaired, durRange);
    if (lastErrors.length === 0) {
      console.error(`[codegen] 规划通过: ${repaired.scenes.length} 场景 / ${repaired.scenes.map((s) => s.name).join(", ")}`);
      return repaired;
    }
    console.error(`[codegen] 规划未通过: ${lastErrors.join("; ").slice(0, 200)}`);
  }
  throw new Error(`分镜规划未通过校验:\n  ${lastErrors.join("\n  ")}`);
}

// ============================================================
//  阶段 2：逐组件生成（并发受限 + 单组件重试）
// ============================================================
function sceneRole(i, n) {
  if (i === 0) return "开场分镜（点题，先声夺人）";
  if (i === n - 1) return "收尾分镜（点出品牌/主张，情绪收束）";
  return `中段分镜（第 ${i + 1}/${n} 个，信息密度要高，讲一个具体卖点）`;
}

async function generateComponent(apiKey, { direction, manifest, timeline, totalFrames, kind, sceneIndex, layoutCards, requiredFonts, extraFeedback, allowMedia = false, assetFiles = [], subtitles = true, onProgress }) {
  const isBackdrop = kind === "backdrop";
  // 直用模式：组件可以引用工程 public/assets/ 里的真实素材（默认契约禁止外部资源，这里开口子）
  const MEDIA_CLAUSE = allowMedia
    ? `\n\n## 本次额外许可：使用真实素材\n（上面第 5 条「只能 import react/remotion、不得使用图片」在此放宽）\n- 允许额外 import 并使用：Img（图片）、OffthreadVideo（视频）、staticFile（读取 public/ 下的文件）。\n- 素材文件都已放在工程 public/assets/ 下，必须写成 \`staticFile("assets/<文件名>")\`；文件名只能取自【用户提供的素材】里列出的那些，绝不得编造。\n- 除上述三个 API 外，仍然只能 import "react" 与 "remotion"。\n- 素材要保持原始宽高比（objectFit: "cover" 或 "contain"），不得拉伸变形。\n- 【结构硬规则】<Img> / <OffthreadVideo> 必须作为普通 HTML 元素直接放在 AbsoluteFill 里（position: absolute + left/top/width/height 构图），**严禁放进 SVG 的 <foreignObject>**——服务端逐帧渲染不支持 foreignObject，图片会整块消失（预览可见但导出没有，属于最恶劣的不一致）。\n- 想给素材加边框、遮罩、装饰，就在同一个 AbsoluteFill 里另放一层 SVG（绝对定位铺满）叠在素材上方。`
    : "";
  const systemPrompt = (isBackdrop ? BACKDROP_PROMPT : COMPONENT_PROMPT) + MEDIA_CLAUSE + (isBackdrop || subtitles ? "" : NO_SUBTITLE_CLAUSE);
  const scenes = manifest.scenes;
  const scene = isBackdrop ? null : scenes[sceneIndex];
  const fileName = isBackdrop ? "Backdrop.tsx" : scene.file;
  // 组件在工程里的落盘位置（决定 import safeInterp 的相对层级）：
  // src/scenes/Scene1.tsx → "../safeInterp"，src/Backdrop.tsx → "./safeInterp"
  const outPath = isBackdrop ? "src/Backdrop.tsx" : `src/scenes/${scene.file}`;
  const roster = scenes.map((s, i) => `${i + 1}. ${s.name} —「${s.subtitle}」`).join("\n");

  let lastErrors = extraFeedback ? [extraFeedback] : [];
  let code = "";
  const MAX_ATTEMPTS = Number(process.env.COMPONENT_ATTEMPTS) || 3;
  let attempt = 0;
  let netRetry = 0;
  // 本次调用的思考档位。默认 **minimal**（不是全局的 low）：
  // 实测本网关 low 档写组件会先输出一万多字思考（约 100s），必然撞上思考看门狗被掐断，
  // 再切 minimal 重跑 —— 等于每个组件都白烧一整轮，一次生成要多花好几分钟。
  // 而且最终通过校验的代码本来就是 minimal 产的那版，直接用它并不掉质量。
  // 想让模型多思考再写（更慢、更贵）就设 LLM_COMPONENT_EFFORT=low。
  let effort = process.env.LLM_COMPONENT_EFFORT || "minimal";
  // 单个组件的一次调用可能要跑几分钟，期间让前端每 2 秒看到「思考中 / 已写 N 字符」，
  // 否则用户面对的是一个几分钟不动的进度条。
  let written = 0; // 正文（代码）字符数
  let thought = 0; // 思考字符数（网关会单独下发 reasoning_content）
  let lastEmitAt = 0;
  const onDelta =
    typeof onProgress === "function"
      ? (text, isReasoning) => {
          if (isReasoning) thought += text.length;
          else written += text.length;
          const now = Date.now();
          if (now - lastEmitAt >= 2000) {
            lastEmitAt = now;
            onProgress(fileName, written, thought);
          }
        }
      : null;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    written = 0;
    thought = 0;
    const feedback = lastErrors.length
      ? `\n\n【上一轮代码的问题——必须全部修复】\n${lastErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")}\n请重新输出完整文件（保持创意方向与构图不变，只修复问题）。`
      : "";
    const spec = isBackdrop
      ? `你要编写的是全局环境背景组件 Backdrop.tsx。\n\n【全片分镜脚本（供你把握整体氛围，背景不得抢戏）】\n${roster}\n全片共 ${totalFrames} 帧（${(totalFrames / FPS).toFixed(1)} 秒）。`
      : `你要编写的是分镜组件 ${scene.file}。\n\n【本分镜信息】\n- 场景名: ${scene.name}\n- 字幕（必须逐字渲染）: ${scene.subtitle}\n- 分镜时长: ${scene.durationInFrames} 帧（约 ${(scene.durationInFrames / FPS).toFixed(1)} 秒）\n- 角色定位: ${sceneRole(sceneIndex, scenes.length)}\n- 布局卡（本分镜必须采用此构图，与其他分镜明显不同）: ${layoutCards[sceneIndex % layoutCards.length]}\n\n【全片分镜脚本（你必须与其他分镜构图明显不同）】\n${roster}`;
    const userMessage = `【创意方向简报】\n${direction}\n\n${spec}${feedback}`;
    const maxTokens = 65536;
    const t0 = Date.now();
    let raw;
    try {
      raw = await callLLM(apiKey, systemPrompt, userMessage, maxTokens, 0.9, onDelta, effort, MAX_THINKING_CHARS);
    } catch (e) {
      // 思考看门狗掐断：换最省思考的档位立刻重试，且不占用「代码不合格」的校验配额
      if (/思考过长/.test(String(e && e.message)) && effort !== "minimal") {
        effort = "minimal";
        console.error(`  [net] ${fileName} 思考失控，已切到 minimal 档重试（不占用校验配额）`);
        attempt--;
        continue;
      }
      // 网络类失败单独等待重试，不占用"代码不合格"的校验配额（链路抖动时别把机会吃光）
      if (isConnectFailure(e) && netRetry < NET_RETRY_LIMIT) {
        netRetry++;
        console.error(
          `  [net] ${fileName} AI 调用遇网络故障，${NET_RETRY_WAIT_MS / 1000}s 后重试` +
            `（不占用校验重试配额 ${netRetry}/${NET_RETRY_LIMIT}）: ${explainLLMError(e)}`
        );
        await new Promise((r) => setTimeout(r, NET_RETRY_WAIT_MS));
        attempt--; // 归还校验配额
        continue;
      }
      lastErrors = [`AI 调用失败（${attempt < MAX_ATTEMPTS ? "将重试" : "已重试仍失败"}）: ${explainLLMError(e)}`];
      console.error(`[codegen] ${fileName} 尝试${attempt} 调用异常 (${((Date.now() - t0) / 1000).toFixed(0)}s): ${lastErrors[0]}`);
      if (attempt >= MAX_ATTEMPTS) dumpFailure(fileName, attempt, "", lastErrors);
      continue;
    }
    // 先做确定性修复（补漏写的 remotion import），再校验
    code = repairComponentImports(fileName, stripFences(raw) + "\n").code;
    // 纯字面量的非递增 inputRange 就地修好（省掉一次 AI 重试）
    const sq = squeezeLiteralInputRanges(code);
    if (sq.fixed) {
      console.error(`  [repair] ${fileName} 修正了 ${sq.fixed} 处非递增 inputRange（字面量挤压）`);
      code = sq.code;
    }
    lastErrors = await validateComponentCode(fileName, code, !isBackdrop, requiredFonts, allowMedia, assetFiles, subtitles);
    const dt = ((Date.now() - t0) / 1000).toFixed(0);
    if (lastErrors.length === 0) {
      // 校验通过后再改走安全包装：变量参与、静态看不出来的非递增区间由运行期兜底
      // 注意 changed 而非 moved：合并重复 import / 纠正 safeInterp 路径也会改内容，
      // 只看 moved 会把这些改动丢掉（尤其是自愈历史坏形态的那次清理）
      const routed = routeInterpolateToSafe(outPath, code);
      if (routed.changed) {
        if (routed.moved.length) console.error(`  [repair] ${fileName} interpolate → safeInterp（运行期兜底非递增区间）`);
        code = routed.code;
      }
      console.error(`[codegen] ${fileName} 尝试${attempt} 通过 (${dt}s, ${code.split("\n").length} 行)`);
      return code;
    }
    console.error(`[codegen] ${fileName} 尝试${attempt} 未通过 (${dt}s): ${lastErrors.join("; ").slice(0, 200)}`);
    dumpFailure(fileName, attempt, code, lastErrors);
  }
  throw new Error(`${fileName} 生成未通过校验:\n  ${lastErrors.join("\n  ")}`);
}

async function runPool(jobs, concurrency) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await jobs[i]() };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

// 背景层兜底：Backdrop 只是氛围层，不承载叙事，因此它生成失败时用它顶上，
// 而不是让整次生成报错。用风格包自己的底色，保证与画面调性一致。
// 刻意只用 AbsoluteFill + useCurrentFrame 两个 API、不碰 interpolate/字体/外部资源，
// 这样它不可能触发任何校验或运行时问题。
function fallbackBackdrop(pack) {
  const p = (pack && pack.palette) || { bg: "#0f1116", bg2: "#191d26", accent: "#8b7cf0" };
  return `import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

// 兜底背景层：AI 生成背景失败时的保底版本（渐变 + 缓慢呼吸的柔光），不抢戏。
export default function Backdrop() {
  const frame = useCurrentFrame();
  const t = (frame % 300) / 300;
  const breathe = 0.28 + 0.18 * Math.sin(t * Math.PI * 2);
  const x = 34 + Math.sin(t * Math.PI * 2) * 12;
  const y = 26 + Math.cos(t * Math.PI * 2) * 8;
  return (
    <AbsoluteFill style={{ backgroundColor: "${p.bg}" }}>
      <AbsoluteFill
        style={{
          background: "radial-gradient(120% 90% at 50% 32%, ${p.bg2} 0%, ${p.bg} 72%)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(42% 42% at " + x + "% " + y + "%, ${p.accent} 0%, rgba(0,0,0,0) 70%)",
          opacity: breathe,
        }}
      />
    </AbsoluteFill>
  );
}
`;
}

// ============================================================
//  工程组装（胶水仅做接线；视觉全部来自 AI 原创组件）
// ============================================================
function filmGlue(sceneFiles) {
  const imports = sceneFiles
    .map((f, i) => `import SceneC${i} from "./scenes/${f.replace(/\.tsx$/, "")}";`)
    .join("\n");
  const list = sceneFiles.map((_, i) => `SceneC${i}`).join(", ");
  return `import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate } from "./safeInterp";
import config from "./config.json";
import Backdrop from "./Backdrop";
${imports}

const SCENE_COMPONENTS = [${list}];

function computeTimeline(scenes: any[]) {
  let cursor = 0;
  return scenes.map((s: any, i: number) => {
    const from = i === 0 ? 0 : cursor - (scenes[i - 1].overlap || 0);
    cursor = from + s.durationInFrames;
    return { name: s.name, from, durationInFrames: s.durationInFrames };
  });
}

// 单句配音：进出各做一次短淡入淡出，避免句首尾的爆音。
function VoiceClip({ src, from, duration }: { src: string; from: number; duration: number }) {
  const frame = useCurrentFrame();
  const local = frame - from;
  const fade = Math.max(3, Math.min(10, Math.floor(duration / 4)));
  const volume = interpolate(
    local,
    [0, fade, Math.max(fade + 1, duration - fade), duration],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return (
    <Sequence from={from} durationInFrames={duration} name={"voice-" + src}>
      <Audio src={staticFile("voice/" + src)} volume={volume} />
    </Sequence>
  );
}

// 背景音乐闪避：说话时把音乐压下去，说完再抬回来（前后各留一段渐变，避免抽气感）。
const BGM_LEAD = 8;
const BGM_TAIL = 14;

function speakingFactor(frame: number, intervals: { from: number; to: number }[]) {
  let best = 0;
  for (const iv of intervals) {
    const a = iv.from - BGM_LEAD;
    const b = iv.to + BGM_TAIL;
    if (frame <= a || frame >= b) continue;
    const up = interpolate(frame, [a, iv.from], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const down = interpolate(frame, [iv.to, b], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const v = Math.min(up, down);
    if (v > best) best = v;
  }
  return best;
}

export const Film: React.FC = () => {
  const timeline = computeTimeline(config.scenes);
  const { durationInFrames: totalFrames } = useVideoConfig();
  const voiceCfg: any = (config as any).voice || {};
  const tracks: any[] = voiceCfg.enabled ? voiceCfg.tracks || [] : [];
  const bgm: any = voiceCfg.bgm || null;
  const intervals = tracks.map((t: any) => ({ from: t.from, to: t.from + t.duration }));

  return (
    <AbsoluteFill style={{ background: "#000", overflow: "hidden" }}>
      <Backdrop />
      {timeline.map((t: any, i: number) => (
        <Sequence key={t.name} from={t.from} durationInFrames={t.durationInFrames} name={t.name}>
          {React.createElement(SCENE_COMPONENTS[i], { subtitle: config.scenes[i].subtitle })}
        </Sequence>
      ))}
      {bgm ? (
        <Audio
          src={staticFile("voice/" + bgm.file)}
          volume={(f: number) => {
            // 基底音量；说话时压到 duck 档
            const base = Number(bgm.volume) || 0.22;
            const duck = Number(bgm.duck) || 0.07;
            const speak = speakingFactor(f, intervals);
            // 全片首尾各做一次整体淡入淡出，收尾不突兀
            const head = interpolate(f, [0, 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const tail = interpolate(f, [Math.max(1, totalFrames - 50), totalFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (base + (duck - base) * speak) * head * tail;
          }}
        />
      ) : null}
      {tracks.map((v: any, i: number) => (
        <VoiceClip key={i + "-" + v.file} src={v.file} from={v.from} duration={v.duration} />
      ))}
    </AbsoluteFill>
  );
};
`;
}

function rootGlue(id, totalFrames) {
  return `import React from "react";
import { Composition } from "remotion";
import { Film } from "./Film";

export const RemotionRoot: React.FC = () => (
  <Composition id="${id}" component={Film} durationInFrames={${totalFrames}} fps={${FPS}} width={${WIDTH}} height={${HEIGHT}} />
);
`;
}

function assembleProject(outAbs, projectName, manifest, files, totalFrames, timeline, extra = {}) {
  const sceneFiles = manifest.scenes.map((s) => s.file);
  const tl = timeline && timeline.length === manifest.scenes.length ? timeline : computeTimeline(manifest.scenes);
  // 配音轨（逐句）：from/duration 已是绝对帧号，由 applyVoicePlan 算好；预览与导出共用
  const voiceCfg = {
    enabled: Boolean(manifest.voice && manifest.voice.enabled),
    provider: (manifest.voice && manifest.voice.provider) || "none",
    voiceName: (manifest.voice && manifest.voice.voiceName) || "",
    voiceReason: (manifest.voice && manifest.voice.voiceReason) || "",
    bgm: (manifest.voice && manifest.voice.bgm) || null,
    tracks: (manifest.voice && manifest.voice.tracks) || [],
  };

  const out = {};
  // 兜底收口：不管组件来自本轮生成还是检查点复用，落盘前都把重复 import 归一化。
  // 重复导入（尤以 interpolate 从 safeInterp 与 remotion 各来一份为典型）会让
  // vite/babel 报 "Identifier 'x' has already been declared"，整个预览页打不开。
  const cleanComponent = (label, code) => {
    const d = dedupeImports(code);
    if (d.merged.length) console.error(`  [repair] ${label} 装配时合并重复 import（${d.merged.join(" / ")}）`);
    const s = dropShadowedApiDeclarations(label, d.code);
    return s.removed.length ? s.code : d.code;
  };
  for (const f of sceneFiles) out[`src/scenes/${f}`] = cleanComponent(f, files[f]);
  out["src/Backdrop.tsx"] = cleanComponent("Backdrop.tsx", files["Backdrop.tsx"]);
  out["src/safeInterp.ts"] = SAFE_INTERP_MODULE;
  out["src/Film.tsx"] = filmGlue(sceneFiles);
  out["src/Root.tsx"] = rootGlue(manifest.id, totalFrames);
  out["src/index.ts"] = `import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";
registerRoot(RemotionRoot);
`;
  const configJson = {
    id: manifest.id,
    title: manifest.title,
    scenes: manifest.scenes.map((s) => ({
      name: s.name,
      durationInFrames: s.durationInFrames,
      overlap: s.overlap,
      subtitle: s.subtitle,
    })),
    voice: voiceCfg,
  };
  out["src/config.json"] = JSON.stringify(configJson, null, 2) + "\n";
  out["film.config.json"] =
    JSON.stringify(
      { ...configJson, style: "ai-codegen", styleTags: manifest.styleTags || [], stylePack: extra.stylePack || "", assets: extra.assets || [] },
      null,
      2
    ) + "\n";
  // preview.json — 供 Web 端「浏览器内预览」直接消费（时间轴 + 组件文件 + 配音轨），
  // 与 Film.tsx 的胶水逻辑完全一致，预览与最终渲染同一份组件代码，所见即所得。
  out["preview.json"] = JSON.stringify(
    {
      version: 1,
      projectName,
      compositionId: manifest.id,
      title: manifest.title,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      totalFrames,
      styleTags: manifest.styleTags || [],
      // 本次用的风格包 id：点「参考这个工程」时按它复用整套设计令牌
      stylePack: extra.stylePack || "",
      // 本工程用到的用户素材（直用模式下组件会引用 public/assets/ 里的这些文件）
      assets: extra.assets || [],
      backdrop: "Backdrop.tsx",
      // 字幕开关：关闭时场景组件不渲染 subtitle（但仍接收它作为配音文案）
      subtitles: extra.subtitles !== false,
      scenes: manifest.scenes.map((s, i) => ({
        name: s.name,
        file: s.file,
        subtitle: s.subtitle,
        from: tl[i].from,
        durationInFrames: tl[i].durationInFrames,
      })),
      // 配音与配乐：与 Film.tsx 胶水、预览播放器共用的同一份时间轴
      voice: voiceCfg,
    },
    null,
    2
  ) + "\n";
  out["package.json"] = JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: {
        studio: "remotion studio src/index.ts",
        render: `remotion render src/index.ts ${manifest.id} out/film.mp4`,
      },
      dependencies: {
        "@remotion/player": "4.0.526",
        react: "19.1.1",
        "react-dom": "19.1.1",
        remotion: "4.0.526",
        zod: "4.1.5",
      },
      devDependencies: {
        "@remotion/cli": "4.0.526",
        "@types/react": "19.1.13",
        "@types/react-dom": "19.1.9",
        typescript: "5.9.2",
      },
    },
    null,
    2
  ) + "\n";
  out["tsconfig.json"] = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": false,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src", "remotion.config.ts"]
}
`;
  out["remotion.config.ts"] = `import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setConcurrency(8);
`;
  // 配音音频由 voiceKit 直接合成到 public/voice/（不再需要 powershell 脚本中转）
  if (voiceCfg.enabled) out["public/voice/.gitkeep"] = "";
  out["README.md"] = `# ${manifest.title}

AI 原创生成的 Remotion 宣传片（ai-codegen，无模板）。

- Composition: \`${manifest.id}\`（${totalFrames} 帧 / ${(totalFrames / FPS).toFixed(1)}s / ${FPS}fps / ${WIDTH}x${HEIGHT}）
- 分镜组件: \`src/scenes/*.tsx\`（AI 逐场景原创）
- 环境背景: \`src/Backdrop.tsx\`（AI 原创）
- 风格方向: ${(manifest.styleTags || []).join(", ")}

## 渲染

\`\`\`bash
npx remotion render src/index.ts ${manifest.id} out/film.mp4
\`\`\`
`;

  for (const [rel, content] of Object.entries(out)) {
    const fullPath = path.join(outAbs, rel);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf-8");
  }

  // 自动链接根工程依赖（junction 不需要管理员权限）
  const nm = path.join(outAbs, "node_modules");
  if (!fs.existsSync(nm)) {
    try {
      fs.symlinkSync(path.join(ROOT, "node_modules"), nm, "junction");
    } catch (e) {
      console.error("junction 创建失败（可手动 mklink）:", e.message);
    }
  }
  return Object.keys(out).length;
}

// ============================================================
//  阶段 3：装配后语音生成 + 运行时冒烟（每场景真实渲染 1 帧 + 末帧）
//  静态校验抓不住的运行时错误（NaN 插值、空值访问、特定帧才触发的计算）
//  在生成阶段就暴露并带错误重生成，避免渲染数分钟后才炸。
// ============================================================
/**
 * 真正把音频文件落盘：
 *   1) 逐句神经语音（或 SAPI 兜底）→ public/voice/
 *   2) 可选程序化配乐 → public/voice/bgm.wav
 * 返回 { synth, bgm }，由调用方交给 applyVoicePlan 换算成帧时间轴。
 */
async function synthesizeVoiceFiles(outAbs, plan, { withVoice: wantVoice = true, withBgm, totalFrames, onStage }) {
  const voiceDir = path.join(outAbs, "public", "voice");
  fs.mkdirSync(voiceDir, { recursive: true });
  // 把方案留在工程里：导出阶段发现音频缺失时可以照它重合成一遍（自愈）
  try {
    fs.writeFileSync(
      path.join(outAbs, "voice.plan.json"),
      JSON.stringify({ version: 1, withVoice: Boolean(wantVoice), withBgm: Boolean(withBgm), plan }, null, 2) + "\n",
      "utf8"
    );
  } catch (e) {
    console.error(`[codegen] voice.plan.json 写入失败: ${errLine(e)}`);
  }
  const emit = (s) => {
    try {
      if (onStage) onStage(s);
    } catch {}
  };

  // 只要配乐不要配音时跳过 TTS：不然会白跑十几次语音合成、还在 public/voice/ 留下一堆孤儿音频
  let synth = { ok: false, error: "本次未启用配音" };
  if (wantVoice) {
    emit({ stage: "voice", status: "start" });
    const t0 = Date.now();
    synth = await voiceKit.synthesizeVoiceover(plan, voiceDir);
    if (synth.ok) {
      console.error(`[codegen] 配音合成完成 ${synth.files.length} 句（${synth.provider}, ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
      emit({ stage: "voice", status: "done", count: synth.files.length, provider: synth.provider });
    } else {
      console.error(`[codegen] 配音合成失败: ${synth.error}`);
      emit({ stage: "voice", status: "fail", error: synth.error });
    }
  }

  let bgm = null;
  if (withBgm && plan.music) {
    emit({ stage: "bgm", status: "start" });
    try {
      const seconds = Math.max(4, totalFrames / FPS);
      const info = voiceKit.synthesizeBgm(path.join(voiceDir, "bgm.wav"), {
        mood: plan.music.mood,
        intensity: plan.music.intensity,
        durationSec: seconds,
      });
      // 配乐已经峰值归一化到 -1dB，所以这里可以直接按「相对旁白的听感」给绝对音量。
      // 有配音时音乐压到约 -16dB（实测旁白 RMS≈0.06，音乐 RMS 目标≈0.009）；
      // 说话时再闪避约 -9dB，说完抬回。纯配乐片可以给得响一些。
      const hasVoice = Boolean(synth.ok && synth.files.length);
      bgm = {
        file: info.file,
        mood: info.mood,
        bpm: info.bpm,
        volume: hasVoice ? 0.09 : 0.4,
        duck: hasVoice ? 0.032 : 0.4,
      };
      console.error(
        `[codegen] 配乐合成完成 ${info.mood} / ${info.bpm}bpm / ${info.bars}小节（${(info.bytes / 1024 / 1024).toFixed(1)}MB, ${info.ms}ms）`
      );
      emit({ stage: "bgm", status: "done", mood: info.mood });
    } catch (e) {
      console.error(`[codegen] 配乐合成失败: ${errLine(e)}`);
      emit({ stage: "bgm", status: "fail", error: errLine(e) });
    }
  }
  return { synth, bgm };
}

async function smokeTestProject(outAbs, manifest, timeline) {
  const { bundle } = require("@remotion/bundler");
  const { selectComposition, renderStill } = require("@remotion/renderer");
  const t0 = Date.now();
  const serveUrl = await bundle({ entryPoint: path.join(outAbs, "src", "index.ts"), publicDir: path.join(outAbs, "public") });
  console.error(`[codegen] 冒烟打包完成 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const comp = await selectComposition({ serveUrl, id: manifest.id, inputProps: {} });
  const smokeDir = path.join(outAbs, "out");
  fs.mkdirSync(smokeDir, { recursive: true });
  const failures = [];
  // 每场景渲染起始+8 帧（让入场动画跑起来，暴露帧中段才触发的运行时错误）
  for (let i = 0; i < manifest.scenes.length; i++) {
    const tl = timeline[i];
    const frame = tl.from + Math.min(8, Math.max(0, tl.durationInFrames - 1));
    try {
      await renderStill({ serveUrl, composition: comp, frame, output: path.join(smokeDir, `__smoke_${i}.png`), imageFormat: "png", inputProps: {} });
      console.error(`[codegen] 冒烟 S${i} @${frame} ✓`);
    } catch (e) {
      const msg = String((e && e.message) || e).split("\n").slice(0, 4).join(" | ").slice(0, 400);
      console.error(`[codegen] 冒烟 S${i} @${frame} ✗ ${msg}`);
      failures.push({ sceneIndex: i, frame, error: msg });
    }
  }
  // 末帧（收尾退场动画常在末帧才触发错误）
  const last = comp.durationInFrames - 1;
  try {
    await renderStill({ serveUrl, composition: comp, frame: last, output: path.join(smokeDir, "__smoke_last.png"), imageFormat: "png", inputProps: {} });
    console.error(`[codegen] 冒烟 末帧 @${last} ✓`);
  } catch (e) {
    const msg = String((e && e.message) || e).split("\n").slice(0, 4).join(" | ").slice(0, 400);
    console.error(`[codegen] 冒烟 末帧 @${last} ✗ ${msg}`);
    failures.push({ sceneIndex: manifest.scenes.length - 1, frame: last, error: "片尾帧: " + msg });
  }
  return failures;
}

// ============================================================
//  素材可见性实测（直用模式）
//  静态校验只能证明"代码里写了 staticFile("assets/…")"，证明不了"画面里真的看得见"：
//  素材可能被整层盖住、透明度为 0、尺寸为 0、被移出画面、或塞进 SVG foreignObject。
//  这里用一次真实渲染来证明：把素材换成全透明占位图再渲同一帧，
//  两帧的像素差就是素材对画面的实际贡献。差为 0 = 用户什么都看不到。
// ============================================================
const BLANK_ASSET = "__blank.png";
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const ASSET_REF_RE = /(staticFile\s*\(\s*["'`])assets\/[^"'`]+(["'`]\s*\))/g;
// 带 g 的正则 .test() 是有状态的：每命中一次就推进 lastIndex，下一次从上次位置往后找。
// 用它去 filter 多个文件时，素材引用写得靠前的文件会被漏掉 —— 那个场景就不会被换成空白图，
// 渲染比对的两张图完全相同，于是报出"素材 0% 可见"的假阴性（真踩过：Scene2 明明画得出来却被判不可见）。
// 所以判断"这份文件有没有引用素材"必须用不带 g 的副本。
const ASSET_REF_TEST_RE = /staticFile\s*\(\s*["'`]assets\//;

function decodePng(buf) {
  let pos = 8;
  let w = 0;
  let h = 0;
  let bd = 0;
  let ct = 0;
  const idat = [];
  let plte = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
    } else if (type === "PLTE") {
      plte = data;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  const bpp = (ct === 6 ? 4 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 1) * (bd / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    if (rp + stride > raw.length) break;
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  if (ct === 3) {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const idx = out[i] * 3;
      rgba[i * 4] = (plte && plte[idx]) || 0;
      rgba[i * 4 + 1] = (plte && plte[idx + 1]) || 0;
      rgba[i * 4 + 2] = (plte && plte[idx + 2]) || 0;
      rgba[i * 4 + 3] = 255;
    }
    return { w, h, bpp: 4, data: rgba };
  }
  return { w, h, bpp, data: out };
}

function pixelDiffRatio(a, b) {
  if (a.w !== b.w || a.h !== b.h) return 1;
  const n = a.w * a.h;
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const o = i * a.bpp;
    if (
      Math.abs(a.data[o] - b.data[o]) +
        Math.abs(a.data[o + 1] - b.data[o + 1]) +
        Math.abs(a.data[o + 2] - b.data[o + 2]) >
      24
    ) {
      changed += 1;
    }
  }
  return changed / n;
}

/**
 * 素材可见性采样帧。
 * 不能只测分镜首帧：入场动画（spring / opacity 渐显）在首帧常常还是 opacity:0 或 width:0，
 * 拿首帧去比会得出"素材完全看不见"的假结论 —— Scene1 里的图就是被 spring 卡成 width:0。
 * 所以在分镜内部按 15% / 45% / 75% 取三个点，看素材「最好看的那一次」到底露没露。
 */
const PROBE_RATIOS = [0.15, 0.45, 0.75];
const sceneProbeFrames = (tlx, maxFrame) =>
  PROBE_RATIOS.map((r) =>
    Math.min(Math.max(0, tlx.from + Math.floor(tlx.durationInFrames * r)), tlx.from + tlx.durationInFrames - 1, maxFrame)
  );

/**
 * 逐分镜实测素材是否真的露出画面。
 * 返回 [{ sceneIndex, ratio, perFrame: [{frame, ratio}] }]；
 * ratio = 换掉素材后画面变化的像素占比（0~1），取该分镜采样点里的最大值。
 * 渲染环境不可用时返回 null（不阻断生成，但会打日志提醒）。
 */
async function measureAssetVisibility(outAbs, manifest, timeline) {
  const { bundle } = require("@remotion/bundler");
  const { selectComposition, renderStill } = require("@remotion/renderer");
  const sceneDir = path.join(outAbs, "src", "scenes");
  if (!fs.existsSync(sceneDir)) return null;
  // 只动真正引用了素材的场景文件
  const touched = fs
    .readdirSync(sceneDir)
    .filter((f) => f.endsWith(".tsx") && ASSET_REF_TEST_RE.test(fs.readFileSync(path.join(sceneDir, f), "utf8")))
    .map((f) => path.join(sceneDir, f));
  if (!touched.length) return [];
  const entry = path.join(outAbs, "src", "index.ts");
  const publicDir = path.join(outAbs, "public");
  const assetsDir = path.join(publicDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, BLANK_ASSET), BLANK_PNG);
  // 原文只放内存，不落 .blankbak 文件：落盘就得清理，而清理会撞环境的批量删除保护闸。
  // 备份必须在内存里，且还原只能用「内存里的原文」。若拿当前内容兜圈，
  // 第二遍 swap 会把空白版当成原文写回去，组件里真实素材的文件名就被永久抹掉了（真丢过一次）。
  const originals = new Map(touched.map((p) => [p, fs.readFileSync(p, "utf8")]));
  const backups = [...originals.keys()];
  // 进程被中断也要还原，否则工程里会残留 assets/__blank.png
  const onExit = () => {
    for (const [p, code] of originals) {
      try {
        fs.writeFileSync(p, code);
      } catch {}
    }
  };
  process.on("exit", onExit);
  const swap = (toBlank) => {
    for (const p of backups) {
      const original = originals.get(p);
      fs.writeFileSync(p, toBlank ? original.replace(ASSET_REF_RE, `$1assets/${BLANK_ASSET}$2`) : original);
    }
  };
  const outDir = path.join(outAbs, "out");
  fs.mkdirSync(path.join(outDir, ".vis"), { recursive: true });
  try {
    // 关掉 webpack 文件系统缓存（enableCaching 默认 true），确保两次打包真的各自编译一遍，
    // 不会出现"第二次复用第一次的产物、两次渲染的是同一份代码"的假阴性。
    //
    // 注意：绝对不要传 outDir。默认（不指定 outDir）时 Remotion 每次新建唯一临时目录，
    // publicDir 的内容会拷到包根目录，staticFile("assets/x") 解析成 /assets/x 才取得到；
    // 一旦指定 outDir，publicDir 会被拷到 <outDir>/public/ 下，/assets/x 直接 404，
    // 两个变体都渲染成空图，比对结果同样是假的 0%（真踩过）。
    const bundleVariant = () => bundle({ entryPoint: entry, publicDir, enableCaching: false });
    // 变体 B：素材换成全透明图
    swap(true);
    let serveUrl = await bundleVariant();
    const comp = await selectComposition({ serveUrl, id: manifest.id, inputProps: {} });
    // 采样帧必须落在真实 composition 范围内。内存里的 timeline 可能与 Root.tsx 实际装配的总帧数
    // 对不上（那份 film.config.json 就算出 265 帧，真实 composition 只有 240 帧），
    // 拿它算出来的帧号会直接越界、整个渲染比对作废。所以上限取两者的更小者。
    const lastTlx = timeline[timeline.length - 1];
    const maxFrame = Math.min(lastTlx.from + lastTlx.durationInFrames - 1, comp.durationInFrames - 1);
    const shots = [];
    manifest.scenes.forEach((_, i) => sceneProbeFrames(timeline[i], maxFrame).forEach((frame) => shots.push({ sceneIndex: i, frame })));
    const bPaths = [];
    for (let k = 0; k < shots.length; k++) {
      const p = path.join(outDir, ".vis", `b_${shots[k].sceneIndex}_${shots[k].frame}.png`);
      await renderStill({ serveUrl, composition: comp, frame: shots[k].frame, output: p, imageFormat: "png", inputProps: {} });
      bPaths.push(p);
    }
    // 变体 A：正常素材
    swap(false);
    serveUrl = await bundleVariant();
    const compA = await selectComposition({ serveUrl, id: manifest.id, inputProps: {} });
    const perScene = manifest.scenes.map(() => []);
    // 临时帧放在 .vis/ 里，不逐张删除（会撞环境的批量删除保护闸），下次运行直接覆盖
    for (let k = 0; k < shots.length; k++) {
      const p = path.join(outDir, ".vis", `a_${shots[k].sceneIndex}_${shots[k].frame}.png`);
      await renderStill({ serveUrl, composition: compA, frame: shots[k].frame, output: p, imageFormat: "png", inputProps: {} });
      const ratio = pixelDiffRatio(decodePng(fs.readFileSync(p)), decodePng(fs.readFileSync(bPaths[k])));
      perScene[shots[k].sceneIndex].push({ frame: shots[k].frame, ratio });
    }
    // 每个分镜取采样点里的最高值作为"素材最好看的一次"
    return perScene.map((list, sceneIndex) => ({
      sceneIndex,
      ratio: list.reduce((m, x) => Math.max(m, x.ratio), 0),
      perFrame: list,
    }));
  } finally {
    swap(false);
    // 进程退出时兜底还原（上面 swap(false) 在正常路径上已还原过，这里是保险）
    onExit();
    // 旧的 .blankbak 不再删除（环境保护闸），改成写"已作废"占位，避免被人当源码捡走
    for (const p of backups) {
      const b = `${p}.blankbak`;
      if (fs.existsSync(b)) fs.writeFileSync(b, `// 已作废：${path.basename(p)} 的原始内容已在运行内存中备份，此文件不再更新。\n`);
    }
  }
}


// ============================================================
//  主入口
// ============================================================
function uniqueDirName(base) {
  let name = base || "ai-film";
  let i = 2;
  while (fs.existsSync(path.join(ROOT, name))) {
    name = `${base}-${i}`;
    i += 1;
  }
  return name;
}

// ============================================================
//  断点续跑
//  规划结果（含当时的创意方向/风格包）与每个已通过的组件落盘；
//  重跑同一条产品描述时直接接着上次进度，已有组件不再重新调用 LLM。
//  LLM_FRESH=1 可强制从零开始；成功产出工程后自动清理。
// ============================================================
function checkpointLoad(prompt, targetFrames = 0, assetKey = "") {
  try {
    if (process.env.LLM_FRESH === "1") return null;
    if (!fs.existsSync(CHECKPOINT_STATE)) return null;
    const state = JSON.parse(fs.readFileSync(CHECKPOINT_STATE, "utf8"));
    if (!state || state.prompt !== prompt || !state.manifest) return null;
    // 素材 / 字幕这类会直接改变组件源码的输入也必须一致：
    // 否则「上一版没素材、这一版勾了直接使用」会原样复用旧组件，素材永远不会进画面。
    if (String(state.assetKey || "") !== String(assetKey || "")) {
      console.error(`  [resume] 检查点的素材/开关参数不匹配（上次 ${state.assetKey || "无"} / 本次 ${assetKey || "无"}），本次重新生成组件`);
      checkpointClear();
      return null;
    }
    // 时长变了就不能复用旧分镜（否则用户填的 30s 会续上一次 20s 的规划）
    const savedSeconds = Math.round(Number(state.targetSeconds) || 0);
    const wantSeconds = Math.round((targetFrames || 0) / FPS);
    if (savedSeconds !== wantSeconds) {
      console.error(`  [resume] 检查点的时长参数不匹配（上次 ${savedSeconds}s / 本次 ${wantSeconds}s），本次重新规划`);
      checkpointClear();
      return null;
    }
    // 保鲜期：只有「刚刚失败、马上重跑」才续跑。隔一段时间再用同一句描述生成，
    // 应该是一条全新的随机视频（新风格包 / 新分镜），而不是把上次的旧风格捡回来。
    const age = Date.now() - Date.parse(state.updatedAt || state.createdAt || 0);
    if (!(age >= 0 && age <= RESUME_WINDOW_MS)) {
      console.error(
        `  [resume] 检查点已过期（${Math.round(age / 60000)} 分钟前，保鲜期 ${Math.round(RESUME_WINDOW_MS / 60000)} 分钟），本次重新随机生成`
      );
      checkpointClear();
      return null;
    }
    const components = {};
    if (fs.existsSync(CHECKPOINT_COMPONENT_DIR)) {
      for (const f of fs.readdirSync(CHECKPOINT_COMPONENT_DIR)) {
        if (f.endsWith(".tsx")) components[f] = fs.readFileSync(path.join(CHECKPOINT_COMPONENT_DIR, f), "utf8");
      }
    }
    return { ...state, components };
  } catch (e) {
    console.error(`  [resume] 检查点读取失败，本次从零开始: ${errLine(e)}`);
    return null;
  }
}

function checkpointSaveState(state) {
  try {
    fs.mkdirSync(CHECKPOINT_COMPONENT_DIR, { recursive: true });
    fs.writeFileSync(CHECKPOINT_STATE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch (e) {
    console.error(`  [resume] 检查点写入失败（不影响本次生成）: ${errLine(e)}`);
  }
}

function checkpointSaveComponent(fileName, code) {
  try {
    fs.mkdirSync(CHECKPOINT_COMPONENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CHECKPOINT_COMPONENT_DIR, fileName), code, "utf8");
  } catch (e) {
    console.error(`  [resume] 组件写入检查点失败（不影响本次生成）: ${errLine(e)}`);
  }
}

function checkpointClear() {
  try {
    fs.rmSync(CHECKPOINT_DIR, { recursive: true, force: true });
  } catch {}
}

async function generateAiFilm({
  apiKey,
  prompt,
  previewOnly = false,
  // 预览模式：只产出工程文件（+可选配音）供浏览器内播放，不跑冒烟、不渲染 MP4
  withSmoke = true,
  // 是否在画面里渲染字幕；关闭时 subtitle 只作配音文案（见 NO_SUBTITLE_CLAUSE）
  subtitles = true,
  // 是否生成配音 / 背景音乐（用户在页面上勾选）
  voice = false,
  bgm = false,
  // 配音失败是否致命：预览阶段应为 false（没声音也能看画面），导出前会重试补齐
  voiceOptional = false,
  // 用户自定义时长（秒）：填了就按目标时长规划分镜，未填则交给 AI 自行决定
  targetSeconds = 0,
  // 用户提供的素材：图片 / 视频 / 网址。reference=只作气质与内容参考；
  // direct=素材原样进画面；redraw=素材经「提取元素 + AI 重绘」后由重绘件进画面
  assets = [],
  assetMode = "reference",
  // 「参考已生成工程的风格」（可多选）：mergeStyleRefs() 合并后的 ref
  styleRef = null,
  onEvent = null,
}) {
  const withVoice = Boolean(voice);
  const withBgm = Boolean(bgm);
  // redraw 与 direct 一样「素材要进画面」，区别只在进的是重绘件还是原图
  const allowMedia =
    (assetMode === "direct" || assetMode === "redraw") && Array.isArray(assets) && assets.some((a) => a && a.file);
  const mediaFiles = allowMedia ? assets.filter((a) => a && a.file).map((a) => a.file) : [];
  // 断点续跑的匹配键：凡「会改变组件源码」的输入都要进这个签名。
  // 否则用户上一版没加素材、这一版勾了「直接使用」，检查点会把旧组件原样复用，
  // 素材就永远不会出现在画面里（表现就是"勾了也没用"）。
  const assetKey = [assetMode, subtitles ? "sub" : "nosub", [...mediaFiles].sort().join(",")].join("|");
  // 素材简报拼进创意方向：规划与组件两处都会自动带上（两处 userMessage 都以 direction 开头）
  const materialBrief = assetsBrief(assets, assetMode, allowMedia);
  const layoutCards = sceneLayoutCards();
  const targetFrames = Number(targetSeconds) > 0
    ? Math.round(Math.min(MAX_TARGET_SECONDS, Math.max(MIN_TARGET_SECONDS, Number(targetSeconds))) * FPS)
    : 0;
  if (targetSeconds && !targetFrames) {
    console.error(`[codegen] 时长参数无效（${targetSeconds}），本次由 AI 自行决定时长`);
  } else if (targetFrames) {
    console.error(`[codegen] 用户指定时长 ${(targetFrames / FPS).toFixed(1)}s → 目标 ${targetFrames} 帧 / ${planSceneCount(targetFrames)} 个分镜`);
  }
  const emit = (ev) => {
    try {
      if (onEvent) onEvent(ev);
    } catch {}
  };

  // 阶段 0: 连通性预检——网络不可达时秒级报错，不浪费额度和等待时间
  if (process.env.LLM_SKIP_PREFLIGHT !== "1") {
    emit({ stage: "preflight" });
    try {
      await preflightGateway(apiKey);
    } catch (e) {
      throw new Error(`网络不可达，未发起生成: ${explainLLMError(e)}`);
    }
  }

  if (assetMode === "direct" || assetMode === "redraw") {
    const modeCn = assetMode === "redraw" ? "AI 重绘素材" : "直接使用素材";
    console.error(
      allowMedia
        ? `[codegen] 素材${assetMode === "redraw" ? "重绘件" : "直用"}：${mediaFiles.join(", ")}`
        : `[codegen] 已开启「${modeCn}」，但本次没有拿到任何可用素材文件（网页未提供可下载的主图 / 上传未成功 / 重绘失败）——本次只能按网址的文字信息生成，画面为原创绘制`
    );
  }

  // 阶段 1: 规划（有同 prompt + 同时长 + 同素材参数的检查点就接着上次跑）
  const resumed = checkpointLoad(prompt, targetFrames, assetKey);
  let pack, direction, manifest, cachedComponents = {};
  if (resumed) {
    pack = STYLE_PACKS.find((p) => p.id === resumed.packId) || pickStylePack();
    // 检查点里存的 direction 可能已经拼过素材简报（同一 prompt 续跑），先剥掉再拼，避免重复
    direction = String(resumed.direction || "").split("\n\n【用户提供的素材")[0] + materialBrief;
    manifest = resumed.manifest;
    cachedComponents = resumed.components;
    console.error(
      `  [resume] 接着上次进度继续（创建于 ${resumed.createdAt || "未知"}，风格包 ${pack.id}）：` +
        `已完成 ${Object.keys(cachedComponents).length}/${manifest.scenes.length + 1} 个组件；要重新生成请设 LLM_FRESH=1`
    );
  } else {
    const r = randomDirection(styleRef);
    pack = r.pack;
    direction = r.direction + materialBrief;
    if (assets.length) {
      console.error(
        `[codegen] 素材 ${assets.length} 件 · 模式=${
          assetMode === "direct" ? "直接使用（进画面）" : assetMode === "redraw" ? "AI 重绘（重绘件进画面）" : "仅参考"
        }` +
          (allowMedia ? ` · 可直接引用 ${mediaFiles.join(", ")}` : "")
      );
    }
    if (styleRef) console.error(`[codegen] 参考工程风格: ${styleRef.projectName}（风格包 ${pack.id}）`);
    emit({ stage: "plan", status: "start", stylePack: pack.id, targetSeconds: targetFrames ? targetFrames / FPS : 0 });
    manifest = await planScenes(apiKey, prompt, direction, targetFrames);
    checkpointSaveState({
      version: 1,
      prompt,
      targetSeconds: targetFrames ? targetFrames / FPS : 0,
      // 素材与开关签名：续跑时必须逐字一致，否则旧组件不能复用
      assetKey,
      packId: pack.id,
      direction,
      manifest,
      createdAt: new Date().toISOString(),
    });
    emit({ stage: "plan", status: "done", scenes: manifest.scenes.length, title: manifest.title });
  }
  const timeline = computeTimeline(manifest.scenes);
  const totalFrames = timeline[timeline.length - 1].from + timeline[timeline.length - 1].durationInFrames;

  // 阶段 2: 并发生成所有组件（每分镜一次调用 + 背景一次调用）；已通过的直接复用
  const jobList = [];
  // 单个组件调用可能跑几分钟：把「已输出 N 字符」实时推给前端，避免看起来卡死
  const onCompProgress = (file, chars, thinking) => emit({ stage: "component-progress", file, chars, thinking: thinking || 0 });
  for (let i = 0; i < manifest.scenes.length; i++) {
    jobList.push({
      fileName: manifest.scenes[i].file,
      isScene: true,
      // assetFiles：把「本次真正可用的素材文件名」交给校验器，
      // 否则模型编造一个不存在的文件名也能通过，渲染时才 404（= 用户看到素材没出现）
      run: () => generateComponent(apiKey, { direction, manifest, timeline, totalFrames, kind: "scene", sceneIndex: i, layoutCards, requiredFonts: pack.requiredFonts, allowMedia, assetFiles: mediaFiles, subtitles, onProgress: onCompProgress }),
    });
  }
  jobList.push({
    fileName: "Backdrop.tsx",
    isScene: false,
    // 背景层只是环境氛围，不是画面主体：它失败不该让整支片子出不来。
    // 以前它就是「卡住/失败 → 整次生成报错」的头号来源，现在退到内置兜底背景。
    optional: true,
    fallback: () => fallbackBackdrop(pack),
    run: () => generateComponent(apiKey, { direction, manifest, timeline, totalFrames, kind: "backdrop", allowMedia, assetFiles: mediaFiles, subtitles, onProgress: onCompProgress }),
  });
  // 复用检查点组件前必须重新过一遍校验：检查点可能是在「没有素材」或「另一种开关」下写的，
  // 直接信任它就会把不符合本次约束的代码落盘 —— 典型表现就是「勾了直接使用素材，画面里还是没有素材」。
  const reusable = new Map();
  for (const j of jobList) {
    const code = cachedComponents[j.fileName];
    if (!code) continue;
    try {
      // 检查点里存的是装配形态（interpolate 已挪到 safeInterp），校验前先还原成 AI 原始形态
      const errs = await validateComponentCode(j.fileName, preAssemblyView(code), j.isScene, pack.requiredFonts, allowMedia, mediaFiles, subtitles);
      if (errs.length) {
        console.error(`  [resume] 复用被拒 ${j.fileName}（需重新生成）: ${errs[0]}`);
        continue;
      }
      reusable.set(j.fileName, code);
    } catch (e) {
      console.error(`  [resume] 复用前校验异常 ${j.fileName}（需重新生成）: ${errLine(e)}`);
    }
  }
  const reused = jobList.filter((j) => reusable.has(j.fileName)).map((j) => j.fileName);
  if (reused.length) console.error(`  [resume] 复用已通过的组件（不再调用 LLM）: ${reused.join(", ")}`);
  let compDone = 0;
  const compTotal = jobList.length;
  emit({ stage: "components", status: "start", total: compTotal });
  const jobs = jobList.map((j) => {
    const cached = reusable.get(j.fileName);
    const run = cached
      ? () => Promise.resolve(cached)
      : async () => {
          try {
            const code = await j.run();
            checkpointSaveComponent(j.fileName, code);
            return code;
          } catch (e) {
            // 可选组件（背景层）失败 → 用兜底版本继续，别把整支片子搭进去。
            // 注意兜底代码不写进检查点：否则下次续跑会拿兜底版当"已通过"，永远补不回 AI 背景。
            if (j.optional && typeof j.fallback === "function") {
              const why = describeError(e).slice(0, 160);
              console.error(`[codegen] ${j.fileName} 生成失败，已用内置兜底版本继续（不阻断成片）: ${why}`);
              emit({ stage: "component", status: "fallback", file: j.fileName, error: why });
              return j.fallback();
            }
            throw e;
          }
        };
    return async () => {
      try {
        const value = await run();
        compDone += 1;
        emit({ stage: "component", status: "done", file: j.fileName, done: compDone, total: compTotal, reused: Boolean(cached) });
        return value;
      } catch (e) {
        compDone += 1;
        emit({ stage: "component", status: "fail", file: j.fileName, done: compDone, total: compTotal, error: String((e && e.message) || e).slice(0, 300) });
        throw e;
      }
    };
  });
  const results = await runPool(jobs, COMPONENT_CONCURRENCY);

  const failures = results.filter((r) => !r.ok);
  if (failures.length) {
    const netDown = failures.some((f) => isConnectFailure(f.error));
    throw new Error(
      `组件生成失败 ${failures.length} 个:\n  ${failures.map((f) => describeError(f.error)).join("\n  ")}` +
        (netDown ? "\n  其中至少一项是网络 / VPN / 代理问题——恢复网络后重跑即可（已通过的组件会复用，不用从头重烧）。" : "") +
        "\n  被拒代码与完整校验原因已存到 generator/failed/（report.log）；已完成进度在 generator/.checkpoint/。"
    );
  }

  const files = {};
  jobList.forEach((j, i) => {
    files[j.fileName] = results[i].value;
  });

  const summary = {
    compositionId: manifest.id,
    title: manifest.title,
    sceneCount: manifest.scenes.length,
    scenes: timeline.map((t, i) => ({
      name: manifest.scenes[i].name,
      subtitle: manifest.scenes[i].subtitle,
      file: manifest.scenes[i].file,
      from: t.from,
      to: t.from + t.durationInFrames,
    })),
    totalFrames,
    duration: (totalFrames / FPS).toFixed(1) + "s",
    fps: FPS,
    voiceTracks: manifest.voice.tracks.length,
  };
  const codeStats = {
    files: Object.keys(files).length,
    totalLines: Object.values(files).reduce((n, c) => n + c.split("\n").length, 0),
  };

  if (previewOnly) {
    return { manifest, files, summary, direction, stylePack: pack.id, codeStats, projectPath: null };
  }

  const dirName = uniqueDirName(manifest.id.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-"));
  const outAbs = path.join(ROOT, dirName);
  fs.mkdirSync(outAbs, { recursive: true });

  // 阶段 3：装配（+ 可选配音 + 可选运行时冒烟）
  //   预览模式（withSmoke=false）：装配 + 配音（失败不致命）后立即返回工程目录，
  //   浏览器端用 @remotion/player 直接播放这些 AI 组件 —— 不做逐帧渲染、不产出 MP4。
  //   导出模式（withSmoke=true）：额外跑运行时冒烟，把"渲染到第 N 帧才炸"的错误提前拦下来。
  emit({ stage: "assemble", status: "start" });
  // 直用模式：把上传的素材拷进工程 public/assets/，组件里的 staticFile("assets/…") 才有东西可取。
  // 预览侧则通过 window.remotion_staticBase 指到 /api/media/<工程>/ ，无需再拷一份。
  if (allowMedia && mediaFiles.length) {
    const assetDir = path.join(outAbs, "public", "assets");
    fs.mkdirSync(assetDir, { recursive: true });
    let copied = 0;
    for (const a of assets) {
      if (!a || !a.file) continue;
      try {
        fs.copyFileSync(a.absPath, path.join(assetDir, a.file));
        copied += 1;
      } catch (e) {
        console.error(`[codegen] 素材拷贝失败 ${a.file}: ${errLine(e)}`);
      }
    }
    console.error(`[codegen] 素材已就位：${copied}/${mediaFiles.length} → public/assets/`);
  }
  // 配音 / 配乐：先让 AI 出一份「配音方案」，再合成本地音频，最后换算成帧时间轴写进 manifest
  let voiceReady = false;
  let voiceInfo = { provider: "none", voiceName: "", tracks: 0, bgm: null, warnings: [] };
  if (withVoice || withBgm) {
    try {
      emit({ stage: "voiceplan", status: "start" });
      const plan = await planVoiceover(apiKey, manifest, { direction, prompt, withBgm });
      emit({ stage: "voiceplan", status: "done", voice: plan.voice, music: plan.music ? plan.music.mood : null });
      const { synth, bgm: bgmCfg } = await synthesizeVoiceFiles(outAbs, plan, { withVoice, withBgm, totalFrames, onStage: emit });
      if (withVoice) {
        const applied = applyVoicePlan(manifest, plan, synth, timeline, { bgm: bgmCfg });
        voiceReady = applied.ok;
        voiceInfo = {
          provider: manifest.voice.provider,
          voiceName: plan.voice,
          tracks: applied.tracks.length,
          bgm: bgmCfg,
          warnings: applied.warnings,
        };
        if (!applied.ok) {
          const why = (synth && synth.error) || "配音合成未产出可用音频";
          if (voiceOptional) {
            console.error(`[codegen] 配音不可用，先给无声版本（导出前会自动重试补齐）: ${why}`);
            emit({ stage: "voice", status: "fail", error: why });
          } else {
            throw new Error(`配音生成失败: ${why}`);
          }
        }
        for (const w of applied.warnings) console.error(`[codegen] 配音提示: ${w}`);
      } else if (bgmCfg) {
        // 只要配乐不要配音：把 bgm 记进 manifest，tracks 留空
        manifest.voice = { enabled: false, provider: "none", voiceName: "", tracks: [], bgm: bgmCfg };
        voiceInfo = { provider: "none", voiceName: "", tracks: 0, bgm: bgmCfg, warnings: [] };
      }
    } catch (e) {
      if (!voiceOptional) throw e;
      console.error(`[codegen] 配音规划/合成失败，本次无声: ${errLine(e)}`);
      emit({ stage: "voice", status: "fail", error: errLine(e) });
    }
  }

  const assembleExtra = { stylePack: pack.id, assets: mediaFiles, subtitles };
  assembleProject(outAbs, dirName, manifest, files, totalFrames, timeline, assembleExtra);

  // 直用模式的硬门槛：素材必须在画面里看得见。
  // 光是"代码里写了 staticFile"不够——被盖住 / 透明 / 尺寸为 0 / 移到画面外都照样看不见，
  // 用户看到的就是"勾了直接使用，成片里还是没我的东西"。所以这里渲染真实帧做像素比对，
  // 看不见就让 AI 重写那几个分镜，并把实测数字一起喂回去。
  if (allowMedia && mediaFiles.length) {
    for (let round = 1; round <= 2; round++) {
      let measured = null;
      try {
        measured = await measureAssetVisibility(outAbs, manifest, timeline);
      } catch (e) {
        // 别把"门槛自己坏了"说成"渲染环境不可用" —— 后者会让人以为只是渲染抖动，
        // 结果真 bug（比如少了 zlib require）就这么被长期忽略了。
        console.error(`[codegen] 素材可见性实测无法执行，已跳过（不阻断生成，但等于没有这道门槛）: ${errLine(e)}`);
        break;
      }
      if (!measured || !measured.length) break; // 没有任何组件引用素材 → 校验器已经拦过，不会走到这
      // 门槛取 2%：素材在画面里占 5.7% 面积时，实测约贡献 4% 的像素变化（部分像素色差小于阈值）。
      // 所以门槛定在 5% 会把「明明看得见」的素材也误判成隐形、白白重写一轮；
      // 真正该拦的是 0%~1% 这种压根没露出来的情况。
      const THRESHOLD = 0.02;
      const bad = measured.filter((m) => m.ratio < THRESHOLD);
      const parts = measured.map((m) => `S${m.sceneIndex + 1} ${(m.ratio * 100).toFixed(0)}%`).join(" · ");
      // 逐帧明细：能一眼区分"入场动画还没到位"还是"素材真的被盖住了"
      for (const m of measured) {
        console.error(
          `[codegen]    S${m.sceneIndex + 1} 采样 ${m.perFrame.map((f) => `@${f.frame}:${(f.ratio * 100).toFixed(1)}%`).join(" ")}`
        );
      }
      emit({ stage: "asset-proof", round, ratios: measured.map((m) => ({ scene: m.sceneIndex + 1, ratio: Number(m.ratio.toFixed(4)) })) });
      if (!bad.length) {
        console.error(`[codegen] 素材可见性实测通过（各分镜素材对画面的像素影响：${parts}）`);
        break;
      }
      console.error(
        `[codegen] 第${round}轮：${bad.length} 个分镜里素材几乎看不见（${bad
          .map((b) => `S${b.sceneIndex + 1} 仅 ${(b.ratio * 100).toFixed(1)}%`)
          .join("，")}）—— 让 AI 重写这些分镜`
      );
      const jobs = bad.map((b) => () =>
        generateComponent(apiKey, {
          direction, manifest, timeline, totalFrames, kind: "scene", sceneIndex: b.sceneIndex, layoutCards,
          requiredFonts: pack.requiredFonts, allowMedia, assetFiles: mediaFiles, subtitles,
          extraFeedback:
            `【素材可见性实测：你写的这一分镜里，用户素材基本没露出来】\n` +
            `我把这一分镜真实渲染出来，再把 <Img>/<OffthreadVideo> 的素材换成全透明占位图、渲染同一帧做像素比对：` +
            `画面只有 ${(b.ratio * 100).toFixed(1)}% 的像素发生了变化（低于 2% 的可见门槛），也就是说用户根本看不到素材。\n` +
            `采样点明细：${b.perFrame.map((f) => `第${f.frame}帧 ${(f.ratio * 100).toFixed(1)}%`).join("，")}。` +
            `如果所有采样点都很低，说明素材被盖住了；如果只有早期采样点低、后期高，那是入场动画太慢，请把入场提前到 0~10 帧内完成。\n` +
            `最常见的原因：素材被后画的图层整块盖住、opacity 为 0 或极低、宽高为 0 或被 overflow 裁掉、被移出画面范围、` +
            `塞在 SVG 的 <foreignObject> 里（服务端与逐帧渲染都不显示）。\n` +
            `请重写这个分镜，把素材作为画面主体明显露出：不透明、尺寸足够（占满画面或至少占据一个明显区域）、不被任何层完整遮住、` +
            `<Img>/<OffthreadVideo> 直接放在 AbsoluteFill 里做绝对定位构图。保持创意方向与字幕文案不变。`,
        })
      );
      const res = await runPool(jobs, COMPONENT_CONCURRENCY);
      let changed = 0;
      bad.forEach((b, k) => {
        if (res[k].ok) {
          files[manifest.scenes[b.sceneIndex].file] = res[k].value;
          checkpointSaveComponent(manifest.scenes[b.sceneIndex].file, res[k].value);
          changed += 1;
        } else {
          console.error(`[codegen] 场景${b.sceneIndex + 1} 重写未通过: ${describeError(res[k].error).slice(0, 160)}`);
        }
      });
      if (!changed) break; // 重写没产出可用代码，再试也是浪费配额
      assembleProject(outAbs, dirName, manifest, files, totalFrames, timeline, assembleExtra);
    }
  }

  const SMOKE_ROUNDS = withSmoke ? Number(process.env.SMOKE_ROUNDS) || 2 : 0;
  for (let round = 1; round <= SMOKE_ROUNDS; round++) {
    // 第 1 轮用上面已装配好的工程；后续轮次是组件被重生成后重新装配
    if (round > 1) assembleProject(outAbs, dirName, manifest, files, totalFrames, timeline, assembleExtra);
    emit({ stage: "smoke", status: "start", round, rounds: SMOKE_ROUNDS });
    console.error(`[codegen] 冒烟第 ${round}/${SMOKE_ROUNDS} 轮…`);
    const failures = await smokeTestProject(outAbs, manifest, timeline);
    if (!failures.length) {
      console.error(`[codegen] 冒烟通过：${manifest.scenes.length} 场景 + 末帧全部可渲染`);
      emit({ stage: "smoke", status: "done", round, rounds: SMOKE_ROUNDS });
      // 清理冒烟临时 PNG
      try {
        for (const f of fs.readdirSync(path.join(outAbs, "out"))) {
          if (f.startsWith("__smoke_")) fs.unlinkSync(path.join(outAbs, "out", f));
        }
      } catch {}
      break;
    }
    if (round === SMOKE_ROUNDS) {
      throw new Error(
        `运行时冒烟未通过（已重试 ${SMOKE_ROUNDS} 轮）:\n` +
          failures.map((f) => `  场景${f.sceneIndex} (${(manifest.scenes[f.sceneIndex] || {}).name || "片尾"}) @帧${f.frame}: ${f.error}`).join("\n")
      );
    }
    // 重生成失败场景：运行时错误作为反馈喂给 LLM
    const failedIdx = [...new Set(failures.map((f) => f.sceneIndex))];
    console.error(`[codegen] 冒烟失败场景: ${failedIdx.join(",")}，带运行时错误重生成…`);
    const regenJobs = failedIdx.map((i) => () =>
      generateComponent(apiKey, {
        direction, manifest, timeline, totalFrames, kind: "scene", sceneIndex: i, layoutCards,
        requiredFonts: pack.requiredFonts, allowMedia, assetFiles: mediaFiles, subtitles,
        extraFeedback:
          `【运行时冒烟渲染该场景第 ${failures.find((f) => f.sceneIndex === i).frame} 帧时报错——必须修复根因】\n` +
          `${failures.find((f) => f.sceneIndex === i).error}\n` +
          `请重新输出完整文件（保持创意方向与构图不变，只修复运行时错误）。`,
      })
    );
    const regenResults = await runPool(regenJobs, COMPONENT_CONCURRENCY);
    failedIdx.forEach((i, k) => {
      if (regenResults[k].ok) {
        files[manifest.scenes[i].file] = regenResults[k].value;
        checkpointSaveComponent(manifest.scenes[i].file, regenResults[k].value);
      } else {
        console.error(`[codegen] 场景${i} 重生成未通过静态校验: ${describeError(regenResults[k].error).slice(0, 160)}`);
      }
    });
  }

  checkpointClear(); // 工程已产出，检查点使命完成
  return { manifest, files, summary, direction, stylePack: pack.id, codeStats, projectPath: dirName, voiceReady, voiceInfo, hasMp4: false };
}

// ============================================================
//  预览 / 导出（Web 端两段式流程）
//    预览：只读工程元数据 + 组件文件 → 浏览器内 @remotion/player 直接播放（零渲染、零文件产出）
//    导出：按需补齐配音 → bundle → renderMedia 逐帧渲染 → out/film.mp4
// ============================================================
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

/**
 * 归一化工程里记录的配音轨（供预览载荷使用）。
 * 新格式的轨道已经带绝对 from/duration，原样透传；
 * 老格式（每场景一条 xx-scene.wav，只记了 scene+text）按时间轴推导，保持向后兼容。
 */
function voicePlan(tracks, timeline) {
  return (tracks || []).map((t, i) => {
    if (Number.isFinite(Number(t.from)) && Number.isFinite(Number(t.duration))) {
      return { file: t.file, scene: t.scene, text: t.text, emotion: t.emotion, from: Number(t.from), duration: Number(t.duration) };
    }
    const st = timeline.find((x) => x.name === t.scene);
    return {
      file: t.file || String(i + 1).padStart(2, "0") + "-" + t.scene + ".wav",
      scene: t.scene,
      text: t.text,
      from: st ? st.from : 0,
      duration: st ? Math.max(30, st.durationInFrames - 15) : 60,
    };
  });
}

// 读取工程（优先 preview.json；老工程从 film.config.json + src/scenes 推导）
function buildPreviewPayload(projectName) {
  const dirAbs = path.join(ROOT, projectName);
  if (!fs.existsSync(dirAbs)) throw new Error(`工程目录不存在: ${projectName}`);
  const cfgPath = path.join(dirAbs, "film.config.json");
  let cfg = null;
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    } catch {}
  }
  let meta = null;
  const previewPath = path.join(dirAbs, "preview.json");
  if (fs.existsSync(previewPath)) {
    try {
      meta = JSON.parse(fs.readFileSync(previewPath, "utf8"));
    } catch {}
  }
  if (!meta) {
    if (!cfg || !Array.isArray(cfg.scenes) || !cfg.scenes.length) throw new Error(`工程缺少可预览的元数据: ${projectName}`);
    const scenesDir = path.join(dirAbs, "src", "scenes");
    const files = fs.existsSync(scenesDir)
      ? fs.readdirSync(scenesDir).filter((f) => f.endsWith(".tsx")).sort(naturalCompare)
      : [];
    const tl = computeTimeline(cfg.scenes);
    const last = tl[tl.length - 1];
    meta = {
      version: 0,
      projectName,
      compositionId: cfg.id,
      title: cfg.title || projectName,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      totalFrames: last ? last.from + last.durationInFrames : 0,
      styleTags: cfg.styleTags || [],
      backdrop: "Backdrop.tsx",
      scenes: cfg.scenes.map((s, i) => ({
        name: s.name,
        file: files[i] || `Scene${i + 1}.tsx`,
        subtitle: s.subtitle,
        from: tl[i].from,
        durationInFrames: tl[i].durationInFrames,
      })),
      voice: {
        enabled: Boolean(cfg.voice && cfg.voice.enabled),
        voiceName: (cfg.voice && cfg.voice.voiceName) || "",
        provider: (cfg.voice && cfg.voice.provider) || "none",
        bgm: (cfg.voice && cfg.voice.bgm) || null,
        tracks: voicePlan((cfg.voice && cfg.voice.tracks) || [], tl),
      },
    };
  }
  // 配音轨只有在「记录为启用 + 音频文件真的在磁盘上」时才对外暴露，
  // 否则预览会去加载不存在的音频（控制台一片 404），导出的 missingVoiceTracks 也会误判。
  const sceneDir = path.join(dirAbs, "src", "scenes");
  const missing = meta.scenes.filter((s) => !fs.existsSync(path.join(sceneDir, s.file))).map((s) => s.file);
  const backdrop = meta.backdrop || "Backdrop.tsx";
  const hasBackdrop = fs.existsSync(path.join(dirAbs, "src", backdrop));
  const voiceDir = path.join(dirAbs, "public", "voice");
  const onDisk = fs.existsSync(voiceDir) ? new Set(fs.readdirSync(voiceDir)) : new Set();
  let voice = { enabled: false, declared: false, tracks: [], bgm: null, provider: "none", voiceName: "" };
  if (meta.voice) {
    const tracks = voicePlan(meta.voice.tracks, meta.scenes.map((s, i) => ({ name: s.name, from: s.from, durationInFrames: s.durationInFrames })));
    const usable = tracks.filter((t) => t.file && onDisk.has(t.file));
    const bgmOk = meta.voice.bgm && onDisk.has(meta.voice.bgm.file) ? meta.voice.bgm : null;
    voice = {
      // declared：工程「声称」有配音（生成时勾了配音）。文件缺失时它仍为 true，
      // 导出阶段据此判断要不要用 voice.plan.json 重新合成一遍。
      declared: Boolean(meta.voice.enabled) || Boolean(meta.voice.bgm),
      declaredTracks: tracks.length,
      declaredBgm: Boolean(meta.voice.bgm),
      enabled: Boolean(meta.voice.enabled) && usable.length > 0,
      provider: meta.voice.provider || "none",
      voiceName: meta.voice.voiceName || "",
      voiceReason: meta.voice.voiceReason || "",
      bgm: bgmOk,
      tracks: usable,
    };
  }
  meta.voice = voice;
  const voiceFiles = voice.tracks.map((t) => t.file);
  const outDir = path.join(dirAbs, "out");
  const mp4 = (fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith(".mp4")).sort(naturalCompare) : [])[0] || null;

  // 汇总所有场景代码，抽出真实配色 & 回填风格包（老工程 preview.json 里没记 stylePack 时靠配色反推）
  // 供前端「参考风格」色块与风格沿用使用；读不到代码时静默降级为空。
  let palette = [];
  let stylePack = meta.stylePack || "";
  try {
    const codes = meta.scenes
      .map((s) => path.join(sceneDir, s.file))
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, "utf8"));
    if (codes.length) {
      const merged = codes.join("\n");
      palette = extractPalette(merged);
      if (!stylePack) stylePack = detectPackFromCode(merged);
    }
  } catch {}

  return {
    ...meta,
    projectName,
    stylePack,
    palette,
    // 老工程没记这个字段 → 按「有字幕」处理，与旧行为一致
    subtitles: meta.subtitles !== false,
    dirAbs,
    srcDirAbs: path.join(dirAbs, "src"),
    missing,
    hasBackdrop,
    voiceFiles,
    mp4,
    ready: missing.length === 0 && hasBackdrop,
  };
}

// 缺哪些配音轨：工程声称有配音/配乐，但磁盘上音频不全（预览阶段合成失败的场景）
function missingVoiceTracks(payload) {
  const v = payload.voice || {};
  if (!v.declared) return [];
  const lack = [];
  if (v.declaredTracks && (!v.tracks || v.tracks.length < v.declaredTracks)) lack.push("配音");
  if (v.declaredBgm && !v.bgm) lack.push("配乐");
  return lack;
}

/**
 * 导出前自愈：工程声称有配音但音频缺失时，用生成阶段留下的 voice.plan.json 重新合成，
 * 并把新的帧时间轴回写到 src/config.json / film.config.json / preview.json。
 * 这样「预览没声音」不会变成「导出也没声音」。
 */
async function regenerateVoiceForExport(outAbs, payload, log) {
  const planPath = path.join(outAbs, "voice.plan.json");
  if (!fs.existsSync(planPath)) {
    log("配音缺失且没有 voice.plan.json（旧工程），本次导出保持无声");
    return false;
  }
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(planPath, "utf8"));
  } catch (e) {
    log(`voice.plan.json 解析失败，跳过配音补齐: ${errLine(e)}`);
    return false;
  }
  const plan = saved.plan;
  if (!plan || !Array.isArray(plan.scenes)) {
    log("voice.plan.json 内容不完整，跳过配音补齐");
    return false;
  }
  log("检测到配音/配乐缺失，按 voice.plan.json 重新合成…");
  const wantVoice = saved.withVoice !== false;
  const { synth, bgm } = await synthesizeVoiceFiles(outAbs, plan, {
    withVoice: wantVoice,
    withBgm: Boolean(saved.withBgm),
    totalFrames: payload.totalFrames,
  });
  const timeline = (payload.scenes || []).map((s) => ({ name: s.name, from: s.from, durationInFrames: s.durationInFrames }));
  const manifestStub = { voice: null };
  if (wantVoice && synth && synth.ok) {
    const applied = applyVoicePlan(manifestStub, plan, synth, timeline, { bgm });
    if (!applied.ok) {
      log("配音补齐后仍无法排布时间轴，本次导出保持无声");
      return false;
    }
  } else if (wantVoice) {
    log(`配音补齐失败: ${(synth && synth.error) || "未知错误"}，本次导出保持无声`);
    return false;
  } else {
    // 只补配乐：没有配音轨，音轨只挂一条 bgm
    if (!bgm) {
      log("配乐补齐失败，本次导出保持无声");
      return false;
    }
    manifestStub.voice = { enabled: false, declared: true, provider: "none", voiceName: "", tracks: [], bgm };
  }
  // 回写三个 JSON，保证 config.json（渲染用）与 preview.json（预览用）一致
  const voiceCfg = manifestStub.voice;
  for (const rel of ["src/config.json", "film.config.json", "preview.json"]) {
    const p = path.join(outAbs, rel);
    if (!fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.voice = voiceCfg;
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch (e) {
      console.error(`[render] 回写 ${rel} 失败: ${errLine(e)}`);
    }
  }
  log(`配音已补齐：${applied.tracks.length} 句${bgm ? " + 配乐" : ""}`);
  return true;
}

// 按需补齐配音 → 打包 → 逐帧渲染出 out/film.mp4
async function renderProjectMp4({ projectName, onLog = null, onProgress = null }) {
  const log = (m) => {
    console.error(`[render] ${m}`);
    try {
      if (onLog) onLog(m);
    } catch {}
  };
  const payload = buildPreviewPayload(projectName);
  if (!payload.ready) {
    const lack = [...(payload.hasBackdrop ? [] : [payload.backdrop || "Backdrop.tsx"]), ...payload.missing];
    throw new Error(`工程文件不完整，缺少: ${lack.join(", ")}`);
  }
  const outAbs = payload.dirAbs;
  const t0 = Date.now();

  // 1) 配音 / 配乐：工程声称有但音频缺失时，用生成阶段留下的方案重新合成一遍
  const lack = missingVoiceTracks(payload);
  if (lack.length) {
    log(`配音/配乐缺失（${lack.join("、")}），尝试补齐…`);
    try {
      await regenerateVoiceForExport(outAbs, payload, log);
    } catch (e) {
      log(`配音补齐异常（不影响画面渲染）: ${errLine(e)}`);
    }
  } else if (payload.voice && payload.voice.enabled) {
    log(`配音已就绪（${payload.voice.tracks.length} 句${payload.voice.bgm ? " + 配乐" : ""}），跳过合成`);
  } else {
    log("本工程未启用配音/配乐，导出为纯画面成片");
  }
  // 补齐后重新读一次：渲染时 config.json 才是最新的
  const finalPayload = buildPreviewPayload(projectName);
  const hasAudio =
    Boolean(finalPayload.voice && finalPayload.voice.enabled && finalPayload.voice.tracks.length) ||
    Boolean(finalPayload.voice && finalPayload.voice.bgm);

  // 2) 打包 + 逐帧渲染
  const { bundle } = require("@remotion/bundler");
  const { selectComposition, renderMedia } = require("@remotion/renderer");
  log("打包 Remotion 工程…");
  let lastPct = -1;
  const serveUrl = await bundle({
    entryPoint: path.join(outAbs, "src", "index.ts"),
    publicDir: path.join(outAbs, "public"),
    onProgress: (p) => {
      const pct = Math.round(p);
      if (pct >= lastPct + 20) {
        lastPct = pct;
        log(`打包中 ${pct}%`);
      }
    },
  });
  const composition = await selectComposition({ serveUrl, id: payload.compositionId, inputProps: {} });
  const outputLocation = path.join(outAbs, "out", "film.mp4");
  fs.mkdirSync(path.dirname(outputLocation), { recursive: true });
  log(`开始逐帧渲染 ${composition.durationInFrames} 帧 @ ${composition.fps}fps ${composition.width}×${composition.height}…`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation,
    inputProps: {},
    overwrite: true,
    // 只有确实没有音频时才静音；有配音/配乐就必须把音轨渲进去
    muted: !hasAudio,
    onProgress: (p) => {
      try {
        if (onProgress) onProgress(p);
      } catch {}
    },
  });
  const stat = fs.statSync(outputLocation);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log(`渲染完成，用时 ${secs}s，输出 ${(stat.size / 1048576).toFixed(2)}MB`);
  return {
    file: "film.mp4",
    fileAbs: outputLocation,
    sizeBytes: stat.size,
    durationInFrames: composition.durationInFrames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    elapsedSec: Number(secs),
  };
}

// 服务起来之后再分片清理过期的 tsc 临时目录（见 sweepStaleTscDirs 注释：
// 同步删会把服务卡死，所以推迟到 listen 之后且分片执行）
setImmediate(() => { sweepStaleTscDirs().catch(() => {}); });

module.exports = {
  // 素材可见性门槛：导出以便回归测试（实测过「工程里素材到底露没露出来」）
  measureAssetVisibility,
  sceneProbeFrames,
  generateAiFilm,
  randomDirection,
  preflightGateway,
  callLLM,
  streamLLM,
  fallbackBackdrop,
  optimizePrompt,
  buildOptimizeAssetsBrief,
  isConnectFailure,
  explainLLMError,
  describeError,
  validateComponentCode,
  repairComponentImports,
  proxyFor,
  connectTunnel,
  buildPreviewPayload,
  missingVoiceTracks,
  renderProjectMp4,
  // 配音 / 配乐
  synthesizeVoiceFiles,
  planVoiceover,
  applyVoicePlan,
  regenerateVoiceForExport,
  voiceKit,
  voiceBudgetChars,
  clampLinesToBudget,
  // 时长对齐：用户自定义时长相关的确定性逻辑（便于单测）
  fitManifestToDuration,
  planSceneCount,
  // 直用模式 / 参考模式：把素材清单也带出去，服务端与前端都要用
  SAFE_INTERP_MODULE,
  safeInterpImportPath,
  squeezeLiteralInputRanges,
  routeInterpolateToSafe,
  preAssemblyView,
  dedupeImports,
  stripNamesFromModule,
  dropShadowedApiDeclarations,
  sweepStaleTscDirs,
  // 素材与风格参考
  assetsBrief,
  inspectUrl,
  fetchExternal,
  fetchBinary,
  buildStyleRef,
  mergeStyleRefs,
  extractPalette,
  // 优化描述：完整方案识别（便于回归测试）
  isDetailedBrief,
  DETAIL_MARKERS,
};
