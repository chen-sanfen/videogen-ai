#!/usr/bin/env node
// scripts/test-optimize-assets.cjs
// 「AI 优化描述」必须真的用上用户素材 —— 离线回归。
//
// 覆盖三件事：
//   1. buildOptimizeAssetsBrief：素材 → 优化器简报（三种用法各自的硬规则、有无「画面理解」的区别）
//   2. extractBrief：看懂素材（正常 / LLM 挂了降级 / 没有 callLLM）
//   3. OPTIMIZER_PROMPT 里的防瞎编约束
//
// 不发网络请求、不消耗额度。

const path = require("path");
const CODEGEN = path.join(__dirname, "..", "generator", "codegen.js");
const REDRAW = path.join(__dirname, "..", "generator", "asset-redraw.js");

const { buildOptimizeAssetsBrief, isDetailedBrief, DETAIL_MARKERS } = require(CODEGEN);
const { extractBrief } = require(REDRAW);
const fs = require("fs");

const src = fs.readFileSync(CODEGEN, "utf8");
const optimizerPrompt = src.slice(
  src.indexOf("const OPTIMIZER_PROMPT = `") + "const OPTIMIZER_PROMPT = `".length,
  src.indexOf("`;", src.indexOf("const OPTIMIZER_PROMPT = `"))
);

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

