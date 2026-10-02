import React from 'react';
import { Composition } from 'remotion';
import { CursorProductFilm } from './compositions/CursorProductFilm';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="CursorProductFilm" component={CursorProductFilm} durationInFrames={600} fps={30} width={1920} height={1080} />
  </>
);
