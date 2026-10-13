import { Composition } from 'remotion';
import { Pitch, pitchFrames } from './Pitch';
import { Demo, demoFrames } from './Demo';
import { Agora, agoraFrames } from './Agora';
import { Pitch2, pitch2Frames } from './Pitch2';

export const Root = () => (
  <>
  <Composition id="Pitch" component={Pitch} durationInFrames={pitchFrames} fps={30} width={1920} height={1080} />
  <Composition id="Demo" component={Demo} durationInFrames={demoFrames} fps={30} width={1920} height={1080} />
  <Composition id="Agora" component={Agora} durationInFrames={agoraFrames} fps={30} width={1920} height={1080} />
  <Composition id="Pitch2" component={Pitch2} durationInFrames={pitch2Frames} fps={30} width={1920} height={1080} />
  </>
);