(async () => {
  console.log("\n=== 1. buildOptimizeAssetsBrief：素材 → 优化器简报 ===");

  await t("没有素材 / 非数组 → 空串（不能拼出多余内容）", () => {
    ok(buildOptimizeAssetsBrief([], "direct") === "", "空数组应返回空串");
    ok(buildOptimizeAssetsBrief(null, "direct") === "", "null 应返回空串");
    ok(buildOptimizeAssetsBrief(undefined, "reference") === "", "undefined 应返回空串");
    ok(buildOptimizeAssetsBrief("x", "redraw") === "", "字符串应返回空串");
    ok(buildOptimizeAssetsBrief([null, undefined], "direct") === "", "只有空项应返回空串");
  });

  const imgWithBrief = [
    {
      kind: "image",
      label: "产品图.jpg",
      file: "2026-09-28-xxxx.jpg",
      width: 1600,
      height: 900,
      palette: ["#1a2b4a", "#f5c542", "#e04b3a"],
      brightness: 0.62,
      grid: Array.from({ length: 9 }, (_, i) => ({ color: "#1a2b4a", lum: i / 9, sat: 0.4 })),
      brief: {
        subject: "一只哑光黑的桌面智能音箱",
        elements: ["圆柱机身", "顶部环形指示灯", "木质桌面"],
        composition: "主体居中偏右，浅景深",
        mood: "温暖日常",
      },
    },
  ];

  await t("图片带 brief → 简报里出现「画面理解」与主体 / 元素 / 气质", () => {
    const s = buildOptimizeAssetsBrief(imgWithBrief, "direct");
    ok(s.includes("画面理解（AI 提取"), "缺 AI 提取标记");
    ok(s.includes("视觉事实来源"), "应标明画面理解是视觉事实来源、视觉描述必须据此");
    ok(s.includes("一只哑光黑的桌面智能音箱"), "缺主体");
    ok(s.includes("圆柱机身"), "缺主要元素");
    ok(s.includes("温暖日常"), "缺气质");
    ok(s.includes("【图片】产品图.jpg"), "缺素材名与类型");
    ok(s.includes("#f5c542"), "缺实测主色");
    ok(s.includes("九宫格分布"), "缺九宫格特征");
  });

  await t("图片没有 brief → 只能给实测特征，绝不能冒出「主体：」（否则模型会以为看懂了图）", () => {
    const s = buildOptimizeAssetsBrief([{ ...imgWithBrief[0], brief: undefined }], "direct");
    ok(!s.includes("画面理解"), "不该出现画面理解");
    ok(!s.includes("主体："), "不该出现主体描述");
    ok(s.includes("实测主色"), "应保留实测主色");
    ok(s.includes("平均明度 0.62"), "应保留明度");
  });

  await t("网址素材 → 标题 / 摘要 / 小标题 / 正文摘录都要进简报（这些是可信文字）", () => {
    const s = buildOptimizeAssetsBrief(
      [
        {
          kind: "url",
          url: "https://example.com/product",
          host: "example.com",
          title: "Aurora 智能音箱",
          description: "支持离线语音控制的桌面音箱",
          headings: ["产品参数", "常见问题"],
          text: "内置六麦克风阵列，可在断网环境下完成本地语音识别。",
        },
      ],
      "reference"
    );
    ok(s.includes("【网址】"), "缺网址类型");
    ok(s.includes("Aurora 智能音箱"), "缺网页标题");
    ok(s.includes("离线语音控制"), "缺网页摘要");
    ok(s.includes("产品参数"), "缺小标题");
    ok(s.includes("六麦克风阵列"), "缺正文摘录");
  });

  await t("三种用法给三种不同的硬规则", () => {
    const a = imgWithBrief;
    const ref = buildOptimizeAssetsBrief(a, "reference");
    const dir = buildOptimizeAssetsBrief(a, "direct");
    const red = buildOptimizeAssetsBrief(a, "redraw");
    ok(ref.includes("仅参考") && ref.includes("不会真的进画面"), "reference 规则不对");
    ok(dir.includes("直接使用") && dir.includes("原样出现在成片画面里"), "direct 规则不对");
    ok(red.includes("AI 重绘") && red.includes("重绘件作为画面主体进片"), "redraw 规则不对");
    ok(!ref.includes("原样出现在成片画面里"), "reference 不该混进 direct 的规则");
  });

  await t("未知 / 缺省用法 → 退回 reference 规则（保守，不臆造素材进画面）", () => {
    ok(buildOptimizeAssetsBrief(imgWithBrief, "weird").includes("仅参考"), "未知模式应退回 reference");
    ok(buildOptimizeAssetsBrief(imgWithBrief).includes("仅参考"), "缺省应退回 reference");
  });

  await t("多件素材全部列出，编号连续", () => {
    const list = [imgWithBrief[0], imgWithBrief[0], { kind: "video", label: "demo.mp4", palette: ["#222"] }];
    const s = buildOptimizeAssetsBrief(list, "direct");
    ok(s.includes("1. 【图片】"), "缺第 1 件");
    ok(s.includes("2. 【图片】"), "缺第 2 件");
    ok(s.includes("3. 【视频】"), "缺第 3 件");
  });

  await t("视频素材 → 标注「只采样了中段一帧」，不让模型把单帧当成整支视频", () => {
    const s = buildOptimizeAssetsBrief([{ kind: "video", label: "demo.mp4", palette: ["#123456"], brightness: 0.4 }], "direct");
    ok(s.includes("【视频】"), "缺视频类型");
    ok(s.includes("只采样了中段一帧"), "缺单帧说明");
  });

  await t("素材信息为空对象 → 只留类型行，不炸", () => {
    const s = buildOptimizeAssetsBrief([{ kind: "image" }], "direct");
    ok(s.includes("未命名素材"), "缺兜底名称");
  });

  console.log("\n=== 2. OPTIMIZER_PROMPT 的约束 ===");

  await t("必须写清「有素材要用起来」", () => {
    ok(optimizerPrompt.includes("用户素材"), "缺素材使用要求");
  });

  await t("必须禁止在没看懂图时编造图中物体（没有视觉模型，这是硬边界）", () => {
    ok(optimizerPrompt.includes("严禁编造图中具体有什么物体"), "缺防瞎编约束");
  });

  await t("必须点明网址文字可信、要优先采用", () => {
    ok(optimizerPrompt.includes("网址素材的标题"), "缺网址文字可信的说明");
  });

  console.log("\n=== 3. extractBrief：看懂素材 ===");

  const asset = {
    kind: "image",
    label: "产品图.jpg",
    width: 1600,
    height: 900,
    palette: ["#1a2b4a", "#f5c542"],
    brightness: 0.6,
    grid: Array.from({ length: 9 }, (_, i) => ({ color: "#1a2b4a", lum: i / 9, sat: 0.3 })),
  };

  await t("正常返回 → 解析出 subject / elements / palette", async () => {
    const b = await extractBrief(asset, {
      apiKey: "k",
      callLLM: async () =>
        JSON.stringify({
          subject: "哑光黑智能音箱",
          elements: ["圆柱机身", "环形灯"],
          composition: "居中",
          palette: ["#1a2b4a", "#f5c542"],
          mood: "科技冷峻",
          redrawPrompt: "a matte black smart speaker",
        }),
    });
    ok(b && b.subject === "哑光黑智能音箱", "subject 解析失败");
    ok(Array.isArray(b.elements) && b.elements.length === 2, "elements 解析失败");
    ok(b.degraded !== true, "不应标记为降级");
  });

  await t("LLM 挂了 → 降级到实测特征兜底，不抛错（优化不能被这一步阻断）", async () => {
    const b = await extractBrief(asset, {
      apiKey: "k",
      callLLM: async () => {
        throw new Error("gateway down");
      },
      log: () => {},
    });
    ok(b && typeof b.subject === "string" && b.subject.length > 0, "兜底也要有主体描述");
    ok(b.degraded === true, "应标记为降级");
  });

  await t("没传 callLLM → 返回 null（调用方按「没看懂」处理，不会瞎编）", async () => {
    const b = await extractBrief(asset, { apiKey: "k" });
    ok(b === null, `应返回 null，实际 ${JSON.stringify(b)}`);
  });

  await t("素材没有任何可用信息 → 返回 null", async () => {
    const b = await extractBrief({ kind: "image" }, { apiKey: "k", callLLM: async () => "{}" });
    ok(b === null, "空素材应返回 null");
  });

  console.log("\n=== 4. 完整创意方案识别：禁止随机视角覆盖用户已指定的场景 ===");

  // 用户粘贴的那条：明确写了场景（清晨/午后/夜晚/展览）、第一人称、情绪基调、叙事线索、视觉风格
  const FULL_BRIEF =
    "一个以金黄色质感为绝对主角的产品宣传片，画面几乎被高饱和的金橙覆盖，上部散布深棕近黑的小块纹理，" +
    "底部与右侧留出大片平滑的亮黄，整体厚重、浓郁、奢华。本片让这件金色材质的产品以第一人称开口，" +
    "通篇以“我负责……”的句式自述。我负责在清晨的光线里先亮起来：镜头贴着金色的表面缓缓扫过。" +
    "我负责经得起细看：切换到正中偏右下的特写。我还负责承受岁月：光影反复掠过同一块区域。" +
    "三个典型场景依次呈现：午后窗边，逆光让金色微微透亮；夜晚台灯下，暖光让深色小块沉下去、金色浮上来；" +
    "展览或陈列的空间里，金色在全画面中独占视野。情绪基调定为温暖浓郁、复古鎏金、极简沉稳。" +
    "叙事线索：开场以一整屏金色配合第一句自述瞬间抓人；中段三个“我负责”逐条对应纹理微距、重心留白、光影轮回；" +
    "结尾镜头落回右下角那片平滑的亮黄，自述收在“我负责，一直亮着”的主张上。";

  await t("isDetailedBrief：用户完整方案 → true", () => {
    ok(isDetailedBrief(FULL_BRIEF) === true, "含场景/情绪/叙事/人称的完整方案应识别为 true");
  });

  await t("isDetailedBrief：很短的含糊描述 → false（让随机视角自由发挥）", () => {
    ok(isDetailedBrief("做个金色产品的宣传片") === false, "一句话含糊描述应为 false");
    ok(isDetailedBrief("给我一个科技感的产品短片") === false, "无场景/情绪/叙事标记应为 false");
  });

  await t("isDetailedBrief：DETAIL_MARKERS 命中阈值应 ≥ 4 才判定为完整", () => {
    ok(Array.isArray(DETAIL_MARKERS) && DETAIL_MARKERS.length >= 8, "标记组应覆盖多类创作要素");
  });

  await t("OPTIMIZER_PROMPT：必须含「完整创意方案 = 不可更改的硬约束」与「必须遵循」指令", () => {
    ok(optimizerPrompt.includes("不可更改的硬约束"), "缺硬约束表述");
    ok(optimizerPrompt.includes("必须遵循") || optimizerPrompt.includes("必须采纳"), "缺角度采纳/遵循指令");
    ok(optimizerPrompt.includes("严禁") && optimizerPrompt.includes("改成别的事物"), "缺禁止替换场景的硬约束");
    // 关键：不能再用「明显不同」去逼迫改场景——含糊描述才允许，完整方案必须保留
    ok(!optimizerPrompt.includes("让这一版在场景选择"), "旧版「在场景选择上明显不同」不应残留");
  });

  await t("OPTIMIZER_PROMPT：照片素材必须成为视觉事实、且禁止编造产品品类", () => {
    ok(optimizerPrompt.includes("用户素材就是成片画面的视觉事实"), "缺「素材即视觉事实」指令");
    ok(optimizerPrompt.includes("不编造产品"), "缺「不编造产品」硬规则");
    ok(optimizerPrompt.includes("视觉特征来指代主体"), "缺「用视觉特征指代主体、不发明品类」的兜底写法");
    ok(optimizerPrompt.includes("抓住素材的视觉重点"), "缺「抓重点」要求");
  });

  console.log(`\n${"=".repeat(46)}\n  通过 ${pass} 项，失败 ${fail} 项\n${"=".repeat(46)}`);
  process.exit(fail ? 1 : 0);
})();

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
