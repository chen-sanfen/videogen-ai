/**
 * 用「渲染比对」判断素材是否真的出现在画面里。
 *
 * 原理（这是唯一能证明"用户的东西确实进了画面"的办法）：
 *   1) 把工程打包，给每个分镜渲染一帧 → A
 *   2) 把组件里的 staticFile("assets/xxx") 换成一个全透明占位图，重新打包，
 *      在同样的帧上再渲染一次 → B
 *   3) 比对 A / B 的像素：如果两者几乎一模一样，说明这个分镜里素材根本没露出来
 *      （被盖住 / 透明度 0 / 尺寸为 0 / 移出画面 / 藏在 foreignObject 里……）。
 *
 * 用法：node scripts/verify-asset-visible.cjs <工程名> [帧偏移]
 */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const { decodePng, diffRatio } = require("./lib-png-diff.cjs");

const project = process.argv[2];
const frameOffset = Number(process.argv[3] || 0);
const projectDir = path.join(ROOT, project);
if (!fs.existsSync(projectDir)) {
  console.error("工程不存在:", project);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, "film.config.json"), "utf8"));
const assets = cfg.assets || [];
if (!assets.length) {
  console.log("该工程没有记录素材，跳过。");
  process.exit(0);
}
const BLANK = "__blank.png";
// 1x1 全透明 PNG
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const assetsDir = path.join(projectDir, "public", "assets");
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, BLANK), BLANK_PNG);

