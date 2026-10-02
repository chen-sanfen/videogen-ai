// generator/test-proxy.cjs — 代理（CONNECT 隧道）离线测试（不联网、不消耗额度）
// 用法: node generator/test-proxy.cjs
// 结构：本地 mock 代理(8899) + 本地自签 HTTPS 网关(8897) + 本地明文网关(8898)
//   LLM_URL 走 https → 覆盖"CONNECT 隧道 + 隧道上再做 TLS"这条最容易写错的路径
//   connectTunnel 单独用明文目标验证隧道本身
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const { execFileSync } = require("node:child_process");

// ---- 环境必须在 require codegen 之前设好（模块加载时读取）----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-"));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // 仅本测试：放行自签证书（Node 会打印告警，属预期）
process.env.LLM_PROXY = "http://127.0.0.1:8899"; // 显式指定 → 回环地址也照走代理
process.env.LLM_URL = "https://127.0.0.1:8897/v1/chat/completions";
process.env.LLM_CONNECT_TIMEOUT_MS = "3000";
process.env.LLM_PREFLIGHT_TIMEOUT_MS = "3000";

const { preflightGateway, streamLLM, proxyFor, connectTunnel, isConnectFailure, explainLLMError, describeError } =
  require("./codegen.js");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------- 自签证书 ----------------
const CERT = path.join(TMP, "cert.pem");
const KEY = path.join(TMP, "key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", KEY, "-out", CERT, "-days", "1",
  "-subj", "/CN=127.0.0.1",
  "-addext", "subjectAltName=IP:127.0.0.1",
], { stdio: "ignore" });

// ---------------- mock 代理（CONNECT）----------------
const proxyLog = [];
let proxyMode = "ok"; // ok | 502 | 407
const proxy = http.createServer((req, res) => {
  res.writeHead(405);
  res.end("仅支持 CONNECT");
});
proxy.on("connect", (req, clientSocket, head) => {
  proxyLog.push(req.url);
  if (proxyMode === "407") {
    clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    return;
  }
  if (proxyMode === "502") {
    // Clash 没有可用节点时的典型表现
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    return;
  }
  const [host, port] = String(req.url).split(":");
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const kill = () => { upstream.destroy(); clientSocket.destroy(); };
  upstream.on("error", kill);
  clientSocket.on("error", kill);
});

// ---------------- mock HTTPS 网关（SSE）----------------
const STREAM_TEXT = "PROXY-TUNNEL-OK";
const gateway = https.createServer(
  { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) },
  (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      const isPreflight = (parsed.messages || []).some((m) => m.content === "ping");
      if (isPreflight) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: STREAM_TEXT } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  }
);

// ---------------- mock 明文网关（验证明文隧道）----------------
const plain = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("PLAIN-TUNNEL-OK");
});

const P = { host: "127.0.0.1", port: 8899, auth: null, label: "127.0.0.1:8899" };

