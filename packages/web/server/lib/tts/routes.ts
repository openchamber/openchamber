import express from 'express';
import { z } from 'zod';

import { isNumber, isString } from '../shared/object-guards.js';
import type { Application } from '../shared/http-contracts.js';
import type { SayTtsCapability } from './capability-runtime.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { normalizeEndpointPath } from './endpoint-path.js';
import { summarizeText, sanitizeForTTS, sanitizeForNote } from '../text/summarization.js';

import { detectTextLanguage, languageOfLocale, pickVoiceForLanguage } from './language-detect.js';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode } from '../enterprise-mode.js';
import { describeVoiceKeys, readVoiceKey, updateVoiceKeys, voiceKeysPatchSchema } from './voice-keys.js';

const optionalText = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

const speakBodySchema = z.object({
  text: optionalText,
  voice: optionalText,
  model: optionalText,
  speed: optionalNumber,
  instructions: optionalText,
  apiKey: optionalText,
  baseURL: z.unknown().optional(),
  endpointPath: z.unknown().optional(),
}).catch({});

const summarizeBodySchema = z.object({
  text: optionalText,
  threshold: optionalNumber,
  maxLength: optionalNumber,
  mode: optionalText,
}).catch({});

const sayBodySchema = z.object({
  text: optionalText,
  voice: optionalText,
  // Left to parseSayRate: a malformed rate must answer 400, not fall back
  // to the default the way a dropped optionalNumber would.
  rate: z.unknown().optional(),
  language: z.unknown().optional(),
  languageSample: optionalText,
}).catch({});

const sttHeadersSchema = z.object({
  'content-type': optionalText,
  'x-base-url': optionalText,
  'x-model': optionalText,
  'x-language': optionalText,
  'x-endpoint-path': z.unknown().optional(),
  authorization: optionalText,
}).catch({});

const bodyOf = <Body>(body: Body) => body || {};

export function speechVoiceHeaderValue(voice: string) {
  return encodeURIComponent(voice);
}

// The macOS `say` invocation receives request fields as data, never as
// shell text (see buildSayArgs / the execFile call in the speak route).
// Rate is coerced to a plain integer inside the words-per-minute range
// `say` accepts from our clients (default 200, preview slider ~100-200);
// anything else — non-numeric strings, fractions, injected shell syntax —
// is rejected by the route with a 400 instead of reaching a command.
export function parseSayRate<Rate>(rate: Rate) {
  let value: number | null = null;
  if (isNumber(rate)) {
    value = rate;
  } else if (isString(rate) && /^\d+$/.test(rate.trim())) {
    value = Number(rate.trim());
  }
  if (value === null || !Number.isInteger(value) || value < 50 || value > 1000) {
    return null;
  }
  return value;
}

// Voice names are localized and punctuated ("Milena (Русский (Россия))",
// "Lesya (Enhanced)"), so the allow-pattern is letters/marks/numbers plus
// the punctuation real voice names use. Shell metacharacters, quotes,
// backslashes, and a leading dash (option injection against `say` itself)
// are not voice-name characters and are rejected.
const SAY_VOICE_PATTERN = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .()'_-]*$/u;

export function isSafeSayVoice(voice: unknown): voice is string {
  return typeof voice === 'string' && voice.length <= 100 && SAY_VOICE_PATTERN.test(voice);
}

// Argv for `say`, in order. Passed to execFile, so every field stays a
// single argument and no shell ever interprets it. The `--` terminator
// keeps `say` itself from parsing dash-prefixed text as an option
// (argument injection, e.g. text "--input-file=/etc/hosts").
export function buildSayArgs({ voice, rate, tempFile, text }: { voice: string; rate: number; tempFile: string; text: string }) {
  return ['-v', voice, '-r', String(rate), '-o', tempFile, '--data-format=aac', '--', text];
}

