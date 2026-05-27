declare module '@xenova/transformers' {
  export const env: {
    allowLocalModels: boolean;
    backends: {
      onnx: {
        wasm: {
          numThreads: number;
        };
      };
    };
  };

  export function pipeline(
    task: 'automatic-speech-recognition',
    model: string,
    options?: {
      progress_callback?: (info: { status?: string; file?: string; loaded?: number; total?: number }) => void;
    },
  ): Promise<(input: Float32Array, options?: Record<string, unknown>) => Promise<{ text: string }>>;
}
