/**
 * Web Worker for off-main-thread Whisper transcription.
 *
 * Receives `{ type: 'load', modelId }` to load a model, then
 * `{ type: 'transcribe', audio: Float32Array (transferred buffer), language? }`
 * to run inference. Posts progress, results, and errors back.
 */

import { pipeline, env } from '@xenova/transformers';

let transcriber: unknown = null;

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data as { type: string };

  if (type === 'load') {
    const { modelId } = e.data as { modelId: string };
    try {
      env.backends.onnx.wasm.numThreads = 1;

      const fileDoneBytes = new Map<string, number>();
      let totalDone = 0;
      let totalEstimate = 0;

      transcriber = await pipeline('automatic-speech-recognition', modelId, {
        progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
          if (info.status === 'progress' && info.file) {
            const prevDone = fileDoneBytes.get(info.file) ?? 0;
            const currentDone = info.loaded ?? 0;
            const delta = Math.max(0, currentDone - prevDone);
            fileDoneBytes.set(info.file, currentDone);
            totalDone += delta;

            if (info.total && info.total > totalEstimate) {
              totalEstimate = info.total;
            }

            const effectiveTotal = Math.max(totalEstimate, totalDone);
            const pct = effectiveTotal > 0 ? Math.min(100, Math.round((totalDone / effectiveTotal) * 100)) : 0;
            self.postMessage({ type: 'progress', progress: pct });
          }
        },
      });

      self.postMessage({ type: 'loaded' });
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: err instanceof Error ? err.message : 'Failed to load model',
      });
    }
  } else if (type === 'transcribe') {
    if (!transcriber) {
      self.postMessage({ type: 'error', error: 'Model not loaded', seq: (e.data as { seq?: number }).seq });
      return;
    }

    const { audio, language, seq } = e.data as { audio: ArrayBuffer; language?: string; seq?: number };

    try {
      const samples = new Float32Array(audio);
      if (samples.length === 0) {
        self.postMessage({ type: 'error', error: 'Empty audio received', seq });
        return;
      }

      self.postMessage({ type: 'log', text: `Transcribing ${samples.length} samples (${(samples.length / 16000).toFixed(1)}s)` });

      const pipelineFn = transcriber as (
        input: Float32Array,
        options?: Record<string, unknown>,
      ) => Promise<{ text: string }>;

      const result = await pipelineFn(samples, {
        task: 'transcribe',
        ...(language ? { language } : {}),
      });

      self.postMessage({
        type: 'result',
        transcript: (result?.text ?? '').trim(),
        seq,
      });
    } catch (err) {
      self.postMessage({
        type: 'error',
        error: err instanceof Error ? err.message : 'Transcription failed',
        seq,
      });
    }
  }
};
