# Remotion 动画工程

## 1. 安装依赖

```cmd
cd /d <项目目录>
npm install
```

## 2. 生成中文配音

```cmd
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\generate-voice.ps1
```

## 3. 预览

```cmd
npm run studio
```

在 Remotion Studio 中选择 Composition 查看动画。

## 4. 渲染 MP4

```cmd
npm run render
```

输出到 `out/film.mp4`。

## 5. 导出关键帧

```cmd
npm run still
```

输出到 `out/film.png`。

## 配置

修改 `film.config.json` 调整场景、元素、文案、主题色和旁白，然后重新渲染。

## Windows 注意事项

所有 npm 和 remotion 命令请使用 `cd /d 盘符路径` 模式运行，避免 UNC 路径限制。
