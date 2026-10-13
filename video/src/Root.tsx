import { Composition } from 'remotion';
import { Pitch, pitchFrames } from './Pitch';
import { Demo, demoFrames } from './Demo';

export const Root = () => (
  <>
  <Composition id="Pitch" component={Pitch} durationInFrames={pitchFrames} fps={30} width={1920} height={1080} />
  <Composition id="Demo" component={Demo} durationInFrames={demoFrames} fps={30} width={1920} height={1080} />
  </>
);
