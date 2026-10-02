import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const outputDir = fileURLToPath(new URL('../public-built', import.meta.url));

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  server: {
    // 不能用 'localhost'：Node 会把它解析成 ::1，只绑 IPv6 回环，
    // 走 127.0.0.1 的浏览器/工具/预览面板会直接连不上（表现为 502/无响应）。
    host: '127.0.0.1',
    port: 4175,
    strictPort: true,
    fs: {
      // 浏览器内预览要 import 生成工程里的分镜 TSX：
      // 工程目录在工作区根目录下（vite root 之外），必须放行，否则 /@fs 会被拦截。
      allow: [webRoot, projectRoot],
      strict: true,
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        // 生成 / 渲染可能跑十几分钟，别让代理把长连接掐断
        timeout: 0,
        proxyTimeout: 0,
        // 后端没起时，vite 自带的 error 处理会直接回一段 text/plain 500（见 vite/dist 里
        // `http proxy error` 那行）：前端 res.json() 解析不到，只剩「HTTP 500」，
        // 用户完全看不出是后端没启动。options.onError 在这里不会被调用（实测），
        // 只能用 configure 抢在 vite 注册监听器之前挂上自己的：我们先把响应写掉，
        // vite 那个处理器有 `!res.headersSent && !res.writableEnded` 判断，就不会覆盖。
        configure(proxy) {
          proxy.on('error', (_err, _req, res) => {
            // ws 代理时 res 是 Socket，没有 writeHead —— 用鸭子类型判断，别直接断言成 ServerResponse
            const r = res as unknown as {
              writeHead?: (code: number, headers: Record<string, string>) => void;
              end?: (body?: string) => void;
              headersSent?: boolean;
              writableEnded?: boolean;
            };
            if (typeof r?.writeHead !== 'function' || typeof r?.end !== 'function') return;
            if (r.headersSent || r.writableEnded) return;
            r.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
            r.end(
              JSON.stringify({
                error:
                  '后端服务未启动（http://127.0.0.1:3001 连不上）。请在项目目录另开一个终端运行 npm run server，再重试。',
                backendDown: true,
              })
            );
          });
        },
      },
      // Remotion Studio 不走这里：它跑在自己的端口上，iframe 直连。
      // 试过用 /studio/* 子路径代理，但 Studio 页面里引用的是 /bundle.js 这类绝对路径，
      // 挂到子路径下会去站点根找资源 → 静态资源 404 → 编辑层白屏。
    },
  },
  build: { outDir: outputDir, emptyOutDir: true },
});