async function main() {
  // 1. proxyFor 纯函数语义
  check("普通域名走代理", proxyFor("api.evomap.ai", { explicit: false, proxy: P, bypass: [] }) === P);
  check("继承来的代理自动跳过回环地址（本地网关/mock 不被绕出去）",
    proxyFor("127.0.0.1", { explicit: false, proxy: P, bypass: [] }) === null);
  check("显式 LLM_PROXY 时回环也走代理（便于本地调试/测试）",
    proxyFor("127.0.0.1", { explicit: true, proxy: P, bypass: [] }) === P);
  check("LLM_NO_PROXY 白名单精确命中",
    proxyFor("api.evomap.ai", { explicit: true, proxy: P, bypass: ["api.evomap.ai"] }) === null);
  check("LLM_NO_PROXY 后缀命中（.evomap.ai）",
    proxyFor("sub.evomap.ai", { explicit: true, proxy: P, bypass: [".evomap.ai"] }) === null);
  check("没配代理时永远直连", proxyFor("api.evomap.ai", { explicit: false, proxy: null, bypass: [] }) === null);

  // 2. 隧道 + 隧道上的 TLS
  try {
    await preflightGateway("test-key");
    check("预检经代理（CONNECT + TLS）通过", true);
  } catch (e) {
    check("预检经代理（CONNECT + TLS）通过", false, e.message);
  }
  check("预检确实是经代理出去的（代理收到了 CONNECT 目标）",
    proxyLog.includes("127.0.0.1:8897"), proxyLog.join(" | ") || "(代理无记录)");

  try {
    const r = await streamLLM("test-key", "sys", "usr", 128, 0.9, 5000);
    check("流式生成经代理拿到完整内容", r.content === STREAM_TEXT, `content=${JSON.stringify(r.content)}`);
  } catch (e) {
    check("流式生成经代理拿到完整内容", false, e.message);
  }

  // 3. 明文目标的隧道（走 http，不做 TLS）
  //    请求选项故意写 port:1（关闭的端口）：只有真的用了隧道 socket 才可能成功，
  //    顺带盯住「createConnection 必须挂 Agent 上」这个坑（请求级写法会被 Node 忽略、自己另开直连）
  try {
    const sock = await connectTunnel(P, "127.0.0.1", 8898, false, 3000);
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => sock;
    const body = await new Promise((resolve) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: 1, path: "/", method: "GET", agent, headers: { Host: "127.0.0.1:8898" } },
        (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)); }
      );
      req.on("error", (e) => resolve(`ERR:${e.code || e.message}`));
      req.end();
    });
    check("明文目标经隧道请求（请求端口故意写错，证明真用了隧道 socket）", body === "PLAIN-TUNNEL-OK", `body=${JSON.stringify(body)}`);
    check("代理记录了到明文网关的 CONNECT", proxyLog.includes("127.0.0.1:8898"), proxyLog.join(" | "));
  } catch (e) {
    check("明文目标经隧道请求（请求端口故意写错，证明真用了隧道 socket）", false, e.message);
  }

  // 4. 代理故障必须给出人话，且算"网络类"（不消耗组件校验配额）
  proxyMode = "502";
  try {
    await streamLLM("test-key", "sys", "usr", 128, 0.9, 5000);
    check("代理 502 时抛错", false, "居然没抛错");
  } catch (e) {
    check("代理 502 时抛错", true);
    check("代理 502 被判定为网络类故障（不占校验配额）", isConnectFailure(e) === true, `isConnectFailure=${isConnectFailure(e)}`);
    const msg = describeError(e);
    check("代理 502 的报错说清了是代理的问题", /代理 .*拒绝隧道 HTTP 502/.test(msg) && /可用节点/.test(msg), msg.slice(0, 120));
  }

  proxyMode = "407";
  try {
    await streamLLM("test-key", "sys", "usr", 128, 0.9, 5000);
    check("代理 407 时抛错", false, "居然没抛错");
  } catch (e) {
    const msg = explainLLMError(e);
    check("代理要求认证时提示用 user:pass 写法", /407/.test(msg) && /user:pass/.test(msg), msg.slice(0, 120));
  }

  proxyMode = "ok";
  try {
    await connectTunnel({ host: "127.0.0.1", port: 1, auth: null, label: "127.0.0.1:1" }, "api.evomap.ai", 443, true, 2000);
    check("代理不可达时抛错", false, "居然没抛错");
  } catch (e) {
    check("代理不可达时抛错且算网络类", /无法连接代理/.test(e.message) && isConnectFailure(e) === true, e.message.slice(0, 100));
  }

  // 5. 需要认证的代理：应带上 Proxy-Authorization
  const authProxy = { host: "127.0.0.1", port: 8899, auth: "Basic dGVzdDp0ZXN0", label: "127.0.0.1:8899" };
  let sawAuth = null;
  proxy.removeAllListeners("connect");
  proxy.on("connect", (req, clientSocket) => {
    sawAuth = req.headers["proxy-authorization"] || null;
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  try { await connectTunnel(authProxy, "api.evomap.ai", 443, true, 2000); } catch {}
  check("带认证的代理会发送 Proxy-Authorization", sawAuth === "Basic dGVzdDp0ZXN0", String(sawAuth));

  proxy.close();
  gateway.close();
  plain.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

proxy.listen(8899, "127.0.0.1", () => {
  gateway.listen(8897, "127.0.0.1", () => {
    plain.listen(8898, "127.0.0.1", () => {
      main().catch((e) => {
        console.error("测试异常:", e);
        process.exit(1);
      });
    });
  });
});
