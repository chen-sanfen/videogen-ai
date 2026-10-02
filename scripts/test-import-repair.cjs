#!/usr/bin/env node
// 回归测试：重复 import 标识符（vite: Identifier 'x' has already been declared）
//
// 现场故障：AI 把 interpolate 单独写成第二条 `from "remotion"` 的 import（本身合法），
// 而「补 remotion import」只读第一条，于是把 interpolate 补进第一条 → 同名声明两份；
// 接着 routeInterpolateToSafe 又把第一条的摘到 safeInterp，第二条永久残留：
//     import { interpolate } from "../safeInterp";
//     import { interpolate } from "remotion";     ← 整页白屏
//
// 用法：node scripts/test-import-repair.cjs      （不发网络请求、不消耗 LLM 额度）
const assert = require("node:assert");
const {
  routeInterpolateToSafe,
  dedupeImports,
  stripNamesFromModule,
  repairComponentImports,
  validateComponentCode,
  preAssemblyView,
  dropShadowedApiDeclarations,
} = require("../generator/codegen.js");

// 用 Babel 判定能否编译（必须 Babel：esbuild 会静默放过重复声明）
function babelError(code, file) {
  try {
    require("@babel/core").transformSync(code, {
      filename: file, babelrc: false, configFile: false, code: false, ast: false,
      sourceMaps: false, sourceType: "module",
      parserOpts: { plugins: ["typescript", "jsx"], sourceType: "module" },
    });
    return null;
  } catch (e) {
    return String(e.message || e).split("\n")[0].trim();
  }
}

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    const detail = String(e.message).replace(/\n/g, "\n      ").slice(0, 500);
    console.log(`  ✗ ${name}\n      ${detail}`);
  }
}

// 取出代码里所有 import 声明的本地标识符，返回重复的那些
function dupNames(code) {
  const seen = new Set();
  const dup = [];
  for (const m of code.matchAll(/^[ \t]*import\s+([^;]*?)\s+from\s*["']([^"']+)["']/gm)) {
    const names = [];
    const b = m[1].match(/\{([\s\S]*)\}/);
    if (b) for (const s of b[1].split(",")) {
      const x = s.trim();
      if (x) names.push(x.split(/\s+as\s+/).pop().trim());
    }
    const head = m[1].replace(/\{[\s\S]*\}/, "").replace(/,\s*$/, "").trim();
    if (head) names.push(head.split(/\s+as\s+/).pop().trim());
    for (const n of names) {
      if (seen.has(n)) dup.push(n);
      else seen.add(n);
    }
  }
  return dup;
}

const BODY = `
const rnd = (i) => Math.abs(Math.sin(i * 127.1)) % 1;
export default function Scene2({ subtitle }: { subtitle: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = interpolate(frame, [0, 30], [0, 1]);
  const b = interpolateColors(frame, [0, 30], ["#000", "#fff"]);
  return <AbsoluteFill>{subtitle}{a}{b}</AbsoluteFill>;
}
`;

console.log("\n【1】AI 写两条 remotion import（故障现场原型）");
const aiTwoImports = `import React from "react";
import { AbsoluteFill, Easing, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate, interpolateColors } from "remotion";
${BODY}`;

