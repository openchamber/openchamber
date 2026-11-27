import express from 'express';
import { z } from 'zod';

import type { Application } from '../shared/http-contracts.js';
import type { SayTtsCapability } from './capability-runtime.js';
import { normalizeCustomOpenAIBaseURL } from './base-url.js';
import { normalizeEndpointPath } from './endpoint-path.js';
import { summarizeText, sanitizeForTTS, sanitizeForNote } from '../text/summarization.js';

import { detectTextLanguage, languageOfLocale, pickVoiceForLanguage } from './language-detect.js';
import { ENTERPRISE_MODE_ERROR, isEnterpriseMode } from '../enterprise-mode.js';
import { approveProviderServer, approveSpeechServer, describeVoiceKeys, readSpeechServerKey, readVoiceKey, speechServerKeyId, updateVoiceKeys, voiceKeysPatchSchema } from './voice-keys.js';
import { approvedProviderKey, describeKeyProviders, findKeyProvider } from './provider-keys.js';
import { listCustomServerVoices } from './voices.js';

const optionalText = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

const speakBodySchema = z.object({
  text: optionalText,
  voice: optionalText,
  model: optionalText,
  speed: optionalNumber,
  instructions: optionalText,
  apiKey: optionalText,
  keyProvider: optionalText,
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
  rate: optionalNumber,
  language: z.unknown().optional(),
  languageSample: optionalText,
}).catch({});

const voicesBodySchema = z.object({
  baseURL: z.unknown().optional(),
  keyProvider: optionalText,
}).catch({});

const voicesApprovalBodySchema = z.object({
  baseURL: z.unknown().optional(),
  keyId: optionalText,
  keyProvider: optionalText,
}).catch({});

const voiceKeysQuerySchema = z.object({ speechServer: optionalText }).catch({});

const keyProvidersQuerySchema = z.object({ baseURL: optionalText }).catch({});

const sttHeadersSchema = z.object({
  'content-type': optionalText,
  'x-base-url': optionalText,
  'x-key-provider': optionalText,
  'x-model': optionalText,
  'x-language': optionalText,
  'x-endpoint-path': z.unknown().optional(),
  authorization: optionalText,
}).catch({});

const checkVoicesBaseURL = (baseURL: z.infer<typeof voicesBodySchema>['baseURL']) => {
  const base = normalizeCustomOpenAIBaseURL(baseURL);
  if (base.value) return { value: base.value };
  return {
    status: base.code === 'enterprise_mode' ? 403 : 400,
    error: base.error ?? 'A custom server URL is required',
    code: base.code ?? 'invalid_base_url',
  };
};

const bodyOf = <Body>(body: Body) => body || {};

export function speechVoiceHeaderValue(voice: string) {
  return encodeURIComponent(voice);
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
    res.json({ ...describeVoiceKeys(), openaiCompatibleKeyId: speechServerKeyId() });
  });

  app.put('/api/voice/keys', express.json({ limit: '16kb' }), (req, res) => {
    try {
      const state = updateVoiceKeys(voiceKeysPatchSchema.parse(req.body), voiceKeysQuerySchema.parse(req.query).speechServer);
      res.json({ ...state, openaiCompatibleKeyId: speechServerKeyId() });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid voice keys' });
    }
  });

  app.get('/api/voice/key-providers', async (req, res) => {
    try {
      res.json({ providers: await describeKeyProviders(keyProvidersQuerySchema.parse(req.query).baseURL) });
    } catch (error) {
      console.warn('[voice] OpenCode providers are unreadable:', error instanceof Error ? error.message : error);
      res.status(503).json({ error: 'The OpenCode providers could not be read' });
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
      const { text, voice = 'nova', model = 'gpt-4o-mini-tts', speed = 0.9, instructions, apiKey, keyProvider, baseURL, endpointPath } = speakBodySchema.parse(bodyOf(req.body));

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

      const hasCustomBaseURL = normalizedBaseURL !== undefined && normalizedBaseURL.length > 0;
      const requestKey = apiKey?.trim() ? apiKey.trim() : undefined;
      const typedKey = requestKey ?? readVoiceKey(hasCustomBaseURL ? 'openaiCompatible' : 'openai');
      const providerKey = typedKey === undefined ? await approvedProviderKey(keyProvider, normalizedBaseURL) : undefined;

      if (!hasCustomBaseURL && !typedKey && !(await ttsService.isAvailable())) {
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
        apiKey: typedKey,
        providerKey,
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

  app.post('/api/tts/voices', async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Send the voice list request as JSON' });
    }
    const { baseURL, keyProvider } = voicesBodySchema.parse(bodyOf(req.body));
    const base = checkVoicesBaseURL(baseURL);
    if (!base.value) return res.status(base.status).json({ error: base.error, code: base.code });
    const typed = readSpeechServerKey(base.value);
    const providerKey = typed === null ? await approvedProviderKey(keyProvider, base.value) : undefined;
    const result = await listCustomServerVoices(base.value, { apiKey: typed?.approvedKey, providerKey });
    if (result.code) {
      const keyWithheld = result.code === 'rejected_key' && typed !== null && typed.approvedKey === undefined;
      return res.status(502).json({ code: keyWithheld ? 'key_not_sent' : result.code, keyId: typed?.keyId });
    }
    return res.json({ voices: result.voices, keyId: typed?.keyId });
  });

  app.post('/api/tts/voices/approval', async (req, res) => {
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'Send the approval as JSON' });
    }
    const { baseURL, keyId, keyProvider } = voicesApprovalBodySchema.parse(bodyOf(req.body));
    const base = checkVoicesBaseURL(baseURL);
    if (!base.value) return res.status(base.status).json({ error: base.error, code: base.code });
    try {
      if (!keyProvider) return res.json({ approval: approveSpeechServer(base.value, keyId ?? '') });
      const provider = await findKeyProvider(keyProvider);
      return res.json({ approval: provider ? approveProviderServer(provider, base.value, keyId ?? '') : 'refused' });
    } catch (error) {
      console.error('[TTS] Could not store the speech server approval:', error);
      return res.status(500).json({ error: 'Could not store the approval' });
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
      
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const execFileAsync = promisify(execFile);

      const tempFile = path.join(os.tmpdir(), `say-${Date.now()}.m4a`);

      console.log('[TTS-Say] Generating speech:', { textLength: text.length, voice, rate });

      await execFileAsync('say', ['-v', voice, '-r', String(rate), '-o', tempFile, '--data-format=aac', '--', text.trim()]);

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
        const apiKey = (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined)
          || readVoiceKey('stt');

        if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) {
          return res.status(400).json({ error: 'Audio data is required' });
        }

        if (!baseURL) {
          return res.status(400).json({ error: 'X-Base-URL header is required' });
        }

        const providerKey = apiKey ? undefined : await approvedProviderKey(headers['x-key-provider'], baseURL);
        console.log('[STT] Transcribing audio:', {
          bytes: req.body.length,
          mimeType,
          model,
          baseURL,
          language,
          hasApiKey: Boolean(apiKey || providerKey),
        });

        const transcript = await transcribeAudio({
          audioBuffer: req.body,
          mimeType,
          model,
          baseURL,
          apiKey,
          providerKey,
          language,
          endpointPath,
        });

        console.log('[STT] Transcript:', providerKey ? { length: transcript?.length } : transcript?.slice(0, 120));
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
