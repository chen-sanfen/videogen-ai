// generator/style-packs.js — 12 个完整风格包（纯数据 + 三个函数，无依赖）
// 每个包含 palette(hex 色板) / fonts(具体 font-family 字符串) / graphics / motion / avoid 五字段
// 字体全部为 Windows 系统预装字体，渲染节点同机可直接用，不违反"禁外部资源"契约

// ============================================================
//  风格包定义
// ============================================================
const STYLE_PACKS = [
  {
    id: "ink-wash",
    name: "水墨留白",
    palette: { bg: "#f5f1e8", bg2: "#ede7d9", ink: "#1c1c1c", muted: "#8a8276", accent: "#b3382c", accent2: "#6b7a5e" },
    fonts: {
      zhDisplay: "'KaiTi', 'STKaiti', 'SimSun', serif",
      zhBody: "'FangSong', 'STFangsong', serif",
      enNum: "'Georgia', 'Times New Roman', serif",
    },
    requiredFonts: ["KaiTi", "STKaiti", "FangSong", "STFangsong", "SimSun", "Georgia"],
    fontRule: "中文标题用楷体（KaiTi），中文正文用仿宋（FangSong），英文与数字用 Georgia 衬线",
    graphics: "飞白笔触、毛笔粗细变化描边、墨点晕染、朱砂印章方块、宣纸纹理底",
    motion: "墨迹缓慢晕开、纸面徐徐位移、印章盖落、笔锋扫过留飞白",
    avoid: "霓虹发光、金属渐变、深底高饱和、Comic Sans、Impact、等宽字",
  },
  {
    id: "swiss-grid",
    name: "瑞士网格",
    palette: { bg: "#ffffff", bg2: "#f4f4f4", ink: "#111111", muted: "#666666", accent: "#e3000c", accent2: "#111111" },
    fonts: {
      zhDisplay: "'Microsoft YaHei', sans-serif",
      zhBody: "'Microsoft YaHei', sans-serif",
      enNum: "'Arial', 'Helvetica Neue', sans-serif",
    },
    requiredFonts: ["Microsoft YaHei", "Arial"],
    fontRule: "全部用微软雅黑（Microsoft YaHei）或 Arial，粗细对比强烈（超粗 vs 极细），无衬线",
    graphics: "严格12列网格线、超大留白、小字排成一列、十字标记、粗细分明的水平线",
    motion: "网格线逐条生长、块面瞬间硬切、字从左缘滑入",
    avoid: "渐变、阴影、装饰花纹、圆角、高饱和撞色、衬线体",
  },
  {
    id: "vaporwave",
    name: "蒸汽波",
    palette: { bg: "#2d1b69", bg2: "#1a0d4d", ink: "#ffffff", muted: "#b8a0ff", accent: "#ff71ce", accent2: "#01cdfe" },
    fonts: {
      zhDisplay: "'SimHei', sans-serif",
      zhBody: "'SimHei', sans-serif",
      enNum: "'Courier New', monospace",
    },
    requiredFonts: ["SimHei", "Courier New"],
    fontRule: "中文用黑体（SimHei），英文与数字用 Courier New 等宽体",
    graphics: "透视网格地平线、落日大圆渐变、棕榈树剪影、扫描线、色差重影红蓝错位",
    motion: "缓慢透视纵深滚动、色差抖动、日落呼吸缩放",
    avoid: "米白纸感、衬线体、极简留白、写实照片感",
  },
  {
    id: "newsprint",
    name: "复古报纸",
    palette: { bg: "#f2e8d5", bg2: "#e8dcc4", ink: "#2b2117", muted: "#6b5d48", accent: "#8b1a1a", accent2: "#2b2117" },
    fonts: {
      zhDisplay: "'SimSun', 'STZhongsong', serif",
      zhBody: "'SimSun', 'STZhongsong', serif",
      enNum: "'Georgia', 'Times New Roman', serif",
    },
    requiredFonts: ["SimSun", "STZhongsong", "Georgia"],
    fontRule: "中文用宋体（SimSun）或华文中宋（STZhongsong），英文与数字用 Georgia/Times New Roman 衬线",
    graphics: "报头双横线、分栏竖线、老式线画插图、小字密排、油墨网点纹理",
    motion: "印刷机逐行压印、纸张翻折、油墨洇开",
    avoid: "霓虹、玻璃模糊、高饱和现代色、无衬线体",
  },
  {
    id: "neobrutal",
    name: "新丑风",
    palette: { bg: "#ffd500", bg2: "#ffffff", ink: "#111111", muted: "#444444", accent: "#ff5da2", accent2: "#4d9fff" },
    fonts: {
      zhDisplay: "'SimHei', sans-serif",
      zhBody: "'SimHei', sans-serif",
      enNum: "'Impact', 'Arial Black', sans-serif",
    },
    requiredFonts: ["SimHei", "Impact", "Arial Black"],
    fontRule: "中文用黑体（SimHei），英文与数字用 Impact 或 Arial Black 超粗体",
    graphics: "4px纯黑描边、8px硬阴影无模糊、放肆撞色块、贴纸旋转、粗黑边框",
    motion: "弹跳砸入、硬切、抖动震颤",
    avoid: "渐变、柔和阴影、透明度、小圆角、优雅留白",
  },
  {
    id: "glassmorphism",
    name: "玻璃拟态",
    palette: { bg: "#1e3a5f", bg2: "#0f2027", ink: "#eaf4ff", muted: "#8fb8e0", accent: "#7fd8ff", accent2: "#a78bfa" },
    fonts: {
      zhDisplay: "'Microsoft YaHei', sans-serif",
      zhBody: "'Microsoft YaHei', sans-serif",
      enNum: "'Segoe UI', sans-serif",
    },
    requiredFonts: ["Microsoft YaHei", "Segoe UI"],
    fontRule: "中文用微软雅黑（Microsoft YaHei），英文与数字用 Segoe UI",
    graphics: "backdrop-filter blur 半透明白面板、1px细白描边 rgba(255,255,255,.35)、柔光斑、折射高光",
    motion: "面板漂浮缓移、光线扫过、呼吸缩放",
    avoid: "硬边框、纯黑底、高对比撞色、4px描边",
  },
  {
    id: "memphis",
    name: "孟菲斯",
    palette: { bg: "#fef6e4", bg2: "#ffffff", ink: "#1a1a2e", muted: "#555555", accent: "#ed1849", accent2: "#00a19c" },
    fonts: {
      zhDisplay: "'Microsoft YaHei', sans-serif",
      zhBody: "'Microsoft YaHei', sans-serif",
      enNum: "'Trebuchet MS', sans-serif",
    },
    requiredFonts: ["Microsoft YaHei", "Trebuchet MS"],
    fontRule: "中文用微软雅黑（Microsoft YaHei），英文与数字用 Trebuchet MS",
    graphics: "圆点、三角、波浪线、Z字纹等几何散布、粗黑轮廓、撞色填充",
    motion: "元素依次弹出、图形自旋、错位入场",
    avoid: "玻璃模糊、写实质感、暗色底、渐变",
  },
  {
    id: "crayon",
    name: "蜡笔手绘",
    palette: { bg: "#fdf6e3", bg2: "#f8eed6", ink: "#5b4636", muted: "#8a7560", accent: "#ff8c42", accent2: "#5aa9e6" },
    fonts: {
      zhDisplay: "'KaiTi', serif",
      zhBody: "'KaiTi', serif",
      enNum: "'Comic Sans MS', 'Marker Felt', cursive",
    },
    requiredFonts: ["KaiTi", "Comic Sans MS"],
    fontRule: "中文用楷体（KaiTi），英文与数字用 Comic Sans MS 手写体",
    graphics: "蜡笔粗糙描边、抖动线条、纸纹、涂鸦填充、歪扭手写感",
    motion: "手绘逐笔描边、线条沿路径生长、抖动入场",
    avoid: "精确几何、金属、霓虹、直线硬边",
  },
  {
    id: "noir",
    name: "黑白默片",
    palette: { bg: "#0a0a0a", bg2: "#141414", ink: "#f5f0e6", muted: "#888888", accent: "#f5f0e6", accent2: "#aaaaaa" },
    fonts: {
      zhDisplay: "'FangSong', 'STFangsong', serif",
      zhBody: "'FangSong', 'STFangsong', serif",
      enNum: "'Times New Roman', serif",
    },
    requiredFonts: ["FangSong", "STFangsong", "Times New Roman"],
    fontRule: "中文用仿宋（FangSong），英文与数字用 Times New Roman 衬线",
    graphics: "胶片颗粒、划痕噪点、圆形晕影遮罩、字幕卡框线、胶片孔",
    motion: "跳帧闪烁、字幕卡淡入、光圈收缩、投影颤动",
    avoid: "任何彩色、现代UI元素、高饱和、霓虹",
  },
  {
    id: "blueprint",
    name: "工程蓝图",
    palette: { bg: "#0d3b8c", bg2: "#0a2d6b", ink: "#e8f1ff", muted: "#8fb0e8", accent: "#ffffff", accent2: "#a3d0ff" },
    fonts: {
      zhDisplay: "'SimHei', sans-serif",
      zhBody: "'SimHei', sans-serif",
      enNum: "'Courier New', monospace",
    },
    requiredFonts: ["SimHei", "Courier New"],
    fontRule: "中文用黑体（SimHei），英文与数字用 Courier New 等宽体",
    graphics: "白色细线稿、尺寸标注线、剖面斜线填充、图框标题栏、坐标刻度",
    motion: "线条按CAD顺序逐段绘制、标注数字滚动、视图旋转",
    avoid: "渐变彩色、手绘感、照片质感、模糊",
  },
  {
    id: "zen-wabi",
    name: "和风禅意",
    palette: { bg: "#f7f4ee", bg2: "#efe8dd", ink: "#3d4a3e", muted: "#8a8a7e", accent: "#a35638", accent2: "#7a8b6f" },
    fonts: {
      zhDisplay: "'SimSun', 'STZhongsong', serif",
      zhBody: "'FangSong', 'STFangsong', serif",
      enNum: "'Palatino Linotype', serif",
    },
    requiredFonts: ["SimSun", "STZhongsong", "FangSong", "Palatino Linotype"],
    fontRule: "中文标题用宋体（SimSun），正文用仿宋（FangSong），英文与数字用 Palatino Linotype 衬线",
    graphics: "大量留白、细竖线、圆窗、一枝斜出、苔点、枯山水纹理",
    motion: "极慢缓动、呼吸般透明度变化、落叶飘移",
    avoid: "高饱和、密集元素、弹跳、霓虹",
  },
  {
    id: "artdeco",
    name: "装饰艺术",
    palette: { bg: "#101423", bg2: "#1a1f33", ink: "#e8d5a3", muted: "#8a7e5c", accent: "#c9a227", accent2: "#7a1f2b" },
    fonts: {
      zhDisplay: "'SimSun', 'STZhongsong', serif",
      zhBody: "'FangSong', 'STFangsong', serif",
      enNum: "'Georgia', serif",
    },
    requiredFonts: ["SimSun", "STZhongsong", "FangSong", "Georgia"],
    fontRule: "中文标题用宋体（SimSun），正文用仿宋（FangSong），英文与数字用 Georgia 衬线",
    graphics: "扇形放射线、阶梯状几何、对称纹样、细金线框、三角扇形",
    motion: "放射线展开、金色流光扫过、对称揭示、阶梯上移",
    avoid: "卡通、涂鸦、圆点波普、Comic Sans",
  },
];

