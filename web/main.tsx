import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Generator } from './Generator';

type Page = 'generator' | 'studio';
type Theme = 'dark' | 'light';
// 除了黑白，还有第三档「自动」= 跟随系统。没手动选过就是 auto。
type ThemeMode = Theme | 'auto';

// 黑白主题：写在 <html data-theme> 上，CSS 里用 [data-theme="light"] 覆盖配色。
// 初始值由 index.html 的内联脚本先行写入（避免刷新时先闪一下深色再变白）。
const THEME_KEY = 'promix-theme';
const DARK_MQ = '(prefers-color-scheme: dark)';
// 浏览器地址栏 / 移动端状态栏的底色，跟着主题走
const THEME_META_COLOR: Record<Theme, string> = { dark: '#08090d', light: '#f4f5f9' };

function systemTheme(): Theme {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia(DARK_MQ).matches ? 'dark' : 'light';
  }
  return 'dark';
}

function readThemeMode(): ThemeMode {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    // 隐私模式读不到，按「自动」处理
  }
  return 'auto';
}

// 顶层兜底：任何未捕获的渲染错误都不该把整页变成黑屏（之前 Remotion 的音频标签校验
// 一抛错就会卸载整个根节点）。这里退化成一张可读的错误卡片 + 刷新按钮。
class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[app] 未捕获的渲染错误：', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-crash">
          <h1>页面出了点问题</h1>
          <p className="app-crash-msg">{this.state.error.message}</p>
          <div className="app-crash-actions">
            <button className="app-crash-btn" onClick={() => this.setState({ error: null })}>
              重试渲染
            </button>
            <button className="app-crash-btn ghost" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
          <p className="app-crash-hint">已生成的工程不会丢失，刷新后即可继续预览 / 导出。</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [page, setPage] = useState<Page>('generator');
  // 每次点「Studio 预览」都 +1，用于通知 Generator 跳到「已生成项目」区
  const [projectsJump, setProjectsJump] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>(readThemeMode);
  // 系统深浅色的实时结果，只在「自动」档下参与运算
  const [systemPref, setSystemPref] = useState<Theme>(systemTheme);
  const themeAnimTimer = useRef(0);
  // 顶栏吸顶后要给通栏背景和阴影，否则内容从透明条下面穿过去会糊在一起
  const [stuck, setStuck] = useState(false);
  // auto 以外的档位写死，auto 时听系统的
  const theme: Theme = themeMode === 'auto' ? systemPref : themeMode;

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // 系统深浅色变化时实时跟进（只在「自动」档生效）
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DARK_MQ);
    const onChange = (e: MediaQueryListEvent) => setSystemPref(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => () => window.clearTimeout(themeAnimTimer.current), []);

  // 应用主题：记住用户选的档位，落到 <html data-theme> 上
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme !== theme) {
      // 黑白之间是硬跳，加一次性过渡类让颜色平滑过去
      root.classList.add('theme-anim');
      window.clearTimeout(themeAnimTimer.current);
      themeAnimTimer.current = window.setTimeout(() => root.classList.remove('theme-anim'), 320);
    }
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_META_COLOR[theme]);
  }, [theme]);

  // 存的是档位（auto / dark / light）而不是结果，这样「自动」不会因为系统换过一次就丢
  const applyTheme = useCallback((next: ThemeMode) => {
    setThemeMode(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // 隐私模式下写不了，忽略
    }
  }, []);

  const goGenerator = () => {
    setPage('generator');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const goStudio = () => {
    setPage('studio');
    setProjectsJump((n) => n + 1);
  };

  return (
    <div className="site-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <a className="skip-link" href="#top">跳到主内容</a>
      <div className={`topbar-bar ${stuck ? 'is-stuck' : ''}`}>
        <header className="topbar">
          <a className="brand" href="#top" aria-label="Promix 首页" onClick={(e) => { e.preventDefault(); goGenerator(); }}>
            <span className="brand-mark">⌁</span>
            <span>Promix</span>
          </a>
          <nav className="topnav" aria-label="Primary navigation">
            <a
              href="#generator"
              className={page === 'generator' ? 'nav-active' : ''}
              aria-current={page === 'generator' ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); goGenerator(); }}
            >AI 生成器</a>
            <a
              href="#projects"
              className={page === 'studio' ? 'nav-active' : ''}
              aria-current={page === 'studio' ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); goStudio(); }}
            >Studio 预览</a>
          </nav>
          <div className="topbar-tools">
            {/* 黑白主题切换：默认跟随系统，手动选过就以手动为准 */}
            <div className="theme-switch" role="group" aria-label="黑白主题">
              <button
                type="button"
                className={`theme-opt ${themeMode === 'auto' ? 'active' : ''}`}
                onClick={() => applyTheme('auto')}
                aria-pressed={themeMode === 'auto'}
                title={`跟随系统：大概率是${systemPref === 'dark' ? '深色' : '浅色'}，随系统设置变化`}
              >
                <span className="theme-opt-ic theme-opt-ic-auto" aria-hidden="true" />
                自动
              </button>
              <button
                type="button"
                className={`theme-opt ${themeMode === 'dark' ? 'active' : ''}`}
                onClick={() => applyTheme('dark')}
                aria-pressed={themeMode === 'dark'}
                title="黑色主题"
              >
                <span className="theme-opt-ic">●</span>黑
              </button>
              <button
                type="button"
                className={`theme-opt ${themeMode === 'light' ? 'active' : ''}`}
                onClick={() => applyTheme('light')}
                aria-pressed={themeMode === 'light'}
                title="白色主题"
              >
                <span className="theme-opt-ic">○</span>白
              </button>
            </div>
            <div className="top-status">
              <span className="live-dot" /> local preview <span className="status-divider" /> v0.3
            </div>
          </div>
        </header>
      </div>

      <main id="top" tabIndex={-1}>
        <Generator jumpToProjects={projectsJump} />
      </main>

      <footer className="footer">
        <span>PROMIX</span>
        <span>Promix · AI Video Generator</span>
        <span>2026</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
