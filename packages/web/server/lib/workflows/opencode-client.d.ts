import type { OpenCode, SessionApi, SessionCreateInput } from '@opencode/client';

export type WorkflowSessionCreateInput = Omit<SessionCreateInput, 'model'> & {
  model?: (Omit<NonNullable<SessionCreateInput['model']>, 'variant'> & { variant?: string | undefined }) | null | undefined;
};

export type WorkflowSessionRequest = { -readonly [Key in keyof WorkflowSessionCreateInput]: WorkflowSessionCreateInput[Key] };

export interface WorkflowSessionClient {
  session: Pick<SessionApi, 'get' | 'prompt' | 'interrupt'> & {
    create(input?: WorkflowSessionCreateInput): ReturnType<SessionApi['create']>;
  };
  message: ReturnType<typeof OpenCode.make>['message'];
}

export type WorkflowClientFactory = (options: Parameters<typeof OpenCode.make>[0]) => WorkflowSessionClient;
