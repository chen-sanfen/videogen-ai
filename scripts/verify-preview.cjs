/* 预览稳定性验证：用本机 Chrome（headless）真实点开多个工程的「预览」按钮，
 * 检查换工程时页面是否会整页卸载（黑屏）、是否抛出 Remotion 音频标签错误、
 * 并把所有失败的资源请求 URL 打印出来（用于定位 ERR_NAME_NOT_RESOLVED）。
 *
 * 用法：node scripts/verify-preview.cjs [点击次数]
 */
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const APP = process.env.APP_URL || 'http://localhost:4175/';
const PORT = 9333;
const CLICKS = Number(process.argv[2] || 8);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (ev) => this._on(JSON.parse(ev.data));
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error'));
    });
    return new CDP(ws);
  }
  _on(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      return;
    }
    for (const fn of this.listeners) fn(msg);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-verify-'));
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
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let version = null;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        version = await r.json();
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!version) throw new Error('Chrome 未能在 10s 内启动 CDP');
  console.log('Chrome:', version['Browser']);

  const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' });
  const tab = await tabRes.json();
  const cdp = await CDP.connect(tab.webSocketDebuggerUrl);

  const exceptions = [];
  const consoleErrors = [];
  const failedRequests = [];
  const httpErrors = [];

  cdp.listeners.push((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(`[${msg.params.entry.source}] ${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
    } else if (msg.method === 'Network.loadingFailed') {
      failedRequests.push({ url: msg.params.requestId, err: msg.params.errorText, canceled: msg.params.canceled });
    } else if (msg.method === 'Network.requestWillBeSent') {
      const id = msg.params.requestId;
      pendingUrls.set(id, msg.params.request.url);
    } else if (msg.method === 'Network.responseReceived') {
      if (msg.params.response.status >= 400) httpErrors.push(`${msg.params.response.status} ${msg.params.response.url}`);
    }
  });
  const pendingUrls = new Map();

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');

  // 等应用把工程列表拉回来
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.eval(`document.querySelectorAll('.gen-pc-btn').length`);
    if (ready > 0) break;
    await sleep(300);
  }

  const total = await cdp.eval(`[...document.querySelectorAll('.gen-pc-btn')].filter(b=>b.textContent.trim()==='预览').length`);
  console.log(`可预览工程 ${total} 个，准备点击 ${Math.min(CLICKS, total)} 次\n`);

  if (process.env.SHOT) {
    await cdp.eval(`window.scrollTo(0,0)`);
    await sleep(600);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
    console.log('截图已保存:', process.env.SHOT, '\n');
  }

  const rounds = [];
  for (let i = 0; i < Math.min(CLICKS, total); i++) {
    const name = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('.gen-pc-btn')].filter(x=>x.textContent.trim()==='预览')[${i}];
      if (!b) return '';
      const card = b.closest('.gen-project-card');
      b.click();
      return card ? card.querySelector('.gen-pc-name').textContent : '';
    })()`);
    await sleep(5000); // 等模块导入 + 配音探活 + Player 挂载
    const state = await cdp.eval(`(() => {
      const root = document.getElementById('root');
      const player = document.querySelector('.gen-player');
      return {
        rootNodes: root ? root.querySelectorAll('*').length : 0,
        playerNodes: player ? player.querySelectorAll('*').length : 0,
        audioTags: document.querySelectorAll('audio').length,
        // Remotion 会预挂若干「静音占位」audio（data:audio/mp3），那些不算配音；只统计真正加载 wav 的
        audioWithSrc: [...document.querySelectorAll('audio')].filter((a) => {
          const s = a.getAttribute('src') || '';
          return s && !s.startsWith('data:');
        }).length,
        theme: document.documentElement.dataset.theme || '',
        brand: document.querySelector('.brand')?.textContent || '',
        playerError: document.querySelector('.gen-player-error')?.textContent?.slice(0, 160) || '',
        needTap: !!document.querySelector('.gen-player-tap'),
        status: [...document.querySelectorAll('.gen-preview-status')].map(s=>s.textContent).join(' | '),
      };
    })()`);
    rounds.push({ name, ...state });
    console.log(
      `#${i + 1} ${name.padEnd(30)} root节点=${String(state.rootNodes).padStart(5)} ` +
        `播放器节点=${String(state.playerNodes).padStart(5)} audio标签=${state.audioTags}` +
        (state.playerError ? ` ⚠️ ${state.playerError.replace(/\n/g, ' ')}` : '') +
        `  ${state.status}`
    );
  }

  console.log('\n================ 汇总 ================');
  const brand = rounds[0]?.brand || '';
  const theme = rounds[0]?.theme || '';
  console.log(`品牌文案: ${JSON.stringify(brand)}  主题: ${theme || '(未设置)'}`);
  const audioWithSrc = rounds.reduce((n, r) => n + (r.audioWithSrc || 0), 0);
  console.log(
    audioWithSrc === 0
      ? '✅ 没有任何 audio 加载真实音源（配音已下线；预挂的都是 Remotion 静音占位标签）'
      : `⚠️ 仍有 ${audioWithSrc} 个 audio 加载了音源`
  );

  // 黑白主题切换：点「白」→ 截首页 + 项目区
  if (process.env.SHOT_LIGHT) {
    await cdp.eval(`[...document.querySelectorAll('.theme-opt')].find(b=>b.textContent.includes('白'))?.click()`);
    await sleep(600);
    const t1 = await cdp.eval(`document.documentElement.dataset.theme`);
    const bg = await cdp.eval(`getComputedStyle(document.querySelector('.site-shell')).backgroundColor`);
    const pbg = await cdp.eval(`(() => { const el = document.querySelector('.gen-player'); return el ? getComputedStyle(el).backgroundColor : 'n/a'; })()`);
    console.log(`切到「白」后 dataset.theme=${t1}，页面背景=${bg}，播放器容器背景=${pbg}（应为 rgb(0, 0, 0)）`);

    await cdp.eval(`window.scrollTo(0,0)`);
    await sleep(600);
    const s1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.SHOT_LIGHT, Buffer.from(s1.data, 'base64'));

    await cdp.eval(`document.querySelector('.gen-projects')?.scrollIntoView({block:'start',behavior:'instant'}); window.scrollBy(0,-40)`);
    await sleep(600);
    const s2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const second = process.env.SHOT_LIGHT.replace(/\.png$/, '-projects.png');
    fs.writeFileSync(second, Buffer.from(s2.data, 'base64'));
    console.log(`浅色截图：${process.env.SHOT_LIGHT} / ${second}`);
  }
  if (process.env.SHOT2) {
    await cdp.eval(`document.querySelector('.gen-result')?.scrollIntoView({block:'start'}); window.scrollBy(0,-60)`);
    await sleep(600);
    const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.SHOT2, Buffer.from(shot2.data, 'base64'));
    console.log('播放器截图已保存:', process.env.SHOT2, '\n');
  }
  const blanked = rounds.filter((r) => r.rootNodes < 50);
  console.log(blanked.length ? `❌ 有 ${blanked.length} 次出现整页卸载（黑屏）：${blanked.map((b) => b.name).join(', ')}` : '✅ 没有出现整页卸载（无黑屏）');

  const audioErr = exceptions.filter((e) => /shared audio tags/i.test(e));
  console.log(audioErr.length ? `❌ 音频标签错误 ${audioErr.length} 次` : '✅ 没有 shared audio tags 报错');

  const failedUrls = failedRequests.map((f) => `${f.err} ${pendingUrls.get(f.url) || f.url}`);
  console.log(failedUrls.length ? `失败请求 ${failedUrls.length} 条：\n  - ` + [...new Set(failedUrls)].join('\n  - ') : '✅ 没有失败的资源请求');
  if (httpErrors.length) console.log(`HTTP >=400 响应 ${httpErrors.length} 条：\n  - ` + [...new Set(httpErrors)].slice(0, 10).join('\n  - '));
  if (exceptions.length) console.log(`\n未捕获异常 ${exceptions.length} 条：\n  - ` + [...new Set(exceptions.map((e) => e.split('\n')[0]))].slice(0, 8).join('\n  - '));
  if (consoleErrors.length) console.log(`\n控制台 error ${consoleErrors.length} 条：\n  - ` + [...new Set(consoleErrors)].slice(0, 8).join('\n  - '));

  chrome.kill();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error('验证脚本失败:', e);
  process.exit(1);
});
