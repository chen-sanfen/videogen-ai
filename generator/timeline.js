// generator/timeline.js — timeline computation (pure JS, no deps)

function computeTimeline(scenes) {
  let cursor = 0;
  return scenes.map((scene, i) => {
    const from = i === 0 ? 0 : cursor - (scenes[i - 1].overlap || 0);
    cursor = from + scene.durationInFrames;
    return { name: scene.name, from, durationInFrames: scene.durationInFrames };
  });
}

function computeTotalFrames(timeline) {
  if (!timeline.length) return 1;
  return timeline[timeline.length - 1].from + timeline[timeline.length - 1].durationInFrames;
}

function computeVoiceTracks(config, timeline) {
  if (!config.voice || !config.voice.enabled) return [];
  return config.voice.tracks.map((track, i) => {
    const st = timeline.find((t) => t.name === track.scene);
    const file = String(i + 1).padStart(2, "0") + "-" + track.scene + ".wav";
    return { file, from: st ? st.from : 0, duration: st ? Math.max(30, st.durationInFrames - 15) : 60, text: track.text };
  });
}

module.exports = { computeTimeline, computeTotalFrames, computeVoiceTracks };
