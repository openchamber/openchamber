export interface AssistTargets {
  recap: boolean;
  suggestion: boolean;
}

export interface AssistMessage {
  id: string;
  role: string;
  created: number | null;
  completed: number | null;
  transparent: boolean;
  providerID: string | undefined;
  modelID: string | undefined;
  snapshotFiles: readonly string[] | null;
  complete: boolean;
  text: string;
  authored: string;
}

export interface AssistTurn {
  user: AssistMessage;
  assistant: AssistMessage | null;
  complete: boolean;
  changedFiles: Set<string> | null;
}

export interface CompletedAssistTurns extends Array<AssistTurn> {
  at(index: -1): AssistTurn & { assistant: AssistMessage };
  at(index: number): AssistTurn | undefined;
}

export interface AssistContext {
  turns: CompletedAssistTurns;
  last: AssistMessage;
}
