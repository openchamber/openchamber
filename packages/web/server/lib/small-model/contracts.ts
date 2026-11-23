import type {
  ExperimentalGenerateTextInput,
  OpenCode,
  OpenCodeClient,
} from '@opencode/client/promise';

type GenerateAPI = OpenCodeClient['experimental']['generate'];

export type ForwardedGenerationInput = Omit<ExperimentalGenerateTextInput, 'model'> & {
  model?: {
    id: unknown;
    providerID: unknown;
    variant?: string;
  } | null | undefined;
};

export type SmallModelClient = Omit<OpenCodeClient, 'experimental'> & {
  experimental: Omit<OpenCodeClient['experimental'], 'generate'> & {
    generate: Omit<GenerateAPI, 'text'> & {
      text: (
        input: ForwardedGenerationInput,
        options?: OpenCode.RequestOptions,
      ) => ReturnType<GenerateAPI['text']>;
    };
  };
};