t("归一化后无重复标识符", () => {
  const r = routeInterpolateToSafe("src/scenes/Scene2.tsx", aiTwoImports);
  assert.deepStrictEqual(dupNames(r.code), [], `仍有重复: ${dupNames(r.code)}`);
});
t("只保留一条 remotion import", () => {
  const r = routeInterpolateToSafe("src/scenes/Scene2.tsx", aiTwoImports);
  const n = (r.code.match(/from\s*["']remotion["']/g) || []).length;
  assert.strictEqual(n, 1, `remotion import 有 ${n} 条`);
});
t("interpolate 只从 safeInterp 导入，且路径层级正确", () => {
  const r = routeInterpolateToSafe("src/scenes/Scene2.tsx", aiTwoImports);
  assert.match(r.code, /import \{ interpolate, interpolateColors \} from "\.\.\/safeInterp";/);
  assert.ok(!/from "remotion"[^\n]*interpolate/.test(r.code), "remotion 行里还留着 interpolate");
});

console.log("\n【2】修复函数本身不再制造重复");
t("repairComponentImports 对两条 remotion import 不产生重复", () => {
  const r = repairComponentImports("Scene2.tsx", aiTwoImports);
  assert.deepStrictEqual(dupNames(r.code), [], `仍有重复: ${dupNames(r.code)}`);
});
t("修饰 + 归一化整条链路后，interpolate 只来自 safeInterp", () => {
  // 这份代码的身体用到了没导入的 useVideoConfig 与 interpolate
  const code = `import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { interpolate } from "remotion";
${BODY}`;
  const repaired = repairComponentImports("Scene2.tsx", code);
  // 补 import 阶段：useVideoConfig 被补上，且不产生重复
  assert.deepStrictEqual(dupNames(repaired.code), [], `补 import 后重复: ${dupNames(repaired.code)}`);
  assert.match(repaired.code, /useVideoConfig/);
  // 归一化阶段：interpolate 从 remotion 摘走
  const routed = routeInterpolateToSafe("src/scenes/Scene2.tsx", repaired.code);
  assert.deepStrictEqual(dupNames(routed.code), [], `归一化后重复: ${dupNames(routed.code)}`);
  assert.ok(!/from "remotion"[^\n]*\binterpolate\b/.test(routed.code), "remotion 行里还留着 interpolate");
  assert.match(routed.code, /from "\.\.\/safeInterp"/);
});

console.log("\n【3】自愈：磁盘上已经坏掉的装配形态");
const broken = `import React from "react";
import { AbsoluteFill, Easing, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate } from "../safeInterp";
import { interpolate } from "remotion";
${BODY}`;
t("safeInterp + remotion 重复时会被清掉 remotion 那份", () => {
  const r = routeInterpolateToSafe("src/scenes/Scene2.tsx", broken);
  assert.deepStrictEqual(dupNames(r.code), [], `仍有重复: ${dupNames(r.code)}`);
  assert.ok(!/from "remotion"[^\n]*\binterpolate\b/.test(r.code), "remotion 行里还留着 interpolate");
  assert.match(r.code, /from "\.\.\/safeInterp"/);
});

console.log("\n【4】幂等与路径层级");
t("连续归一化两次结果一致", () => {
  const once = routeInterpolateToSafe("src/scenes/Scene2.tsx", aiTwoImports).code;
  const twice = routeInterpolateToSafe("src/scenes/Scene2.tsx", once).code;
  assert.strictEqual(twice, once, "第二次归一化改变了内容（非幂等）");
});
t("Backdrop（src/ 一层）用 ./safeInterp", () => {
  const r = routeInterpolateToSafe("src/Backdrop.tsx", aiTwoImports);
  assert.match(r.code, /from "\.\/safeInterp"/);
  assert.deepStrictEqual(dupNames(r.code), []);
});
t("路径写错时会被纠正", () => {
  const wrong = `import React from "react";
import { AbsoluteFill, Easing, Img, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate, interpolateColors } from "../../safeInterp";
${BODY}`;
  const r = routeInterpolateToSafe("src/scenes/Scene2.tsx", wrong);
  assert.deepStrictEqual(r.pathFixed, "../../safeInterp");
  assert.match(r.code, /from "\.\.\/safeInterp"/);
  assert.deepStrictEqual(dupNames(r.code), []);
});

console.log("\n【5】不该乱动的情况");
t("同模块两个不同默认导入 → 放弃合并，保持原样", () => {
  const code = `import A from "remotion";\nimport B from "remotion";\nconst x = A;\n`;
  const r = dedupeImports(code);
  assert.deepStrictEqual(r.merged, []);
  assert.strictEqual(r.code, code);
});
t("import type 存在时整体跳过合并", () => {
  const code = `import type { X } from "remotion";\nimport { Y } from "remotion";\n`;
  const r = dedupeImports(code);
  assert.strictEqual(r.code, code);
});
t("react 默认导入 + 命名导入会被合并成一行", () => {
  const code = `import React from "react";\nimport { useState } from "react";\n`;
  const r = dedupeImports(code);
  assert.strictEqual(r.code, `import React, { useState } from "react";\n`);
});
t("同名重复按本地名去重", () => {
  const code = `import { interpolate } from "remotion";\nimport { interpolate } from "remotion";\n`;
  const r = dedupeImports(code);
  assert.strictEqual(r.code, `import { interpolate } from "remotion";\n`);
});
t("X as Y 别名按「本地名」判断，不与原名混为一谈", () => {
  const code = `import { interpolate as safeI } from "remotion";\nimport { interpolateColors } from "remotion";\n`;
  const r = dedupeImports(code);
  assert.strictEqual(r.code, `import { interpolate as safeI, interpolateColors } from "remotion";\n`);
  assert.deepStrictEqual(dupNames(r.code), []);
});
t("stripNamesFromModule 摘空时整行删除，保留默认导入", () => {
  const one = stripNamesFromModule(`import React, { interpolate } from "remotion";\n`, "remotion", ["interpolate"]);
  assert.strictEqual(one.code, `import React from "remotion";\n`);
  const two = stripNamesFromModule(`import { interpolate } from "remotion";\nconst a = 1;\n`, "remotion", ["interpolate"]);
  assert.strictEqual(two.code, "const a = 1;\n");
});

console.log("\n【7】自造声明与 import 撞名（第二类重复）");
const shim = `import React from "react";
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig, spring } from "remotion";
import { interpolate } from "../safeInterp";
${BODY}
// ↓ AI 常把整套 API 在文件末尾自造一遍当"兜底"，与 import 撞名 → Duplicate declaration
function useCurrentFrame() { return (window as any).__remotion_frame ?? 0; }
function useVideoConfig() { return { fps: 30, durationInFrames: 120, width: 1920, height: 1080 }; }
const spring = ({ frame, fps, config }: any) => 1;
const Easing = { quad: (x: number) => x * x };
function interpolate(frame: number, input: any, output: any) { return 0; }
const AbsoluteFill = ({ children }: any) => <div>{children}</div>;
`;
t("6 个自造声明全部定位到", () => {
  const r = dropShadowedApiDeclarations("Scene5.tsx", shim);
  assert.strictEqual(r.removed.length, 6, `只识别到 ${r.removed.length} 个: ${r.removed.join("; ")}`);
});
t("撞名的自造声明被删干净，import 全部保留", () => {
  const r = dropShadowedApiDeclarations("Scene5.tsx", shim);
  assert.ok(!/function useCurrentFrame/.test(r.code), "useCurrentFrame shim 还在");
  assert.ok(!/const Easing =/.test(r.code), "Easing shim 还在");
  assert.ok(!/function interpolate/.test(r.code), "interpolate shim 还在");
  assert.match(r.code, /import \{ AbsoluteFill, Easing, useCurrentFrame, useVideoConfig, spring \} from "remotion";/);
  assert.match(r.code, /import \{ interpolate \} from "\.\.\/safeInterp";/);
});
t("函数体内同名局部变量不受影响（只动顶层）", () => {
  const code = `import { interpolate } from "../safeInterp";
const ease = (t: number) => {
  const interpolate = (x: number) => x * 2;   // 局部变量，合法
  return interpolate(t);
};
export default function S() { return <div>{ease(1)}</div>; }
`;
  const r = dropShadowedApiDeclarations("S.tsx", code);
  assert.deepStrictEqual(r.removed, []);
  assert.strictEqual(r.code, code);
});
t("不撞名的顶层声明保持不动", () => {
  const code = `import { interpolate } from "../safeInterp";
const PALETTE = ["#fff"];
function helper(x: number) { return x; }
export default function S() { return <div>{helper(1)}{PALETTE[0]}</div>; }
`;
  const r = dropShadowedApiDeclarations("S.tsx", code);
  assert.deepStrictEqual(r.removed, []);
  assert.strictEqual(r.code, code);
});
t("幂等：清理后再次调用不再改动", () => {
  const once = dropShadowedApiDeclarations("Scene5.tsx", shim).code;
  const twice = dropShadowedApiDeclarations("Scene5.tsx", once);
  assert.deepStrictEqual(twice.removed, []);
  assert.strictEqual(twice.code, once);
});
t("经 repairComponentImports 后 Babel 能编译", () => {
  const r = repairComponentImports("Scene5.tsx", shim);
  const err = babelError(r.code, "Scene5.tsx");
  assert.strictEqual(err, null, `Babel 仍报错: ${err}`);
});

// 【6】需要真的跑一次 tsc：确认校验器能拦住重复声明（net）
// 注意 validateComponentCode 有 400 字节的下限，代码要写得够完整
const LONG_PAD = `
const PALETTE = ["#0d0d12", "#f5f5f7", "#8a8a93", "#4b4b55"];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (t: number) => t * t * (3 - 2 * t);
`;
(async () => {
  console.log("\n【6】校验器能否拦住重复标识符（调 tsc，稍慢）");
  const dupCode = `import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate } from "../safeInterp";
${LONG_PAD}
export default function S({ subtitle }: { subtitle: string }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = clamp01(ease(frame / fps));
  const x = interpolate(t, [0, 1], [0, width]);
  return <AbsoluteFill style={{ backgroundColor: PALETTE[0], transform: \`translateX(\${x}px)\` }}>{subtitle}</AbsoluteFill>;
}
`;
  const errs = await validateComponentCode("Dup.tsx", dupCode, true, [], false, [], true);
  t("重复声明被报为校验错误", () => {
    assert.ok(
      errs.some((e) => /重复声明了标识符 interpolate/.test(e)),
      `没有报重复声明，实际错误: ${JSON.stringify(errs)}`
    );
  });
  const okCode = `import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { interpolate } from "../safeInterp";
${LONG_PAD}
export default function S({ subtitle }: { subtitle: string }) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = clamp01(ease(frame / fps));
  const x = interpolate(t, [0, 1], [0, width]);
  return <AbsoluteFill style={{ backgroundColor: PALETTE[0], transform: \`translateX(\${x}px)\` }}>{subtitle}</AbsoluteFill>;
}
`;
  // 同一份组件的「AI 原始形态」：interpolate 从 remotion 来（校验器认的就是这个形态）
  const okCodeAi = okCode.replace(
    `import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";\nimport { interpolate } from "../safeInterp";`,
    `import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";`
  );
  const okErrs = await validateComponentCode("Ok.tsx", okCodeAi, true, [], false, [], true);
  t("AI 原始形态（interpolate 来自 remotion）不误报", () => {
    assert.deepStrictEqual(okErrs, []);
  });

  // 检查点复用路径：存的是装配形态，必须先 preAssemblyView 还原才能过校验，
  // 且还原后绝不能因为「合并回 remotion」而制造重复声明
  const view = preAssemblyView(okCode);
  t("preAssemblyView 还原后无重复标识符", () => {
    assert.deepStrictEqual(dupNames(view), [], `还原后重复: ${dupNames(view)}`);
    assert.match(view, /from\s*["']remotion["']/);
  });
  const viewErrs = await validateComponentCode("Ok.tsx", view, true, [], false, [], true);
  t("还原后的装配形态能通过校验（续跑复用不会被误判作废）", () => {
    assert.deepStrictEqual(viewErrs, []);
  });

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
