type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type SkillPolicyScope = 'global' | 'project';
export type SkillPolicyLocation = 'experimental.policies' | 'policies';

/** One entry of OpenCode's `GET /api/config`, lowest priority first. */
export type SkillPolicyConfigEntry =
  | { type: 'document'; path?: string; info: JsonObject }
  | { type: 'directory'; path: string };

/** What the service reads from the running OpenCode; both reject when it cannot be read. */
export type SkillPolicyOpenCodeReader = {
  readVersion: () => Promise<string | null>;
  readConfigEntries: (directory: string | null) => Promise<SkillPolicyConfigEntry[]>;
};

export type SkillPolicyDecision = {
  path: string | null;
  resource: string;
  effect: 'allow' | 'deny';
};

export type SkillPolicyState = {
  disabledIn: Record<SkillPolicyScope, boolean | null>;
  effective: 'enabled' | 'disabled' | 'unknown';
  decidedBy: (SkillPolicyDecision & { scope: SkillPolicyScope | 'other'; owned: boolean }) | null;
};

export type SkillPolicyScopeTarget = { path: string; error: string | null };

export type SkillPolicySummary = {
  version: string | null;
  location: SkillPolicyLocation | null;
  writable: boolean;
  effectiveAvailable: boolean;
  scopes: { global: SkillPolicyScopeTarget; project: SkillPolicyScopeTarget | null };
};

export type SkillPolicyWriteResult = {
  saved: { scope: SkillPolicyScope; path: string; disabled: boolean; changed: boolean };
  confirmed: boolean;
  state: SkillPolicySummary;
  policy: SkillPolicyState;
};

export type SkillPolicyScopeFile = { scope: SkillPolicyScope; path: string };

export type SkillRenameCarry = {
  owning: SkillPolicyScopeFile[];
  carried: SkillPolicyScopeFile[];
  undo: () => Promise<Array<SkillPolicyScopeFile & { error: string }>>;
  finish: () => Promise<{
    removed: SkillPolicyScopeFile[];
    kept: SkillPolicyScopeFile[];
    failed: Array<SkillPolicyScopeFile & { error: string }>;
  }>;
};

export type SkillRenameSwitches = {
  carried: SkillPolicyScopeFile[];
  oldRuleRemoved: SkillPolicyScopeFile[];
  oldRuleKept: SkillPolicyScopeFile[];
  oldRuleCleanupFailed: Array<SkillPolicyScopeFile & { error: string }>;
};

export type SkillPolicyService = {
  readState: (input: {
    directory: string | null;
    ids: string[];
    openCode: SkillPolicyOpenCodeReader;
  }) => Promise<SkillPolicySummary & { skills: Array<SkillPolicyState & { id: string }> }>;
  setEnabled: (input: {
    directory: string | null;
    id: JsonValue | undefined;
    scope: JsonValue | undefined;
    enabled: JsonValue | undefined;
    openCode: SkillPolicyOpenCodeReader;
  }) => Promise<SkillPolicyWriteResult>;
  carryForRename: (input: {
    directory: string | null;
    oldId: string;
    newId: string;
    keepOldRules: boolean;
  }) => Promise<SkillRenameCarry>;
};

export function skillPolicyLocation(version: string | null | undefined): SkillPolicyLocation | null;
export function isValidSkillPolicyId(id: JsonValue | undefined): id is string;
export function skillIdFromPath(skillPath: string | null | undefined): string | null;
export function listOwnedSkillDenies(config: JsonObject, location?: SkillPolicyLocation | null): string[];
export function setSkillDisabled(config: JsonObject, id: string, disabled: boolean, location: SkillPolicyLocation): boolean;
export function findDecidingSkillStatement(
  entries: SkillPolicyConfigEntry[],
  id: string,
  location?: SkillPolicyLocation | null,
): SkillPolicyDecision | null;

export function createSkillPolicyService<Config>(dependencies: {
  resolveTargets: (directory: string | null) => { global: string; project: string | null };
  readConfigFile: (filePath: string) => Config;
  writeConfig: (config: Config, filePath: string) => void;
  samePath?: (left: string, right: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  confirmAttempts?: number;
  confirmDelayMs?: number;
}): SkillPolicyService;

export function handleSkillPolicyWrite(input: {
  service: SkillPolicyService;
  body: JsonValue | undefined;
  directory: string | null;
  openCode: SkillPolicyOpenCodeReader;
  listInstalledSkillIds: (directory: string | null) => Promise<Set<string>>;
}): Promise<{ status: number; body: JsonObject }>;

export function carryOwnedSkillDeny(config: JsonObject, oldId: string, newId: string): string[][];

export function renameSkillKeepingSwitches(input: {
  service: SkillPolicyService;
  directory: string | null;
  listSkillFiles: (directory: string | null) => Promise<Array<{ id?: string | null; path: string }>>;
  rename: (
    beforeMove: (paths: { oldPath: string; newPath: string }) => Promise<{ undo: () => Promise<void> } | null>,
  ) => Promise<string | null>;
}): Promise<{ newPath: string | null; switches: SkillRenameSwitches | null }>;
