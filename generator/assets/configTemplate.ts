import filmConfig from '../film.config.json';

export interface ElementConfig {
  type: string;
  props: Record<string, any>;
}

export interface SceneConfig {
  name: string;
  durationInFrames: number;
  overlap?: number;
  elements: ElementConfig[];
}

export interface VoiceTrackConfig {
  scene: string;
  text: string;
}

export interface FilmConfig {
  id: string;
  title: string;
  width: number;
  height: number;
  fps: number;
  theme: Record<string, string>;
  scenes: SceneConfig[];
  voice: {
    enabled: boolean;
    voiceName: string;
    tracks: VoiceTrackConfig[];
  };
}

export const config: FilmConfig = filmConfig as FilmConfig;
