export type AgentModelMapping = Record<string, string>;

export interface ModelProfile {
  id: string;              // UUID v4
  name: string;            // User-given name, 1-64 chars
  agentModels: AgentModelMapping;  // agentName → "providerId/modelId"
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}

export interface ModelProfilesState {
  profiles: ModelProfile[];
  selectedProfileId: string | null;
  isLoading: boolean;
  error: string | null;
  // Actions
  loadProfiles: () => Promise<void>;
  createProfile: (name: string, agentModels: AgentModelMapping) => Promise<ModelProfile | null>;
  createFromCurrent: (name: string) => Promise<ModelProfile | null>;
  updateProfile: (id: string, updates: { name?: string; agentModels?: AgentModelMapping }) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  applyProfile: (id: string) => Promise<void>;
  selectProfile: (id: string | null) => void;
}
