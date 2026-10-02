// generator/test-timeouts.cjs — 超时/预检行为的离线回归测试（本地 mock 网关，不消耗 API 额度）
// 用法: node generator/test-timeouts.cjs
// 注意：codegen.js 在模块加载时读取 LLM_URL / 超时相关环境变量，必须在 require 之前设好。
process.env.LLM_URL = "http://127.0.0.1:8899/v1/chat/completions";
process.env.LLM_CONNECT_TIMEOUT_MS = "1500"; // 故意设得很短
process.env.LLM_PREFLIGHT_TIMEOUT_MS = "1500";

const http = require("node:http");
const { callLLM, preflightGateway, explainLLMError } = require("./codegen.js");

// 用 Authorization 里的 key 当路由选择器（不要改 LLM_URL——模块加载后就固定了）
function keyOf(req) {
  return String(req.headers.authorization || "").replace("Bearer ", "");
}

const server = http.createServer((req, res) => {
  const key = keyOf(req);
  if (key === "slow-key") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "思考中" } }] })}\n\n`);
    // 静默 3s：远超连接超时 1.5s——若连接超时没在响应开始时解除，这里就会被杀掉
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"id":"X"' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ',"scenes":[]}' }, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }, 3000);
  } else if (key === "401-key") {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end('{"error":"invalid api key"}');
  } else if (key === "ok-key") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  }
  // 其他 key（hang-key）：接受连接但永不响应
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

server.listen(8899, "127.0.0.1", async () => {
  // 1. 慢速流式：响应开始后静默 3s（> 连接超时 1.5s），应仍能拿到完整内容
  try {
    const t = Date.now();
    const content = await callLLM("slow-key", "sys", "user", 100, 0.9);
    check("响应开始后长时间静默不会被连接超时误杀", content === '{"id":"X","scenes":[]}', `${((Date.now() - t) / 1000).toFixed(1)}s, ${content}`);
  } catch (e) {
    check("响应开始后长时间静默不会被连接超时误杀", false, explainLLMError(e));
  }

  // 2. 网关挂死：单次尝试应在 ~1.5s 内快速失败（LLM_MAX_RETRY=1 去掉退避干扰）
  process.env.LLM_MAX_RETRY = "1";
  const t2 = Date.now();
  try {
    await callLLM("hang-key", "sys", "user", 100, 0.9);
    check("网关挂死时快速失败", false, "竟然成功了");
  } catch (e) {
    const dt = (Date.now() - t2) / 1000;
    check("网关挂死时 ~1.5s 快速失败（不再等 20s TCP 超时）", dt < 3, `${dt.toFixed(1)}s: ${explainLLMError(e)}`);
  }
  process.env.LLM_MAX_RETRY = "6";

  // 3. 预检：key 无效
  try {
    await preflightGateway("401-key");
    check("预检识别 key 失效", false, "竟然通过了");
  } catch (e) {
    check("预检识别 key 失效", /key 无效或已过期/.test(e.message), e.message);
  }

  // 4. 预检：正常可用的网关
  try {
    const t = Date.now();
    const ok = await preflightGateway("ok-key");
    check("预检通过（HTTP 200）", ok === true, `${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (e) {
    check("预检通过（HTTP 200）", false, explainLLMError(e));
  }

  // 5. 预检：网关不可达，应快速失败
  const t5 = Date.now();
  try {
    await preflightGateway("hang-key");
    check("预检在网关无响应时快速失败", false, "竟然成功了");
  } catch (e) {
    const dt = (Date.now() - t5) / 1000;
    check("预检在网关无响应时快速失败（~1.5s）", dt < 3 && /连接 AI 网关超时/.test(e.message), `${dt.toFixed(1)}s: ${e.message}`);
  }

  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
});
