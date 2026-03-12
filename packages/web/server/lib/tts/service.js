/**
 * Server-side Text-to-Speech Service
 *
 * Uses OpenAI's TTS API to generate audio on the server and stream it to clients.
 * This bypasses mobile Safari's audio context restrictions.
 */

import OpenAI from 'openai';
import { readAuthFile } from '../opencode/auth.js';

// Voice options from OpenAI
export const TTS_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
];

function getOpenAIApiKey() {
  // First check environment variable
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey) {
    return envKey;
  }

  // Then check opencode auth file (same as usage tracker)
  try {
    const auth = readAuthFile();
    // Check for openai, codex, or chatgpt aliases
    const openaiAuth = auth.openai || auth.codex || auth.chatgpt;
    if (openaiAuth) {
      // Handle both string format (just the token) and object format
      if (typeof openaiAuth === 'string') {
        return openaiAuth;
      }
      // Try access token first (OAuth), then regular token
      if (openaiAuth.access) {
        return openaiAuth.access;
      }
      if (openaiAuth.token) {
        return openaiAuth.token;
      }
    }
  } catch (error) {
    console.warn('[TTSService] Failed to read auth file:', error.message);
  }

  return null;
}

class TTSService {
  constructor() {
    this._client = null;
    this._lastApiKey = null;
  }

  _getClient() {
    const apiKey = getOpenAIApiKey();

    // If API key changed or client doesn't exist, create new client
    if (apiKey && (!this._client || this._lastApiKey !== apiKey)) {
      this._client = new OpenAI({ apiKey });
      this._lastApiKey = apiKey;
    }

    return this._client;
  }

  isAvailable() {
    return this._getClient() !== null;
  }

  /**
   * Generate speech and return as a stream
   */
  async generateSpeechStream(options) {
    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions,
      apiKey
    } = options;

    // Use provided API key or fall back to configured key
    let client;
    if (apiKey) {
      client = new OpenAI({ apiKey });
    } else {
      client = this._getClient();
    }

    if (!client) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable, configure OpenAI in OpenCode, or provide an API key in settings.');
    }

    if (!text.trim()) {
      throw new Error('Text is required for TTS');
    }

    try {
      console.log('[TTSService] Generating speech with voice:', voice, 'model:', model);
      const response = await client.audio.speech.create({
        model,
        voice,
        input: text,
        speed,
        ...(instructions && { instructions }),
        response_format: 'mp3',
      });

      // Convert the response to a web stream
      const stream = response.body;
      
      return {
        stream,
        contentType: 'audio/mpeg',
      };
    } catch (error) {
      console.error('[TTSService] Error generating speech:', error);
      throw new Error(`Failed to generate speech: ${error.message || 'Unknown error'}`);
    }
  }

  /**
   * Generate speech and return as a buffer (for caching)
   */
  async generateSpeechBuffer(options) {
    const client = this._getClient();
    if (!client) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable or configure OpenAI in OpenCode.');
    }

    const {
      text,
      voice = 'coral',
      model = 'gpt-4o-mini-tts',
      speed = 1.0,
      instructions
    } = options;

    try {
      const response = await client.audio.speech.create({
        model,
        voice,
        input: text,
        speed,
        ...(instructions && { instructions }),
        response_format: 'mp3',
      });

      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      console.error('[TTSService] Error generating speech buffer:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const ttsService = new TTSService();
export { TTSService };
