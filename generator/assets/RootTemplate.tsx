import React from 'react';
import { Composition } from 'remotion';
import { Film } from './compositions/Film';

export const RemotionRoot: React.FC = () => (
  <Composition id="__COMPOSITION_ID__" component={Film} durationInFrames={__DURATION__} fps={__FPS__} width={__WIDTH__} height={__HEIGHT__} />
);
