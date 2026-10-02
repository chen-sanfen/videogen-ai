#!/usr/bin/env node
// generator/generate.js — CLI entry: config -> complete Remotion project

const fs = require("fs");
const path = require("path");
const { validateConfig } = require("./schema");
const { computeTimeline, computeTotalFrames, computeVoiceTracks } = require("./timeline");

function parseArgs(argv) {
  const args = argv.slice(2);
  let configPath = null;
  let outDir = "generated-project";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" && args[i + 1]) { outDir = args[i + 1]; i++; }
    else if (!args[i].startsWith("-")) configPath = args[i];
  }
  if (!configPath) { console.error("Usage: node generate.js <config.json> [-o output-dir]"); process.exit(1); }
  return { configPath, outDir };
}

function readAsset(name) {
  return fs.readFileSync(path.join(__dirname, "assets", name), "utf8");
}

function replace(str, replacements) {
  let result = str;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.split(key).join(String(value));
  }
  return result;
}

function buildVoiceItems(voiceTracks) {
  return voiceTracks.map((v) => {
    const safeText = v.text.replace(/'/g, "''");
    return `  @{ file = '${v.file}'; text = '${safeText}' }`;
  }).join(",\n");
}

function generate() {
  const { configPath, outDir } = parseArgs(process.argv);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  validateConfig(config);

  const timeline = computeTimeline(config.scenes);
  const totalFrames = computeTotalFrames(timeline);
  const voiceTracks = computeVoiceTracks(config, timeline);

  const projectName = config.id.toLowerCase().replace(/[^a-z0-9]/g, "-");
  const outAbs = path.resolve(outDir);

  // Prepare file contents
  const files = {};

  files["package.json"] = replace(readAsset("packageTemplate.json"), {
    "__PROJECT_NAME__": projectName,
    "__COMPOSITION_ID__": config.id,
  });

  files["tsconfig.json"] = readAsset("tsconfigTemplate.json");
  files["remotion.config.ts"] = readAsset("remotionConfigTemplate.ts");
  files["film.config.json"] = JSON.stringify(config, null, 2) + "\n";
  files["README.md"] = readAsset("ReadmeTemplate.md");

  files["src/index.ts"] = readAsset("indexTemplate.ts");

  files["src/Root.tsx"] = replace(readAsset("RootTemplate.tsx"), {
    "__COMPOSITION_ID__": config.id,
    "__DURATION__": totalFrames,
    "__FPS__": config.fps,
    "__WIDTH__": config.width,
    "__HEIGHT__": config.height,
  });

  files["src/config.ts"] = readAsset("configTemplate.ts");
  const styleSuffix = config.style === "v2" ? "V2" : "";
  files["src/compositions/Film.tsx"] = readAsset(`FilmTemplate${styleSuffix}.tsx`);

  if (config.voice && config.voice.enabled) {
    const psContent = replace(readAsset("voiceScriptTemplate.ps1"), {
      "__VOICE_NAME__": config.voice.voiceName,
      "__VOICE_ITEMS__": buildVoiceItems(voiceTracks),
    });
    files["scripts/generate-voice.ps1"] = "\uFEFF" + psContent;
  }

  files["public/voice/.gitkeep"] = "";

  // Write files
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(outAbs, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    console.log(`  wrote ${relPath}`);
  }

  // Summary
  console.log("");
  console.log(`Generated project: ${outAbs}`);
  console.log(`  Composition ID: ${config.id}`);
  console.log(`  Scenes: ${config.scenes.length}`);
  console.log(`  Total frames: ${totalFrames}`);
  console.log(`  Duration: ${(totalFrames / config.fps).toFixed(1)}s at ${config.fps}fps`);
  console.log(`  Voice tracks: ${voiceTracks.length}`);
  console.log(`  Files: ${Object.keys(files).length}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  cd ${outAbs}`);
  console.log("  npm install  (or: mklink /J node_modules <root>/node_modules)");
  console.log("  powershell scripts/generate-voice.ps1");
  console.log("  npx remotion render src/index.ts " + config.id + " out/film.mp4");
}

generate();