// 找到所有用到素材的组件文件
const sceneDir = path.join(projectDir, "src", "scenes");
// 判定用不带 g 的正则：带 g 的 .test() 有状态，会在 filter 过程中漏掉文件
const files = fs
  .existsSync(sceneDir)
  ? fs.readdirSync(sceneDir).filter((f) =>
      f.endsWith(".tsx") && /staticFile\s*\(\s*["'`]assets\//.test(fs.readFileSync(path.join(sceneDir, f), "utf8"))
    )
  : [];
console.log("将参与比对的分镜文件:", files.join(", ") || "(无)");
if (!files.length) {
  console.log("没有任何组件引用 assets/ —— 素材压根没进代码，也不需要渲染比对。");
  process.exit(2);
}
const RE = /(staticFile\s*\(\s*["'`])assets\/[^"'`]+(["'`]\s*\))/g;
// 原文只放内存，不落 .bak 文件：落盘就得清理，而清理会撞上环境的批量删除保护闸。
// 备份必须在内存里，且还原只能用「内存里的原文」——
// 若拿当前内容兜圈，把空白版当原文再 swap 一次，真实文件名就永久丢了（真丢过一次）。
const originals = new Map(files.map((f) => [path.join(sceneDir, f), fs.readFileSync(path.join(sceneDir, f), "utf8")]));
const backups = [...originals.keys()];
// 进程非正常退出时也要把源码还原，否则工程里会残留 asset = __blank.png
process.on("exit", () => {
  for (const [p, code] of originals) {
    try {
      fs.writeFileSync(p, code);
    } catch {}
  }
});
const swap = (dir) => {
  for (const p of backups) {
    const original = originals.get(p);
    fs.writeFileSync(p, dir === "blank" ? original.replace(RE, `$1assets/${BLANK}$2`) : original);
  }
};

(async () => {
  const { bundle } = require("@remotion/bundler");
  const { selectComposition, renderStill } = require("@remotion/renderer");
  const entry = path.join(projectDir, "src", "index.ts");
  const outDir = path.join(projectDir, "out");
  fs.mkdirSync(outDir, { recursive: true });

  let frames = null;
  try {
    // 关掉 webpack 文件系统缓存，确保两次打包真的各编译一遍，不会复用上一次的产物。
    // 但**不要**传 outDir：默认每次新建唯一临时目录，publicDir 拷到包根目录，staticFile 才取得到；
    // 指定 outDir 会让 publicDir 落到 <outDir>/public/ 下，/assets/x 直接 404，比对结果全假。
    const publicDir = path.join(projectDir, "public");
    const bundleVariant = () => bundle({ entryPoint: entry, publicDir, enableCaching: false });

    // ---- 变体 B：素材换成透明图 ----
    swap("blank");
    let serveUrl = await bundleVariant();
    let comp;
    try {
      comp = await selectComposition({ serveUrl, id: cfg.id, inputProps: {} });
    } catch (e) {
      console.log("素材缺失版无法取到 composition:", String(e.message).slice(0, 200));
      process.exit(3);
    }
    // 采样点要避开入场动画：分镜首帧常常还是 opacity:0 / width:0，
    // 拿首帧去比会得出"素材完全看不见"的假结论。取分镜内 15% / 45% / 75% 三个点。
    // 绝对帧必须以 composition 真实总帧数为上限来折算。
    // film.config.json 里的场景时长可能已经过期（这份配置算出 265 帧，真实只有 240 帧），
    // 直接按配置累加会算出越界帧号。这里把「配置里的时间轴」按比例映射到真实时间轴。
    const cfgTotal = cfg.scenes.reduce((a, s) => a + s.durationInFrames, 0) || 1;
    const scale = comp.durationInFrames / cfgTotal;
    const shots = [];
    let cum = 0;
    cfg.scenes.forEach((s, i) => {
      const start = cum * scale;
      cum += s.durationInFrames;
      const dur = s.durationInFrames * scale;
      for (const r of [0.15, 0.45, 0.75]) {
        const rel = Math.min(Math.floor(dur * r), Math.max(0, Math.ceil(dur) - 1));
        shots.push({ i, frame: Math.min(Math.floor(start + rel), comp.durationInFrames - 1) });
      }
    });
    // 临时帧放在独立目录里，不逐张删除（会撞环境的批量删除保护闸），下次运行直接覆盖
    const tmpDir = path.join(outDir, ".vis");
    fs.mkdirSync(tmpDir, { recursive: true });
    const bPaths = [];
    for (let k = 0; k < shots.length; k++) {
      const p = path.join(tmpDir, `b_${shots[k].i}_${shots[k].frame}.png`);
      await renderStill({ serveUrl, composition: comp, frame: shots[k].frame, output: p, imageFormat: "png", inputProps: {} });
      bPaths.push(p);
    }

    // ---- 变体 A：正常素材 ----
    swap("real");
    serveUrl = await bundleVariant();
    comp = await selectComposition({ serveUrl, id: cfg.id, inputProps: {} });
    const byScene = cfg.scenes.map(() => []);
    for (let k = 0; k < shots.length; k++) {
      const { i, frame } = shots[k];
      const p = path.join(tmpDir, `a_${i}_${frame}.png`);
      await renderStill({ serveUrl, composition: comp, frame, output: p, imageFormat: "png", inputProps: {} });
      const { ratio, avgDelta } = diffRatio(decodePng(fs.readFileSync(p)), decodePng(fs.readFileSync(bPaths[k])));
      byScene[i].push({ frame, ratio, avgDelta });
    }
    let bad = 0;
    for (let i = 0; i < cfg.scenes.length; i++) {
      const list = byScene[i];
      const best = list.reduce((m, x) => (x.ratio > m.ratio ? x : m), list[0]);
      const ok = best.ratio >= 0.02; // 与生成主流程的门槛保持一致
      if (!ok) bad += 1;
      console.log(
        `  场景${i + 1}: ${list.map((f) => `@${f.frame} ${(f.ratio * 100).toFixed(1)}%`).join(" · ")}  ` +
          `→ 最好 ${(best.ratio * 100).toFixed(1)}% 色差${best.avgDelta.toFixed(1)}  ${ok ? "✓ 露出来了" : "✗ 几乎看不见"}`
      );
    }
    console.log(bad ? `\n❌ 有 ${bad}/${cfg.scenes.length} 个分镜里素材基本没露出` : "\n✅ 每个分镜都能看到素材的改变");
    return bad ? 1 : 0; // 用 return 交给外层 process.exitCode，避免提前 exit 打乱还原
  } finally {
    swap("real");
    // 旧的 .bak 不再删（删除受环境保护闸限制），改成写入"已作废"占位，避免被误当成源码
    for (const p of backups) {
      const b = p + ".bak";
      if (fs.existsSync(b)) fs.writeFileSync(b, `// 已作废：${path.basename(p)} 的原始内容已在运行内存中备份，此文件不再更新。\n`);
    }
  }
})()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error("渲染比对失败:", String(e && e.message || e).slice(0, 400));
    process.exitCode = 4;
  });
