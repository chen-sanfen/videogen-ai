# Promix · AI 视频生成平台

基于 **Remotion + React 19 + Vite + Express** 的 AI 视频生成平台。用户给出产品 / 主题与素材（图片 / 视频 / 网页 URL），平台通过 LLM 规划分镜、生成每镜的视觉组件与字幕 / 配音文案，并在浏览器内实时预览；支持素材 AI 重绘、AI 优化描述、可选配音与配乐，以及内嵌 Remotion Studio 编辑。

> 本项目为原创生成管线，不抓取或复用任何第三方官网的图片 / 源码 / 具体页面素材。

## 特性

- **AI 分镜规划与组件生成**：LLM 产出分镜结构，逐镜生成 Remotion 视觉组件。
- **素材采集**：抓取网页 / 图片 / 视频作为生成素材，支持 URL 输入与勾选入项。
- **素材三态**：`reference`（参考气质）/ `direct`（原样直用）/ `redraw`（AI 重绘）——重绘会提取画面核心元素再生成更贴合视频风格的新图。
- **AI 优化描述**：依据素材的视觉特征（颜色 / 材质 / 构图 / 光影 / 留白）生成提示词，忠实不编造品类。
- **字幕 + 配音**：文案风格多样化、随内容变化，并与画面调性协调呼应。
- **浏览器内预览**：通过 `@remotion/player` 在页面里实时渲染播放，无需等待导出。
- **可选配音与配乐**：神经语音 TTS 合成逐句配音 + 程序化 BGM。
- **Studio 编辑**：内嵌 Remotion Studio 子进程，编辑已生成的工程并重新出片（仅限平台工程，禁止本地上传）。

## 技术栈

- 渲染：Remotion 4 + React 19
- 前端：Vite + TypeScript（`@remotion/player` 用于预览）
- 后端：Express（`web/server.mjs`，提供生成 API 与可选渲染导出）
- 生成管线：`generator/` 下的规划、codegen、素材重绘、配音合成

## 快速开始

```bash
npm install

# 终端 A：启动后端
npm run server

# 终端 B：启动前端
npm run web:dev
```

打开 `http://127.0.0.1:4175`（前端 Vite 绑定 `127.0.0.1`，用 `localhost` 可能连不上）。

常用脚本（`package.json`）：

| 脚本 | 说明 |
| --- | --- |
| `npm run server` | 启动后端 API（默认不含 MP4 渲染导出） |
| `npm run web:dev` | 启动前端开发服务器 |
| `npm run dev` | 同时启动后端 + 前端 |
| `npm run ai-generate` | 通过生成管线产出工程 |
| `npm run studio` | 打开 Remotion Studio |
| `npm run web:build` | 类型检查 + 前端构建 |

## 目录结构

```
web/            前端与后端 API（Generator.tsx、server.mjs、vite 配置）
generator/      生成管线（规划、codegen、素材重绘 asset-redraw、配音 voice、schema）
src/            Remotion 合成根（Root.tsx、compositions）
scripts/        测试与调试脚本
public/         静态资源
promix-online/  线上部署用的干净副本（由源码构建，不纳入版本库）
```

## 导出视频

线上托管的**预览版不含 MP4 渲染导出**（托管沙箱未预装 `ffmpeg` / `Chromium`）。要在本机导出：

```bash
# 后端开启渲染开关
ENABLE_RENDER=true npm run server
```

在前端生成完成后点「导出」，成品落到：

```
<工程名>/out/film.mp4
```

> 本机需已安装 Chromium（Remotion 渲染依赖）与 `ffmpeg`。

## 关于线上版本

公开预览版（如 WorkBuddy 托管实例）仅提供「AI 生成 + 浏览器内预览」。要获得可保存 / 下载的成片，需要在具备渲染环境的本机或自托管服务器完成导出。

## License

[MIT](./LICENSE)
