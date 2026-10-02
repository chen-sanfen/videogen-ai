// generator/schema.js — configuration validation (pure JS, no deps)

// classic 风格元素类型（原 9 种）
const CLASSIC_ELEMENT_TYPES = new Set([
  "title", "subtitle", "codeWindow", "agentPanel",
  "previewCard", "codeFlow", "particles", "callout", "brandEnd"
]);

// v2 风格元素类型（SUNRISE PAPER 视觉系统，9 种全新渲染器）
const V2_ELEMENT_TYPES = new Set([
  "kicker", "caption", "phoneMock", "statBlock",
  "waveBars", "radarRings", "marquee", "splitDiag", "finaleBlock"
]);

const ELEMENT_TYPES_BY_STYLE = {
  classic: CLASSIC_ELEMENT_TYPES,
  v2: V2_ELEMENT_TYPES,
};

// 向后兼容导出（默认 classic 集合）
const VALID_ELEMENT_TYPES = CLASSIC_ELEMENT_TYPES;

function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") throw new Error("config must be an object");
  for (const f of ["id", "title", "width", "height", "fps", "theme", "scenes"]) {
    if (config[f] === undefined) errors.push(`missing required field: ${f}`);
  }
  if (config.style !== undefined && !ELEMENT_TYPES_BY_STYLE[config.style])
    errors.push(`invalid style: ${config.style} (expected "classic" or "v2")`);
  const validTypes = ELEMENT_TYPES_BY_STYLE[config.style] || CLASSIC_ELEMENT_TYPES;
  for (const f of ["width", "height", "fps"]) {
    if (config[f] !== undefined && (!Number.isInteger(config[f]) || config[f] <= 0))
      errors.push(`${f} must be a positive integer`);
  }
  if (!Array.isArray(config.scenes)) errors.push("scenes must be an array");
  else {
    const names = new Set();
    config.scenes.forEach((s, i) => {
      if (!s.name) errors.push(`scene[${i}] missing name`);
      else if (names.has(s.name)) errors.push(`duplicate scene name: ${s.name}`);
      else names.add(s.name);
      if (!Number.isInteger(s.durationInFrames) || s.durationInFrames <= 0)
        errors.push(`scene[${i}] durationInFrames must be a positive integer`);
      if (!Array.isArray(s.elements)) errors.push(`scene[${i}] elements must be an array`);
      else s.elements.forEach((el, j) => {
        if (!validTypes.has(el.type))
          errors.push(`scene[${i}] element[${j}] invalid type: ${el.type}`);
      });
    });
    if (config.voice && config.voice.enabled) {
      if (!config.voice.voiceName) errors.push("voice.voiceName required when enabled");
      if (!Array.isArray(config.voice.tracks)) errors.push("voice.tracks must be an array");
      else config.voice.tracks.forEach((t, i) => {
        if (!t.scene || !names.has(t.scene))
          errors.push(`voice.tracks[${i}] references unknown scene: ${t.scene}`);
        if (!t.text) errors.push(`voice.tracks[${i}] missing text`);
      });
    }
  }
  if (errors.length) throw new Error("Config validation failed:\n  " + errors.join("\n  "));
  return true;
}

module.exports = { validateConfig, VALID_ELEMENT_TYPES };
