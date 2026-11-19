import type { createOpenCodeClient } from '../openchamber-sessions/opencode-client.js';

type InstructionEntries = ReturnType<typeof createOpenCodeClient>['experimental']['session']['instructions']['entry'];

export interface KnowledgeNote {
  id: string;
  body: string;
  createdAt: number;
}

export interface KnowledgePlan {
  id: string;
  title: string;
  body: string;
}

export interface MemoryTitle {
  title: string;
  createdAt: number;
  updatedAt?: number;
  flagged?: boolean;
}

export interface MemoryIndex {
  global: MemoryTitle[];
  project: MemoryTitle[];
  enabled?: boolean;
  complete?: boolean;
}

export interface MemoryIndexMeasurement {
  budget: number;
  used: number;
  omitted: number;
}

export interface SessionPins {
  notes: string[];
  plans: string[];
}

export interface Checkout {
  directory: string;
  branch: string;
  placeholder?: boolean;
}

export interface KnowledgeInput {
  notes: KnowledgeNote[];
  plans: KnowledgePlan[];
  memory: MemoryIndex;
  linking?: boolean;
  naming?: boolean;
  rendering?: boolean;
  secrets?: boolean;
  workflows?: boolean;
  checkout?: Checkout | null;
  responseStyleInstruction?: string | null | undefined;
  extensions?: string | undefined;
}

export interface KnowledgeEntries {
  'openchamber.pinned': string;
  'openchamber.memory': string;
  'openchamber.guidance': string;
  'openchamber.checkout'?: string;
  'openchamber.response-style'?: string;
  'openchamber.extensions'?: string;
}

export interface KnowledgeSummary {
  notes: Pick<KnowledgeNote, 'id' | 'body'>[];
  plans: Pick<KnowledgePlan, 'id' | 'title'>[];
  memory: { global: number; project: number };
}

export interface GuidanceOptions {
  linking: boolean;
  naming: boolean;
  rendering: boolean;
  secrets: boolean;
  workflows: boolean;
}

export interface SessionKnowledgeDependencies {
  projectContextRuntime: {
    readContext: (projectId: string) => Promise<{
      notes: KnowledgeNote[];
      plans: Pick<KnowledgePlan, 'id' | 'title'>[];
    }>;
    readPlan: (projectId: string, planId: string) => Promise<{ body: string } | null>;
  };
  agentMemoryRuntime: {
    readAll: (projectId: string | null) => Promise<{
      global: MemoryTitle[];
      project: MemoryTitle[];
      globalFailed: boolean;
      projectFailed: boolean;
    }>;
  };
  resolveProjectId: (directory: string) => Promise<string | null>;
  isAgentMemoryEnabled?: () => Promise<boolean>;
  isMemoryToolAvailable?: () => Promise<boolean>;
  isSessionLinkingAvailable?: (() => boolean | Promise<boolean>) | null;
  isWorkNamingAvailable?: (directory: string) => boolean | Promise<boolean>;
  readCheckoutBranch?: ((directory: string) => string | null | Promise<string | null>) | null;
  readPlaceholderBranch?: ((directory: string, branch: string) => string | null | Promise<string | null>) | null;
  isPageRenderingAvailable?: () => boolean | Promise<boolean>;
  isSecretRequestAvailable?: () => boolean | Promise<boolean>;
  isWorkflowAvailable?: () => boolean | Promise<boolean>;
  readExtensionInstructions?: (directory: string) => Promise<string | null>;
  readSessionMetadata?: ((sessionId: string) => Promise<SessionMetadata>) | null;
  persistSessionMetadata?: ((sessionId: string, directory: string, patch: {
    openchamber: { project_context_pins: SessionPins };
  }) => Promise<SessionMetadata>) | null;
  instructionEntries?: {
    put: (sessionId: string, directory: string, key: string, text: string) => ReturnType<InstructionEntries['put']>;
    remove: (sessionId: string, directory: string, key: string) => ReturnType<InstructionEntries['remove']>;
  } | null;
}
export interface SessionMetadata {
  openchamber?: unknown;
}

export interface OpenChamberMetadata {
  project_context_pins?: unknown;
}

export interface StoredPins {
  notes?: unknown;
  plans?: unknown;
}
