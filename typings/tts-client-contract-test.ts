import type { PreviewInput } from './tts-client-strict';
import type { SpeechPlayer } from './reader-speech-strict';

// The Reader publishes exactly this existing host contract to the shared player.
declare const readerPublication: Parameters<SpeechPlayer['previewLoaded']>[0];
const playerInput: PreviewInput = readerPublication;
void playerInput;
