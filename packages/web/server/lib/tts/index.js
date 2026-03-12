/**
 * TTS Module Entry Point
 *
 * Public export surface for the Text-to-Speech domain module.
 */

export {
  ttsService,
  TTSService,
  TTS_VOICES,
} from './service.js';

export {
  summarizeText,
  sanitizeForTTS,
} from './summarization.js';
