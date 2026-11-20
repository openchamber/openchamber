declare module 'openai' {
  import type { OpenAI as PublishedOpenAI, ClientOptions } from 'openai/client';
  import type { APIPromise } from 'openai/core/api-promise';
  import type { Transcription, TranscriptionCreateParamsNonStreaming } from 'openai/resources/audio/transcriptions';

  export type SpeechClientOptions = Pick<ClientOptions, 'baseURL' | 'fetch'> & { apiKey: unknown };
  export type SpeechTranscriptionParams = Omit<TranscriptionCreateParamsNonStreaming<'json'>, 'model' | 'language'> & {
    model: unknown;
    language?: unknown;
  };

  type SpeechTranscriptionClient = PublishedOpenAI & {
    audio: { transcriptions: { create(body: SpeechTranscriptionParams): APIPromise<Transcription> } };
  };

  export type OpenAI = PublishedOpenAI;
  export const OpenAI: typeof PublishedOpenAI & {
    new(options: SpeechClientOptions): SpeechTranscriptionClient;
  };
  export default OpenAI;

  export type { ClientOptions, DataResidency } from 'openai/client';
  export { type Uploadable, toFile, toStreamingFile } from 'openai/core/uploads';
  export { APIPromise } from 'openai/core/api-promise';
  export { PagePromise } from 'openai/core/pagination';
  export { OpenAIError, APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError, NotFoundError, ConflictError, RateLimitError, BadRequestError, AuthenticationError, InternalServerError, PermissionDeniedError, UnprocessableEntityError, InvalidWebhookSignatureError, OAuthError, SubjectTokenProviderError } from 'openai/core/error';
  export { AzureOpenAI, type AzureClientOptions } from 'openai/azure';
  export { BedrockOpenAI, type BedrockClientOptions } from 'openai/bedrock';
}