export function registerTtsRoutes(app: Application, { sayTTSCapability }: { sayTTSCapability: Promise<SayTtsCapability> }) {
  let ttsModulePromise: Promise<typeof import('./index.js')> | null = null;
  const getTtsModule = async () => {
    if (!ttsModulePromise) {
      ttsModulePromise = import('./index.js');
    }
    return ttsModulePromise;
  };

  app.get('/api/voice/keys', (_req, res) => {
    res.json(describeVoiceKeys());
  });

  app.put('/api/voice/keys', express.json({ limit: '16kb' }), (req, res) => {
    try {
      res.json(updateVoiceKeys(voiceKeysPatchSchema.parse(req.body)));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid voice keys' });
    }
  });

  app.post('/api/voice/token', async (req, res) => {
    console.log('[Voice] Token request received:', {
      contentType: req.headers['content-type'] || null,
    });
    try {
      if (isEnterpriseMode()) {
        return res.status(403).json({ allowed: false, error: ENTERPRISE_MODE_ERROR });
      }
      const openaiApiKey = process.env.OPENAI_API_KEY;
      console.log('[Voice] OpenAI API Key present:', !!openaiApiKey);

      if (!openaiApiKey) {
        return res.status(503).json({
          allowed: false,
          error: 'OpenAI voice service not configured. Set OPENAI_API_KEY environment variable.'
        });
      }

      res.json({
        allowed: true,
        provider: 'openai',
        message: 'OpenAI TTS is available'
      });
    } catch (error) {
      console.error('[Voice] Token generation error:', error);
      res.status(500).json({
        allowed: false,
        error: 'Voice service error'
      });
    }
  });

  app.post('/api/tts/speak', async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Send the speech request as JSON' });
    }
    try {
      const { text, voice = 'nova', model = 'gpt-4o-mini-tts', speed = 0.9, instructions, apiKey, baseURL, endpointPath } = speakBodySchema.parse(bodyOf(req.body));

      const normalizedBaseURLResult = normalizeCustomOpenAIBaseURL(baseURL);
      if (normalizedBaseURLResult.error) {
        return res.status(400).json({ error: normalizedBaseURLResult.error });
      }
      const normalizedBaseURL = normalizedBaseURLResult.value;

      const endpointPathResult = normalizeEndpointPath(endpointPath);
      if (endpointPathResult.error) {
        return res.status(400).json({ error: endpointPathResult.error });
      }
      const normalizedEndpointPath = endpointPathResult.value;
      if (normalizedEndpointPath && !normalizedBaseURL) {
        return res.status(400).json({ error: 'A custom endpoint path needs a custom server URL' });
      }

      console.log('[TTS] Request received:', { voice, model, speed, textLength: text?.length, hasApiKey: !!apiKey, hasBaseURL: !!baseURL });

      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      if (isEnterpriseMode() && !normalizedBaseURL) {
        return res.status(403).json({ error: ENTERPRISE_MODE_ERROR });
      }

      const { ttsService } = await getTtsModule();

      const hasServerKey = await ttsService.isAvailable();
      const hasCustomBaseURL = normalizedBaseURL !== undefined && normalizedBaseURL.length > 0;
      const requestKey = apiKey?.trim() ? apiKey.trim() : undefined;
      const clientKey = requestKey ?? readVoiceKey(hasCustomBaseURL ? 'openaiCompatible' : 'openai');
      const hasClientKey = Boolean(clientKey);

      if (!hasServerKey && !hasClientKey && !hasCustomBaseURL) {
        return res.status(503).json({ 
          error: 'TTS service not available. Please configure OpenAI in OpenCode, provide an API key, or set a custom server URL in settings.' 
        });
      }

      const textToSpeak = text.trim();

      const result = await ttsService.generateSpeechStream({
        text: textToSpeak,
        voice,
        model,
        speed,
        instructions,
        apiKey: clientKey,
        baseURL: hasCustomBaseURL ? normalizedBaseURL : undefined,
        endpointPath: hasCustomBaseURL ? normalizedEndpointPath : undefined,
      });

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Length', result.buffer.length);
      res.send(result.buffer);
    } catch (error) {
      console.error('[TTS] Error:', error);
      if (!res.headersSent) {
        const detail = speakBodySchema.parse(bodyOf(req.body));
        res.status(500).json({
          error: error instanceof Error ? error.message : 'TTS generation failed',
          detail: { model: detail.model, voice: detail.voice, hasBaseURL: !!detail.baseURL },
        });
      }
    }
  });

  app.post('/api/text/summarize', async (req, res) => {
    try {
      const { text, threshold = 200, maxLength = 500, mode = 'tts' } = summarizeBodySchema.parse(bodyOf(req.body));

      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      const result = await summarizeText({
        text,
        threshold,
        maxLength,
        mode,
      });

      return res.json(result);
    } catch (error) {
      console.error('[Summarize] Error:', error);
      const body = summarizeBodySchema.parse(bodyOf(req.body));
      const sanitized = body.mode === 'note'
        ? sanitizeForNote(body.text || '')
        : sanitizeForTTS(body.text || '');
      return res.json({ summary: sanitized, summarized: false, reason: error instanceof Error ? error.message : undefined });
    }
  });

  app.get('/api/tts/status', async (_req, res) => {
    try {
      const { ttsService } = await getTtsModule();
      const enterpriseMode = isEnterpriseMode();
      res.json({
        available: !enterpriseMode && await ttsService.isAvailable(),
        enterpriseMode,
        voices: [
          'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
          'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'
        ]
      });
    } catch {
      res.status(500).json({ error: 'Failed to check TTS status' });
    }
  });

  app.get('/api/tts/say/status', async (_req, res) => {
    res.json(await sayTTSCapability);
  });

  app.post('/api/tts/say/speak', async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Send the speech request as JSON' });
    }
    try {
      const { text, rate = 200, language, languageSample, voice: requestedVoice } = sayBodySchema.parse(bodyOf(req.body));
      let voice = requestedVoice?.trim() ? requestedVoice.trim() : 'Samantha';
      
      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Text is required' });
      }

      // Validate before the platform check so malformed input is a 400
      // everywhere, not a shell string on macOS and a 503 elsewhere.
      const parsedRate = parseSayRate(rate);
      if (parsedRate === null) {
        return res.status(400).json({ error: 'Invalid rate: expected an integer between 50 and 1000' });
      }
      if (!isSafeSayVoice(voice)) {
        return res.status(400).json({ error: 'Invalid voice name' });
      }

      if (process.platform !== 'darwin') {
        return res.status(503).json({ error: 'macOS say command not available on this platform' });
      }

      let resolvedLanguage: string | null = null;
      if (language === 'auto') {
        const capability = await sayTTSCapability;
        const voices = Array.isArray(capability?.voices) ? capability.voices : [];
        const sample = languageSample?.trim() ? languageSample.slice(0, 4000) : text;
        resolvedLanguage = detectTextLanguage(sample).language;
        const chosen = voices.find((entry) => entry.name === voice);
        if (languageOfLocale(chosen?.locale) !== resolvedLanguage) {
          const match = pickVoiceForLanguage(resolvedLanguage, voices);
          if (match) voice = match;
        }
      }
      
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs');
      const os = await import('os');
      const path = await import('path');
      const execFileAsync = promisify(execFile);

      // Create temp file for audio output (use m4a for browser compatibility)
      const tempDir = os.tmpdir();
      const tempFile = path.join(tempDir, `say-${Date.now()}.m4a`);

      // Generate audio file using 'say' via execFile: voice, rate, file,
      // and text are argv entries, never a shell command string, so no
      // field can break out into shell syntax.
      // -o outputs to file, -r sets rate (words per minute)
      // --data-format=aac outputs as m4a which browsers can decode
      console.log('[TTS-Say] Generating speech:', { textLength: text.length, voice, rate: parsedRate });

      await execFileAsync('say', buildSayArgs({ voice, rate: parsedRate, tempFile, text: text.trim() }));
      
      // Read the generated audio file
      const audioBuffer = await fs.promises.readFile(tempFile);

      fs.promises.unlink(tempFile).catch(() => {});

      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('X-Speech-Voice', speechVoiceHeaderValue(voice));
      if (resolvedLanguage) res.setHeader('X-Speech-Language', resolvedLanguage);
      res.setHeader('Content-Length', audioBuffer.length);
      res.send(audioBuffer);
    } catch (error) {
      console.error('[TTS-Say] Error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Say command failed'
      });
    }
  });

  app.post(
    '/api/stt/transcribe',
    express.raw({ type: (req) => (req.headers['content-type'] || '').startsWith('audio/'), limit: '20mb' }),
    async (req, res) => {
      try {
        const { transcribeAudio } = await import('./stt.js');

        const headers = sttHeadersSchema.parse(req.headers);
        const [mimeType = ''] = (headers['content-type'] || 'audio/webm').split(',').map((part) => part.trim());
        const baseURL = headers['x-base-url']?.trim() ?? '';
        const model = headers['x-model']?.trim() || 'deepdml/faster-whisper-large-v3-turbo-ct2';
        const language = headers['x-language']?.trim() || undefined;
        const endpointPathResult = normalizeEndpointPath(headers['x-endpoint-path']);
        if (endpointPathResult.error) {
          return res.status(400).json({ error: endpointPathResult.error });
        }
        const endpointPath = endpointPathResult.value;
        const authHeader = headers.authorization?.trim() ?? '';
        const apiKey = (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined) || readVoiceKey('stt');

        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Audio data is required' });
        }

        if (!baseURL) {
          return res.status(400).json({ error: 'X-Base-URL header is required' });
        }

        console.log('[STT] Transcribing audio:', {
          bytes: req.body.length,
          mimeType,
          model,
          baseURL,
          language,
          hasApiKey: !!apiKey,
        });

        const transcript = await transcribeAudio({
          audioBuffer: req.body,
          mimeType,
          model,
          baseURL,
          apiKey,
          language,
          endpointPath,
        });

        console.log('[STT] Transcript:', transcript?.slice(0, 120));
        res.json({ transcript: transcript ?? '' });
      } catch (error) {
        console.error('[STT] Error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: error instanceof Error ? error.message : 'Transcription failed',
          });
        }
      }
    }
  );
}
