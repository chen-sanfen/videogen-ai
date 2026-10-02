/**
 * 回归：素材可见性门槛在真实工程上是否照预期工作。
 *
 * 用 codegen 导出的 measureAssetVisibility() 直接跑一个已有工程，
 * 打印每个分镜的采样点明细，验证：
 *   1) 采样帧不越界（真实 composition 帧数 vs 内存 timeline 可能对不上）
 *   2) 能正确挑出"素材没露出来"的分镜，返回值结构符合主流程的预期
 *
 * 用法：node scripts/verify-gate.cjs <工程名>
 */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const project = process.argv[2];
const projectDir = path.join(ROOT, project || "");
if (!fs.existsSync(path.join(projectDir, "film.config.json"))) {
  console.error("用法: node scripts/verify-gate.cjs <工程名>");
  process.exit(1);
}

// 和生成流程用的是同一份代码，不是复制的副本
const { measureAssetVisibility } = require(path.join(ROOT, "generator", "codegen.js"));

const cfg = JSON.parse(fs.readFileSync(path.join(projectDir, "film.config.json"), "utf8"));

// 复刻 codegen 的 computeTimeline（分镜之间是带 overlap 重叠的），
// 拿到和生成时一致的 { from, durationInFrames }
const timeline = (() => {
  let cursor = 0;
  return cfg.scenes.map((s, i) => {
    const from = i === 0 ? 0 : cursor - (cfg.scenes[i - 1].overlap || 0);
    cursor = from + s.durationInFrames;
    return { name: s.name, from, durationInFrames: s.durationInFrames };
  });
})();
const manifest = {
  id: cfg.id,
  scenes: cfg.scenes.map((s, i) => ({
    name: s.name,
    file: `src/scenes/Scene${i + 1}.tsx`,
    durationInFrames: s.durationInFrames,
    subtitle: s.subtitle,
  })),
};

console.log(`工程: ${project}  分镜 ${cfg.scenes.length} 个`);
console.log(
  "  timeline: " + timeline.map((t) => `${t.name}@${t.from}+${t.durationInFrames}`).join(", ")
);

(async () => {
  const measured = await measureAssetVisibility(projectDir, manifest, timeline);
  if (!measured || !measured.length) {
    console.log("没有任何组件引用素材 —— 门槛无事可做（校验器应已拦过）。");
    return;
  }
  // 与生成主流程里的门槛保持一致
  const THRESHOLD = 0.02;
  let bad = 0;
  for (const m of measured) {
    const ok = m.ratio >= THRESHOLD;
    if (!ok) bad += 1;
    console.log(
      `  S${m.sceneIndex + 1}: ${(m.perFrame || []).map((f) => `@${f.frame} ${(f.ratio * 100).toFixed(1)}%`).join(" · ")}` +
        `  → 最好 ${(m.ratio * 100).toFixed(1)}%  ${ok ? "✓ 通过" : "✗ 不通过（会被送去重写）"}`
    );
  }
  console.log(bad ? `\n❌ ${bad} 个分镜会被判定为「素材看不见」，触发重写` : "\n✅ 全部分镜素材可见");
  process.exitCode = bad ? 1 : 0;
})().catch((e) => {
  console.error("门槛执行失败:", String((e && e.message) || e).slice(0, 400));
  process.exitCode = 4;
});
