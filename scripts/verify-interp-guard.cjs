/* 插值安全网回归：真实打开工程「预览」，持续播放并轮询，
 * 断言不会出现「该场景运行时出错 inputRange must be strictly monotonically increasing」。
 *
 * 用法：
 *   node scripts/verify-interp-guard.cjs [工程名] [观察秒数]
 *   默认 allterrainmechamemphis（首例 [34,46,45,55] 崩溃的工程），观察 25s
 */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const APP = process.env.APP_URL || 'http://localhost:4175/';
const PROJECT = process.argv[2] || 'allterrainmechamemphis';
const WATCH_SEC = Number(process.argv[3] || 25);
const PORT = 9341;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-interp-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ok = false;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        ok = true;
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!ok) throw new Error('Chrome 未能在 10s 内启动 CDP');

  const tab = await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })
  ).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pending = new Map();
  const exceptions = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalp = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // 等工程列表
  for (let i = 0; i < 80; i++) {
    const n = await evalp(`document.querySelectorAll('.gen-pc-btn').length`);
    if (n > 0) break;
    await sleep(300);
  }

  const info = await evalp(`(() => {
    const cards = [...document.querySelectorAll('.gen-project-card')];
    const card = cards.find(c => (c.querySelector('.gen-pc-name')?.textContent || '').includes(${JSON.stringify(PROJECT)}));
    if (!card) return { found: false, names: cards.slice(0,6).map(c=>c.querySelector('.gen-pc-name')?.textContent) };
    const btn = [...card.querySelectorAll('.gen-pc-btn')].find(b => b.textContent.trim() === '预览');
    if (!btn) return { found: true, clickable: false };
    btn.click();
    return { found: true, clickable: true };
  })()`);
  if (!info.found) throw new Error(`页面上找不到工程 ${PROJECT}（当前前几个：${(info.names || []).join(', ')}）`);
  if (!info.clickable) throw new Error(`工程 ${PROJECT} 没有「预览」按钮（可能未就绪）`);
  console.log(`已点开 ${PROJECT} 的预览，持续观察 ${WATCH_SEC}s …`);

  // 轮询：一旦出现场景运行时报错就记录下来（含首次出现的时刻）
  let firstErrorAt = null;
  let errorText = '';
  const t0 = Date.now();
  while (Date.now() - t0 < WATCH_SEC * 1000) {
    const s = await evalp(`(() => {
      const err = document.querySelector('.gen-player-error');
      const player = document.querySelector('.gen-player');
      return {
        err: err ? err.innerText.slice(0, 200) : '',
        nodes: player ? player.querySelectorAll('*').length : 0,
        status: [...document.querySelectorAll('.gen-preview-status')].map(s=>s.textContent).join(' | '),
      };
    })()`);
    if (s.err && !firstErrorAt) {
      firstErrorAt = ((Date.now() - t0) / 1000).toFixed(1);
      errorText = s.err;
    }
    await sleep(400);
  }

  const nodes = await evalp(`document.querySelector('.gen-player')?.querySelectorAll('*').length || 0`);
  const brand = await evalp(`document.querySelector('.gen-preview-title')?.textContent || ''`);
  console.log(`\n播放器内部节点数 = ${nodes}（>0 说明组件正常挂载出画）`);
  console.log(`预览标题：${brand}`);

  const monotonic = exceptions.filter((e) => /monotonically increasing|inputRange/i.test(e));
  console.log(
    firstErrorAt
      ? `❌ 播放 ${firstErrorAt}s 后出现场景运行时错误：\n   ${errorText.replace(/\n/g, ' ')}`
      : `✅ 全程 ${WATCH_SEC}s 未出现任何场景运行时错误`
  );
  console.log(monotonic.length ? `❌ 捕获到 inputRange 异常 ${monotonic.length} 条` : '✅ 没有 inputRange 相关异常');

  chrome.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(firstErrorAt ? 1 : 0);
}

main().catch((e) => {
  console.error('验证失败:', e.message);
  process.exit(1);
});