// ============================================================
//  pickStylePack — 随机抽取（避开最近用过的包），STYLE_PACK 环境变量可强制指定
// ============================================================
const _recentPacks = [];

function pickStylePack() {
  const forced = process.env.STYLE_PACK;
  if (forced) {
    const found = STYLE_PACKS.find((p) => p.id === forced);
    if (found) return found;
    console.error(`[style-packs] STYLE_PACK=${forced} 未找到，回退随机抽取`);
  }
  for (let i = 0; i < 12; i++) {
    const v = STYLE_PACKS[Math.floor(Math.random() * STYLE_PACKS.length)];
    if (!_recentPacks.includes(v.id)) {
      _recentPacks.push(v.id);
      while (_recentPacks.length > 6) _recentPacks.shift();
      return v;
    }
  }
  return STYLE_PACKS[Math.floor(Math.random() * STYLE_PACKS.length)];
}

// ============================================================
//  expandBrief — 把包内设计令牌展开成创意方向简报文本
// ============================================================
function expandBrief(pack) {
  const p = pack.palette;
  const f = pack.fonts;
  const lines = [
    "【创意方向简报】（本次风格包，必须贯彻到每一个分镜与背景）",
    `- 风格包：${pack.name}（${pack.id}）`,
    "",
    "【色彩令牌（必须逐字使用这些 hex 值，不要自创相近色）】",
    `- 主背景 bg：${p.bg}　次级层 bg2：${p.bg2}`,
    `- 文字/线条 ink：${p.ink}　弱化文字 muted：${p.muted}`,
    `- 强调色 accent：${p.accent}　辅助强调 accent2：${p.accent2}`,
    "",
    "【字体令牌（fontFamily 必须逐字使用下列 font-family 字符串原文，禁止回落默认 sans-serif）】",
    `- 中文标题字体栈：fontFamily: "${f.zhDisplay}"`,
    `- 中文正文字体栈：fontFamily: "${f.zhBody}"`,
    `- 英文/数字字体栈：fontFamily: "${f.enNum}"`,
    `- 字体规则：${pack.fontRule}`,
    "",
    `【图形语言】${pack.graphics}`,
    `【动效语言】${pack.motion}`,
    `【禁止项（切勿出现）】${pack.avoid}`,
  ];
  return lines.join("\n");
}

