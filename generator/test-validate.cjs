// generator/test-validate.cjs — 组件校验 + 确定性修复的离线测试（不联网、不消耗额度）
// 用法: node generator/test-validate.cjs
const { validateComponentCode, repairComponentImports, describeError } = require("./codegen.js");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// 一个「模型常犯的错」样本：用了 remotion API 但完全没写 remotion import
const MISSING_IMPORT = `
import React from "react";

export default function Scene1({ subtitle }: { subtitle: string }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const scale = spring({ frame, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill style={{ backgroundColor: "#111", opacity }}>
      <div style={{ transform: \`scale(\${scale})\`, fontSize: 64 }}>{subtitle}</div>
    </AbsoluteFill>
  );
}
`;

// 其它类型的问题仍然会被拦下（修复不掩盖真问题）
const BAD_EASING = `import { AbsoluteFill, interpolate, Easing, useCurrentFrame, useVideoConfig } from "remotion";
export default function S({ subtitle }: { subtitle: string }) {
  const f = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const o = interpolate(f, [0, 30], [0, 1], { easing: Easing.quint });
  const o2 = interpolate(f, [30, 60], [1, 0], { easing: Easing.cubic });
  return (
    <AbsoluteFill style={{ backgroundColor: "#0b0b12", opacity: o, justifyContent: "center", alignItems: "center" }}>
      <div style={{ opacity: o2, fontSize: 72, letterSpacing: 4, width: width * 0.8, height: height * 0.4 }}>{subtitle}</div>
      <span style={{ opacity: o2 * 0.6, fontSize: 24 }}>{String(fps)} fps</span>
    </AbsoluteFill>
  );
}
`;

// 作用域问题（tsc 才能发现）：标识符没定义
const UNDEFINED_NAME = `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
export default function T({ subtitle }: { subtitle: string }) {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const o = interpolate(f, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#101018", opacity: o, width: width * 0.5, height: height * 0.5 }}>
      <div style={{ fontSize: milestoneSize, color: "#fff", letterSpacing: 3 }}>{subtitle}</div>
    </AbsoluteFill>
  );
}
`;

const GOOD = `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
export default function G({ subtitle }: { subtitle: string }) {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const o = interpolate(f, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: "#0d0d12", opacity: o, width: width * 0.9, height: height * 0.6 }}>
      <div style={{ fontFamily: 'DIN', fontSize: 64, color: "#f5f5f7", letterSpacing: 2 }}>{subtitle}</div>
    </AbsoluteFill>
  );
}
`;

async function main() {
  // 1. 直接校验：应该报出漏 import（这正是用户看到的"未通过校验"的原因）
  //    注意：漏 import 还会连带触发 tsc 的"未定义标识符"报错，两类都算拦下
  const raw = await validateComponentCode("Scene1.tsx", MISSING_IMPORT, true, []);
  check("漏 import 会被校验拦下", raw.some((e) => /未从 remotion 导入/.test(e)), `${raw.length} 条，例如: ${raw[0]}`);

  // 2. 修复后应该全部通过
  const fixed = repairComponentImports("Scene1.tsx", MISSING_IMPORT);
  const after = await validateComponentCode("Scene1.tsx", fixed.code, true, []);
  check("补 import 后校验通过", after.length === 0, after.join(" | ") || "无错误");
  check(
    "补进去的正是用到的 API",
    ["AbsoluteFill", "useCurrentFrame", "useVideoConfig", "interpolate", "spring"].every((a) => fixed.code.includes(a)),
    fixed.code.split("\n").find((l) => l.includes("remotion")) || ""
  );

  // 3. 已有 remotion import 时是"合并"而不是再加一行
  const PARTIAL = `import { AbsoluteFill } from "remotion";\nimport React from "react";\nconst f = useCurrentFrame();\nexport default function X() { return <AbsoluteFill>{f}</AbsoluteFill>; }\n`;
  const merged = repairComponentImports("X.tsx", PARTIAL);
  check("已有 import 时合并而非重复添加", (merged.code.match(/from "remotion"/g) || []).length === 1, merged.code.split("\n")[0]);

  // 4. 不该凭空 import：完全没用 remotion API 的代码不应被加 import
  const noRemotion = `export const x = 1;\nexport default function X() { return null; }\n`;
  check("没用 remotion API 时不乱加 import", repairComponentImports("Y.tsx", noRemotion).added.length === 0);

  // 5. 其它类型的问题仍然会被拦下
  const eased = await validateComponentCode("S.tsx", BAD_EASING, true, []);
  check("臆造的 Easing.quint 仍被拦下", eased.some((e) => /不存在的 Easing/.test(e)), eased[0]);

  // 6. 作用域检查（tsc）仍然是异步真跑，而不是被拿掉
  const undef = await validateComponentCode("T.tsx", UNDEFINED_NAME, true, []);
  check("未定义标识符仍被拦下（tsc 检查没被弱化）", undef.some((e) => /未定义标识符 milestoneSize/.test(e)), undef[0]);

  // 7. 校验期间不得阻塞事件循环：否则并行的 LLM 流式响应会被卡住，
  //    还会把"我方 CPU 阻塞"算成网络超时误杀正常请求。
  const ticks = [];
  const iv = setInterval(() => ticks.push(Date.now()), 50);
  const t0 = Date.now();
  const ok = await validateComponentCode("G.tsx", GOOD, true, ["DIN"]);
  const dt = Date.now() - t0;
  clearInterval(iv);
  check("合法代码校验通过", ok.length === 0, ok.join(" | ") || "无错误");
  check(`校验期间事件循环没被阻塞（${dt}ms 内 tick ${ticks.length} 次）`, ticks.length >= 5, `期望 ≥5，实测 ${ticks.length}`);

  // 8. 报错信息保留完整原因（不再只留首行）
  const multi = new Error("Scene1.tsx 生成未通过校验:\n  缺少 export default\n  interpolate inputRange 必须严格递增");
  const flat = describeError(multi);
  check("多行校验原因不再被截断", /缺少 export default/.test(flat) && /inputRange/.test(flat), flat);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main();