// ============================================================
//  sceneLayoutCards — 场景布局卡（每次调用 shuffle，保证同片场景互不相同）
// ============================================================
const _LAYOUT_CARDS = [
  "居中对称构图：主视觉居画面正中，四周大量留白，元素从中线向两翼展开",
  "左对齐大字构图：超大标题从左缘生长，右侧留出负空间放辅助信息，竖向排列",
  "上下分屏构图：水平中线将画面一分为二，上下面板各自独立、可对折展开",
  "左右分屏构图：竖直中线将画面一分为二，左右对照（如 before/after）",
  "对角切割构图：从左上到右下的对角线分割画面，两区斜向错位",
  "全屏色块构图：一个大色块占据 70% 以上画面，文字叠加其上",
  "散点漂浮构图：5-8 个元素散布全屏，各自微动，视觉中心在偏上 1/3 处",
  "网格阵列构图：3x2 或 4x2 卡片网格，逐格依次点亮",
  "中心放射构图：所有元素从画面中心向外辐射，或向中心汇聚",
  "边缘出血构图：主体从画面左/右边缘闯入，部分溢出画框",
];

function _shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sceneLayoutCards() {
  return _shuffle(_LAYOUT_CARDS);
}

module.exports = { STYLE_PACKS, pickStylePack, expandBrief, sceneLayoutCards };
