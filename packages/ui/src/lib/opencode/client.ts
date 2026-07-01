import { createOpencodeClient, OpencodeClient } from "@opencode-ai/sdk/v2";
import type { FilesAPI } from "../api/types";
import { getDesktopHomeDirectory } from "../desktop";
import type {
  Session,
  Message,
  Part,
  Provider,
  Config,
  Agent,
  TextPartInput,
  FilePartInput,
} from "@opencode-ai/sdk/v2";
import type { PermissionRequest } from "@/types/permission";
import type { QuestionRequest } from "@/types/question";
import { getRuntimeUrlResolver } from "@/lib/runtime-url";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { getRuntimeKey } from "@/lib/runtime-switch";
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry";
import { markStartupTrace } from "@/lib/startupTrace";
import {
  assertProviderCircuitClosed,
  recordProviderSuccess,
  recordProviderError,
  shouldRetry,
  getRetryDelayMs,
} from "./provider-tracker";

// Use relative path by default (works with both dev and nginx proxy server)
// Can be overridden with VITE_OPENCODE_URL for absolute URLs in special deployments
const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || "/api";
const CONFIG_CACHE_TTL_MS = 10_000;

/**
 * Render an SDK error payload into a short string for Error messages.
 * The SDK returns `{data, error}` shape without throwing on non-2xx; methods
 * that need to signal failure (so callers can preserve state instead of
 * conflating failure with an empty success) wrap the error with this helper.
 */
function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
type SdkResult<T> = {
  data?: T;
  error?: unknown;
  response?: { status?: number };
};

function unwrapSdkData<T>(result: SdkResult<T>, operation: string): T {
  if (result.error) {
    const status = result.response?.status;
    const error = new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`) as Error & { status?: number };
    if (status !== undefined) error.status = status;
    throw error;
  }
  if (result.data === undefined || result.data === null) {
    throw new Error(`${operation} failed: empty response`);
  }
  return result.data;
}

function unwrapSdkOptional<T>(result: SdkResult<T>, operation: string): T | undefined {
  if (result.error) {
    const status = result.response?.status;
    const error = new Error(`${operation} failed${status ? ` (${status})` : ""}: ${formatSdkError(result.error)}`) as Error & { status?: number };
    if (status !== undefined) error.status = status;
    throw error;
  }
  return result.data;
}

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
const ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_RANDOM_LENGTH = 14;

let lastIdTimestamp = 0;
let idCounter = 0;

const randomBase62 = (length: number): string => {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += ID_RANDOM_CHARS[bytes[index] % ID_RANDOM_CHARS.length];
  }
  return result;
};

const ascendingId = (prefix: "msg"): string => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;

  const sortable = BigInt(timestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = new Uint8Array(6);
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  const hex = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}${randomBase62(ID_RANDOM_LENGTH)}`;
};

const isRetryableFetchError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  return false;
};

const ensureAbsoluteBaseUrl = (candidate: string): string => {
  const normalized = typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : "/api";

  if (ABSOLUTE_URL_PATTERN.test(normalized)) {
    return normalized;
  }

  if (typeof window === "undefined") {
    return normalized;
  }

  const baseReference = window.location?.href || window.location?.origin;
  if (!baseReference) {
    return normalized;
  }

  try {
    return new URL(normalized, baseReference).toString();
  } catch (error) {
    console.warn("Failed to normalize OpenCode base URL:", error);
    return normalized;
  }
};

const resolveRuntimeBaseUrl = (): string | null => {
  try {
    return getRuntimeUrlResolver().api('/api');
  } catch {
    return null;
  }
};

const createRuntimeOpencodeClient = (config: { baseUrl: string; directory?: string }): OpencodeClient => {
  return createOpencodeClient({
    ...config,
    fetch: runtimeFetch,
  });
};

interface App {
  version?: string;
  [key: string]: unknown;
}

type FilesystemEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink?: boolean;
};

export type ProjectFileSearchHit = {
  name: string;
  path: string;
  relativePath: string;
  extension?: string;
};

type AgentPartInputLite = {
  type: 'agent';
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
};

type FileInputLite = {
  id?: string;
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
};

type DirectorySwitchResult = {
  success: boolean;
  restarted: boolean;
  path: string;
  agents?: Agent[];
  providers?: Provider[];
  models?: unknown[];
};

const normalizeFsPath = (path: string): string => path.replace(/\\/g, "/");
const FS_LIST_CACHE_TTL_MS = 400;

const getDesktopFilesApi = (): FilesAPI | null => {
  const apis = getRegisteredRuntimeAPIs();
  if (apis && apis.runtime?.isDesktop && apis.files) {
    return apis.files;
  }
  return null;
};

class OpencodeService {
  private client: OpencodeClient;
  private baseUrl: string;
  private scopedClients: Map<string, OpencodeClient> = new Map();
  private currentDirectory: string | undefined = undefined;
  private directoryContextQueue: Promise<void> = Promise.resolve();
  private listDirectoryInFlight: Map<string, Promise<FilesystemEntry[]>> = new Map();
  private configProvidersInFlight: Map<string, Promise<{ providers: Provider[]; default: { [key: string]: string } }>> = new Map();
  private listAgentsInFlight: Map<string, Promise<Agent[]>> = new Map();
  private configInFlight: Map<string, Promise<Config>> = new Map();
  private configCache: Map<string, { config: Config; expiresAt: number }> = new Map();
  private configCacheGeneration = 0;
  private listDirectoryCache: Map<string, { entries: FilesystemEntry[]; expiresAt: number }> = new Map();

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    const runtimeBase = resolveRuntimeBaseUrl();
    const requestedBaseUrl = runtimeBase || baseUrl;
    this.baseUrl = ensureAbsoluteBaseUrl(requestedBaseUrl);
    this.client = createRuntimeOpencodeClient({ baseUrl: this.baseUrl });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  reconnectToRuntimeBaseUrl(): void {
    const runtimeBase = resolveRuntimeBaseUrl();
    const nextBaseUrl = ensureAbsoluteBaseUrl(runtimeBase || DEFAULT_BASE_URL);
    if (nextBaseUrl === this.baseUrl) {
      return;
    }
    this.baseUrl = nextBaseUrl;
    this.client = createRuntimeOpencodeClient({ baseUrl: this.baseUrl });
    this.scopedClients.clear();
    this.listDirectoryInFlight.clear();
    this.configProvidersInFlight.clear();
    this.listAgentsInFlight.clear();
    this.clearConfigCache();
    this.listDirectoryCache.clear();
  }

  /** Expose the raw SDK client for direct use (e.g., SyncProvider) */
  getSdkClient(): OpencodeClient {
    return this.client;
  }

  /** Get a scoped SDK client for a specific directory */
  getScopedSdkClient(directory: string): OpencodeClient {
    return this.getScopedApiClient(directory);
  }

  /**
   * Returns an SDK client scoped to a project directory.
   * Needed for worktree APIs where backend ignores per-call directory.
   */
  getScopedApiClient(directory: string): OpencodeClient {
    const normalized = this.normalizeCandidatePath(directory) ?? directory;
    const key = normalized || '';
    const existing = this.scopedClients.get(key);
    if (existing) {
      return existing;
    }
    const scoped = createRuntimeOpencodeClient({ baseUrl: this.baseUrl, directory: normalized });
    this.scopedClients.set(key, scoped);
    return scoped;
  }

  private normalizeCandidatePath(path?: string | null): string | null {
    if (typeof path !== 'string') {
      return null;
    }

    const trimmed = path.trim();
    if (!trimmed) {
      return null;
    }

    // Normalize backslashes and uppercase the Windows drive letter so that
    // d:\MyProject and D:\MyProject resolve to the same canonical form.
    const normalized = trimmed
      .replace(/\\/g, '/')
      .replace(/^([a-z]):/, (_, letter: string) => letter.toUpperCase() + ':');
    const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;

    return withoutTrailingSlash || null;
  }

  private deriveHomeDirectory(path: string): { homeDirectory: string; username?: string } {
    const windowsMatch = path.match(/^([A-Za-z]:)(?:\/|$)/);
    if (windowsMatch) {
      const drive = windowsMatch[1];
      const remainder = path.slice(drive.length + (path.charAt(drive.length) === '/' ? 1 : 0));
      const segments = remainder.split('/').filter(Boolean);

      if (segments.length >= 2) {
        const homeDirectory = `${drive}/${segments[0]}/${segments[1]}`;
        return { homeDirectory, username: segments[1] };
      }

      if (segments.length === 1) {
        const homeDirectory = `${drive}/${segments[0]}`;
        return { homeDirectory, username: segments[0] };
      }

      return { homeDirectory: drive, username: undefined };
    }

    const absolute = path.startsWith('/');
    const segments = path.split('/').filter(Boolean);

    if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
      const homeDirectory = `${absolute ? '/' : ''}${segments[0]}/${segments[1]}`;
      return { homeDirectory, username: segments[1] };
    }

    if (absolute) {
      if (segments.length === 0) {
        return { homeDirectory: '/', username: undefined };
      }
      const homeDirectory = `/${segments.join('/')}`;
      return { homeDirectory, username: segments[segments.length - 1] };
    }

    if (segments.length > 0) {
      const homeDirectory = `/${segments.join('/')}`;
      return { homeDirectory, username: segments[segments.length - 1] };
    }

    return { homeDirectory: '/', username: undefined };
  }

  // Set the current working directory for all API calls
  setDirectory(directory: string | undefined) {
    const normalized = this.normalizeCandidatePath(directory) ?? directory;
    if (this.currentDirectory !== normalized) {
      markStartupTrace('opencodeClient:setDirectory', {
        previous: this.currentDirectory ?? null,
        next: normalized ?? null,
      });
    }
    this.currentDirectory = normalized;
  }

  getDirectory(): string | undefined {
    return this.currentDirectory;
  }

  async withDirectory<T>(directory: string | undefined | null, fn: () => Promise<T>): Promise<T> {
    const runWithContext = async (): Promise<T> => {
      if (directory === undefined || directory === null) {
        return fn();
      }

      const previousDirectory = this.currentDirectory;
      const scopedDirectory = this.normalizeCandidatePath(directory) ?? directory;
      this.currentDirectory = scopedDirectory;
      try {
        return await fn();
      } finally {
        if (this.currentDirectory === scopedDirectory) {
          this.currentDirectory = previousDirectory;
        }
      }
    };

    const queuedRun = this.directoryContextQueue.then(runWithContext, runWithContext);
    this.directoryContextQueue = queuedRun.then(
      () => undefined,
      () => undefined,
    );

    return queuedRun;
  }

  // Get the raw API client for direct access
  getApiClient(): OpencodeClient {
    return this.client;
  }

  // Get system information including home directory
  async getSystemInfo(): Promise<{ homeDirectory: string; username?: string }> {
    const candidates = new Set<string>();
    const addCandidate = (value?: string | null) => {
      const normalized = this.normalizeCandidatePath(value);
      if (normalized) {
        candidates.add(normalized);
      }
    };

    try {
      const response = await this.client.path.get(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      const info = response.data;
      if (info) {
        addCandidate(info.directory);
        addCandidate(info.worktree);
        addCandidate(info.state);
      }
    } catch (error) {
      console.debug('Failed to load path info:', error);
    }

    if (!candidates.size) {
      try {
        const project = await this.client.project.current(
          this.currentDirectory ? { directory: this.currentDirectory } : undefined
        );
        addCandidate(project.data?.worktree);
      } catch (error) {
        console.debug('Failed to load project info:', error);
      }
    }

    if (!candidates.size) {
      try {
        const sessions = await this.listSessions();
        sessions.forEach((session) => addCandidate(session.directory));
      } catch (error) {
        console.debug('Failed to inspect sessions for system info:', error);
      }
    }

    addCandidate(this.currentDirectory);

    if (typeof window !== 'undefined') {
      try {
        addCandidate(window.localStorage.getItem('lastDirectory'));
        addCandidate(window.localStorage.getItem('homeDirectory'));
      } catch {
        // Access to storage failed (e.g. privacy mode)
      }
    }

    if (!candidates.size && typeof process !== 'undefined' && typeof process.cwd === 'function') {
      addCandidate(process.cwd());
    }

    if (!candidates.size) {
      return { homeDirectory: '/', username: undefined };
    }

    const [primary] = Array.from(candidates);
    return this.deriveHomeDirectory(primary);
  }

  /**
   * Best-effort probe whether a directory is accessible to OpenCode.
   * This is intentionally NOT the same as local filesystem access in the UI runtime.
   */
  async probeDirectory(directory: string): Promise<boolean> {
    const normalized = this.normalizeCandidatePath(directory);
    if (!normalized) {
      return false;
    }
    try {
      const response = await this.client.path.get({ directory: normalized });
      const info = response.data as { directory?: unknown } | undefined;
      const returned = typeof info?.directory === 'string' ? info.directory : null;
      return Boolean(returned && returned.trim().length > 0);
    } catch {
      return false;
    }
  }

  // Session Management
  async listSessions(): Promise<Session[]> {
    const response = await this.client.session.list(
      this.currentDirectory ? { directory: this.currentDirectory } : undefined
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  async createSession(params?: { parentID?: string; title?: string; metadata?: Record<string, unknown> }, directory?: string | null): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.session.create({
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      parentID: params?.parentID,
      title: params?.title,
      metadata: params?.metadata,
    });
    return unwrapSdkData(response, 'session.create');
  }

  async getSession(id: string, directory?: string | null): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.session.get({
      sessionID: id,
      ...(requestDirectory ? { directory: requestDirectory } : {})
    });
    return unwrapSdkData(response, 'session.get');
  }

  async deleteSession(id: string, directory?: string | null): Promise<boolean> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.session.delete({
      sessionID: id,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
    });
    return unwrapSdkOptional(response, 'session.delete') === true;
  }

  async updateSession(
    id: string,
    patch: { title?: string; metadata?: Record<string, unknown>; time?: { archived?: number | null } },
    directory?: string | null,
  ): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const sdkPatch = {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      ...(patch.time?.archived !== undefined && patch.time.archived !== null ? { time: { archived: patch.time.archived } } : {}),
    };
    const response = await this.client.session.update({
      sessionID: id,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      ...sdkPatch,
    });
    return unwrapSdkData(response, 'session.update');
  }

  async getSessionMessages(id: string, limit?: number): Promise<{ info: Message; parts: Part[] }[]> {
    const response = await this.client.session.messages({
      sessionID: id,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
    return unwrapSdkData(response, 'session.messages');
  }

  async getSessionTodos(sessionId: string): Promise<Array<{ id: string; content: string; status: string; priority: string }>> {
    try {
      const response = await this.client.session.todo({
        sessionID: sessionId,
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      });
      if (response.error) {
        return [];
      }

      const data = response.data;
      if (!data || !Array.isArray(data)) {
        return [];
      }

      return data as Array<{ id: string; content: string; status: string; priority: string }>;
    } catch {
      return [];
    }
  }

  /**
   * Check if MIME type needs normalization to text/plain.
   * Some text MIME types (like text/markdown) aren't supported by AI providers.
   */
  private shouldNormalizeToTextPlain(mime: string): boolean {
    if (!mime) return false;
    
    const lowerMime = mime.toLowerCase();
    
    // All text/* types except text/plain need normalization
    if (lowerMime.startsWith('text/') && lowerMime !== 'text/plain') {
      return true;
    }
    
    // Common application types that are actually text
    const textBasedTypes = [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/typescript',
      'application/x-yaml',
      'application/yaml',
      'application/toml',
      'application/x-sh',
      'application/x-shellscript',
      'application/octet-stream',
      'image/svg+xml',
    ];
    
    return textBasedTypes.includes(lowerMime);
  }

  /**
   * Check if MIME type is HEIC/HEIF (iPhone photo format).
   */
  private isHeicMime(mime: string): boolean {
    if (!mime) return false;
    const lowerMime = mime.toLowerCase();
    return lowerMime === 'image/heic' || lowerMime === 'image/heif';
  }

  /**
   * Convert HEIC image to JPEG.
   * Returns the original file if conversion fails.
   */
  private async convertHeicToJpeg(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
    try {
      // Dynamic import to avoid loading heic2any unless needed
      const heic2any = (await import('heic2any')).default;
      
      // Extract base64 data from data URL
      const commaIndex = file.url.indexOf(',');
      if (commaIndex === -1) return file;
      
      const base64Data = file.url.substring(commaIndex + 1);
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const heicBlob = new Blob([bytes], { type: file.mime });
      
      // Convert to JPEG
      const jpegBlob = await heic2any({
        blob: heicBlob,
        toType: 'image/jpeg',
        quality: 0.9,
      }) as Blob;
      
      // Convert back to data URL
      const jpegDataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(jpegBlob);
      });
      
      // Update filename extension
      let newFilename = file.filename;
      if (newFilename) {
        newFilename = newFilename.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
      }
      
      return {
        mime: 'image/jpeg',
        filename: newFilename,
        url: jpegDataUrl
      };
    } catch (error) {
      console.warn('Failed to convert HEIC to JPEG:', error);
      return file;
    }
  }

  /**
   * Normalize file part for sending to AI providers.
   * - Converts unsupported text MIME types to text/plain
   * - Converts HEIC/HEIF images to JPEG
   */
  private async normalizeFilePart(file: { mime: string; filename?: string; url: string }): Promise<{ mime: string; filename?: string; url: string }> {
    // Handle HEIC conversion
    if (this.isHeicMime(file.mime)) {
      return this.convertHeicToJpeg(file);
    }

    // Handle text MIME normalization
    if (!this.shouldNormalizeToTextPlain(file.mime)) {
      return file;
    }

    let normalizedUrl = file.url;
    
    // Update MIME type in data URL if present
    // Format: data:<mime>;base64,<content> or data:<mime>,<content>
    if (file.url.startsWith('data:')) {
      const commaIndex = file.url.indexOf(',');
      if (commaIndex !== -1) {
        const meta = file.url.substring(5, commaIndex); // after "data:"
        const content = file.url.substring(commaIndex); // includes comma
        
        // Replace the MIME type in meta, preserving ;base64 if present
        const newMeta = meta.replace(/^[^;,]+/, 'text/plain');
        normalizedUrl = `data:${newMeta}${content}`;
      }
    }

    return {
      mime: 'text/plain',
      filename: file.filename,
      url: normalizedUrl
    };
  }

  private async toNormalizedFilePartInput(file: FileInputLite): Promise<FilePartInput> {
    const normalized = await this.normalizeFilePart(file);
    return {
      ...(file.id ? { id: file.id } : {}),
      type: 'file',
      mime: normalized.mime,
      filename: normalized.filename,
      url: normalized.url,
    };
  }

  async sendMessage(params: {
    id: string;
    providerID: string;
    modelID: string;
    text: string;
    prefaceText?: string;
    prefaceTextSynthetic?: boolean;
    agent?: string;
    variant?: string;
    files?: Array<FileInputLite>;
    /** Additional text/file parts to include (for batch sending queued messages) */
    additionalParts?: Array<{
      text: string;
      synthetic?: boolean;
      files?: Array<FileInputLite>;
    }>;
    messageId?: string;
    agentMentions?: Array<{ name: string; source?: { value: string; start: number; end: number } }>;
    delivery?: 'steer';
    format?: {
      type: 'json_schema';
      schema: Record<string, unknown>;
      retryCount?: number;
    };
    directory?: string | null;
  }): Promise<string> {
    // Reuse one client-side message ID across retries. The server accepts this
    // as the real user message ID, making ambiguous network retries idempotent.
    const messageId = params.messageId ?? ascendingId("msg");

    // Build parts array using SDK types (TextPartInput | FilePartInput) plus lightweight agent parts
    const parts: Array<TextPartInput | FilePartInput | AgentPartInputLite> = [];

    if (params.prefaceText && params.prefaceText.trim()) {
      parts.push({
        type: 'text',
        text: params.prefaceText,
        synthetic: params.prefaceTextSynthetic !== false,
      });
    }

    // Add text part if there's content
    if (params.text && params.text.trim()) {
      const textPart: TextPartInput = {
        type: 'text',
        text: params.text
      };
      parts.push(textPart);
    }

    // Add file parts if provided (normalizing MIME types for compatibility)
    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        const filePart = await this.toNormalizedFilePartInput(file);
        parts.push(filePart);
      }
    }

    // Add additional parts (for batch/queued messages)
    if (params.additionalParts && params.additionalParts.length > 0) {
      for (const additional of params.additionalParts) {
        if (additional.text && additional.text.trim()) {
          parts.push({
            type: 'text',
            text: additional.text,
            ...(additional.synthetic ? { synthetic: true } : {}),
          });
        }
        if (additional.files && additional.files.length > 0) {
          for (const file of additional.files) {
            const filePart = await this.toNormalizedFilePartInput(file);
            parts.push(filePart);
          }
        }
      }
    }

    if (params.agentMentions && params.agentMentions.length > 0) {
      for (const mention of params.agentMentions) {
        if (!mention?.name) continue;
        parts.push({
          type: 'agent',
          name: mention.name,
          ...(mention.source ? { source: mention.source } : {}),
        });
      }
    }

    // Ensure we have at least one part
    if (parts.length === 0) {
      throw new Error('Message must have at least one part (text or file)');
    }

    const requestDirectory = this.normalizeCandidatePath(params.directory ?? null) ?? this.currentDirectory;

    if (params.format) {
      console.info('[git-generation][browser] send structured message', {
        sessionId: params.id,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: params.agent,
        variant: params.variant,
        directory: requestDirectory,
        baseUrl: this.baseUrl,
        formatType: params.format.type,
      });
    }

    assertProviderCircuitClosed(params.providerID);

    let response!: Response;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.client.session.promptAsync({
          sessionID: params.id,
          ...(requestDirectory ? { directory: requestDirectory } : {}),
          model: {
            providerID: params.providerID,
            modelID: params.modelID,
          },
          agent: params.agent,
          variant: params.variant,
          messageID: messageId,
          ...(params.delivery ? { delivery: params.delivery } : {}),
          ...(params.format ? { format: params.format } : {}),
          parts,
        });
        if (result.response instanceof Response) {
          response = result.response;
        } else if (result.error) {
          const status = (result as SdkResult<unknown>).response?.status || 500;
          response = new Response(JSON.stringify(result.error), { status });
        } else {
          response = new Response(JSON.stringify(result.data ?? true), { status: 200 });
        }
      } catch (error) {
        if (attempt < 2 && isRetryableFetchError(error)) {
          const delay = getRetryDelayMs(attempt);
          console.warn(
            `[prompt] fetch failed for ${params.providerID}/${params.modelID} (attempt ${attempt + 1}/3), retrying in ${delay}ms`,
            (error as Error)?.message
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        recordProviderError(params.providerID);
        throw error;
      }

      if (response.ok) {
        recordProviderSuccess(params.providerID);
        return messageId;
      }

      if (shouldRetry(params.providerID, response.status, attempt)) {
        const delay = getRetryDelayMs(attempt);
        console.warn(
          `[prompt] ${response.status} for ${params.providerID}/${params.modelID} (attempt ${attempt + 1}/3), retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const suffix = detail && detail.trim().length > 0 ? `: ${detail.trim()}` : '';
      const error = new Error(`Failed to send message (${response.status})${suffix}`);
      recordProviderError(params.providerID, response.status);
      throw error;
    }
    // Defensive fallback — all loop paths return/throw, but TypeScript
    // control flow analysis cannot prove exhaustiveness without this.
    throw new Error('Failed to send message after retries');
  }

  async sendCommand(params: {
    id: string;
    providerID: string;
    modelID: string;
    command: string;
    arguments?: string;
    agent?: string;
    variant?: string;
    files?: Array<FileInputLite>;
    messageId?: string;
    directory?: string | null;
  }): Promise<{ messageId: string; resolved: { info: Message; parts: Part[] } | null }> {
    const tempMessageId = params.messageId ?? ascendingId("msg");

    const parts: FilePartInput[] = [];
    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        parts.push(await this.toNormalizedFilePartInput(file));
      }
    }

    const requestDirectory = this.normalizeCandidatePath(params.directory ?? null) ?? this.currentDirectory;

    const response = await this.client.session.command({
      sessionID: params.id,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      command: params.command,
      arguments: params.arguments ?? '',
      model: `${params.providerID}/${params.modelID}`,
      agent: params.agent,
      variant: params.variant,
      ...(parts.length > 0 ? { parts } : {}),
      messageID: tempMessageId,
    });

    const data = unwrapSdkOptional(response, 'session.command');
    // The OpenCode server returns the resolved user message ({ info, parts })
    // from session.command, with `!`shell` expressions already substituted.
    // Previously we discarded it, so the UI had to rely entirely on the SSE
    // echo — and if the echo arrived with the template token unresolved, the
    // chat bubble showed a blank where the resolved value should be (#1944).
    // Surface the resolved payload so the caller can apply it through the
    // optimistic add path (which handles dedup against the later SSE echo).
    const resolved =
      data && typeof data === 'object' && 'info' in data && 'parts' in data
        ? (data as { info: Message; parts: Part[] })
        : null;
    return { messageId: tempMessageId, resolved };
  }

  async abortSession(id: string): Promise<boolean> {
    const response = await this.client.session.abort(
      {
        sessionID: id,
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
      },
      { throwOnError: true }
    );
    return Boolean(response.data);
  }

  async shellSession(params: {
    sessionId: string;
    command: string;
    agent: string;
    model: { providerID: string; modelID: string };
    messageId?: string;
    directory?: string | null;
  }): Promise<{ info: Message; parts: Part[] }> {
    const requestDirectory = this.normalizeCandidatePath(params.directory ?? null) ?? this.currentDirectory;
    const response = await this.client.session.shell({
      sessionID: params.sessionId,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      messageID: params.messageId,
      agent: params.agent,
      model: params.model,
      command: params.command,
    });
    return unwrapSdkData(response, 'session.shell') as { info: Message; parts: Part[] };
  }

  async revertSession(sessionId: string, messageId: string, partId?: string, directory?: string | null): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.session.revert({
      sessionID: sessionId,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      messageID: messageId,
      partID: partId,
    });
    return unwrapSdkData(response, 'session.revert');
  }

  async summarizeSession(sessionId: string, providerId: string, modelId: string, directory?: string | null): Promise<boolean> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.session.summarize({
      sessionID: sessionId,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      providerID: providerId,
      modelID: modelId,
    });
    return unwrapSdkOptional(response, 'session.summarize') === true;
  }

  async unrevertSession(sessionId: string): Promise<Session> {
    const response = await this.client.session.unrevert({
      sessionID: sessionId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
    });
    return unwrapSdkData(response, 'session.unrevert');
  }

  async forkSession(sessionId: string, messageId?: string, directory?: string | null): Promise<Session> {
    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.session.fork({
      sessionID: sessionId,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      messageID: messageId,
    });
    return unwrapSdkData(response, 'session.fork');
  }

  async getSessionStatus(): Promise<
    Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>
  > {
    return (await this.getSessionStatusForDirectory(this.currentDirectory ?? null)) ?? {};
  }

  /**
   * Returns the upstream `/session/status` map, or `null` if the fetch failed.
   *
   * `null` vs `{}` matters for reconnect resync: the server omits idle sessions
   * from the response, so an empty `{}` means "everything is idle" and a candidate
   * missing from the response is authoritatively idle. A network/HTTP failure must
   * not be conflated with that — return `null` so the caller can preserve state.
   */
  async getSessionStatusForDirectory(
    directory: string | null | undefined
  ): Promise<Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }> | null> {
    try {
      const trimmedDirectory = typeof directory === "string" ? directory.trim() : "";
      const result = await this.client.session.status(trimmedDirectory ? { directory: trimmedDirectory } : undefined);
      if (result.error || !result.data || typeof result.data !== "object") {
        return null;
      }
      return result.data as Record<
        string,
        { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }
      >;
    } catch {
      return null;
    }
  }

  async getGlobalSessionStatus(): Promise<
    Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>
  > {
    return (await this.getSessionStatusForDirectory(null)) ?? {};
  }

  /**
   * Get session activity from web server's in-memory tracking.
   * This is more reliable than getGlobalSessionStatus on visibility restore
   * because the web server tracks activity even when UI is not listening to SSE.
   */
  async getWebServerSessionActivity(): Promise<
    Record<string, { type: string }> | null
  > {
    try {
      const response = await runtimeFetch('/api/session-activity', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') {
        return null;
      }

      return data as Record<string, { type: string }>;
    } catch {
      return null;
    }
  }

  // Tools
  async listToolIds(options?: { directory?: string | null }): Promise<string[]> {
    try {
      const directory = typeof options?.directory === 'string'
        ? options.directory.trim()
        : (this.currentDirectory ? this.currentDirectory.trim() : '');

      const result = await this.client.tool.ids(directory ? { directory } : undefined);
      const tools = (result.data || []) as unknown as string[];
      return tools.filter((tool) => typeof tool === 'string' && tool !== 'invalid');
    } catch {
      return [];
    }
  }

  // Permissions
  async replyToPermission(
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    options?: { message?: string; directory?: string | null }
  ): Promise<boolean> {
    const requestDirectory = this.normalizeCandidatePath(options?.directory ?? null) ?? this.currentDirectory;
    const response = await this.client.permission.reply({
      requestID: requestId,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      reply,
      ...(options?.message ? { message: options.message } : {}),
    });
    return unwrapSdkOptional(response, 'permission.reply') === true;
  }

  /**
   * Throws on fetch/SDK failure. Callers that drive authoritative state from
   * the result (e.g. reconnect resync) must let the throw propagate so they
   * can preserve existing state instead of conflating "fetch failed" with
   * "server returned no pending permissions".
   */
  async listPendingPermissions(options?: { directories?: Array<string | null | undefined> }): Promise<PermissionRequest[]> {
    const fetches: Array<Promise<PermissionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<PermissionRequest[]> => {
      const trimmed = typeof directory === 'string' ? directory.trim() : '';
      const result = await this.client.permission.list(trimmed ? { directory: trimmed } : undefined);
      if (result.error) {
        throw new Error(`permission.list failed: ${formatSdkError(result.error)}`);
      }
      return (result.data || []) as unknown as PermissionRequest[];
    };

    // Try unscoped first (server may return global pending items).
    fetches.push(fetchForDirectory(null));

    const uniqueDirectories = new Set<string>();
    for (const entry of options?.directories ?? []) {
      const normalized = this.normalizeCandidatePath(entry ?? null);
      if (normalized) {
        uniqueDirectories.add(normalized);
      }
    }

    for (const directory of uniqueDirectories) {
      fetches.push(fetchForDirectory(directory));
    }

    const results = await Promise.all(fetches);
    const merged: PermissionRequest[] = [];
    const seenIds = new Set<string>();

    for (const list of results) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(item);
      }
    }

    return merged;
  }

  // Questions ("ask" tool)
  async replyToQuestion(requestId: string, answers: string[] | string[][], directory?: string | null): Promise<boolean> {
    const normalizedAnswers: string[][] = (() => {
      if (!Array.isArray(answers) || answers.length === 0) {
        return [];
      }
      if (Array.isArray(answers[0])) {
        return answers as string[][];
      }
      return [answers as string[]];
    })();

    const requestDirectory = this.normalizeCandidatePath(directory) ?? this.currentDirectory;
    const response = await this.client.question.reply({
      requestID: requestId,
      ...(requestDirectory ? { directory: requestDirectory } : {}),
      answers: normalizedAnswers,
    });
    return unwrapSdkOptional(response, 'question.reply') === true;
  }

  async rejectQuestion(requestId: string): Promise<boolean> {
    const result = await this.client.question.reject({
      requestID: requestId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
    });
    return unwrapSdkOptional(result, 'question.reject') === true;
  }

  /**
   * Throws on fetch/SDK failure. See {@link listPendingPermissions} for
   * rationale — resync paths preserve state on throw via outer try/catch
   * instead of conflating failure with an empty server response.
   */
  async listPendingQuestions(options?: { directories?: Array<string | null | undefined> }): Promise<QuestionRequest[]> {
    const fetches: Array<Promise<QuestionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<QuestionRequest[]> => {
      const trimmed = typeof directory === 'string' ? directory.trim() : '';
      const result = await this.client.question.list(trimmed ? { directory: trimmed } : undefined);
      if (result.error) {
        throw new Error(`question.list failed: ${formatSdkError(result.error)}`);
      }
      return (result.data || []) as unknown as QuestionRequest[];
    };

    // Try unscoped first (server may return global pending items).
    fetches.push(fetchForDirectory(null));

    const uniqueDirectories = new Set<string>();
    for (const entry of options?.directories ?? []) {
      const normalized = this.normalizeCandidatePath(entry ?? null);
      if (normalized) {
        uniqueDirectories.add(normalized);
      }
    }

    for (const directory of uniqueDirectories) {
      fetches.push(fetchForDirectory(directory));
    }

    const results = await Promise.all(fetches);
    const merged: QuestionRequest[] = [];
    const seenIds = new Set<string>();

    for (const list of results) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const id = (item as { id?: unknown }).id;
        if (typeof id !== 'string' || id.length === 0) continue;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        merged.push(item);
      }
    }

    return merged;
  }

  // Configuration
  clearConfigCache(): void {
    this.configCacheGeneration += 1;
    this.configInFlight.clear();
    this.configCache.clear();
  }

  async getConfig(directory?: string | null): Promise<Config> {
    const effectiveDirectory = this.normalizeCandidatePath(directory) ?? directory ?? this.currentDirectory ?? undefined;
    const key = effectiveDirectory ?? '';
    const cached = this.configCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      markStartupTrace('opencodeClient.getConfig:cacheHit', { directory: effectiveDirectory ?? null });
      return cached.config;
    }

    const existing = this.configInFlight.get(key);
    if (existing) {
      markStartupTrace('opencodeClient.getConfig:deduped', { directory: effectiveDirectory ?? null });
      return existing;
    }

    const generation = this.configCacheGeneration;
    const request = (async () => {
      markStartupTrace('opencodeClient.getConfig:start', { directory: effectiveDirectory ?? null });
      const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const scopedClient = effectiveDirectory ? this.getScopedApiClient(effectiveDirectory) : this.client;
      const response = await scopedClient.config.get();
      if (!response.data) throw new Error('Failed to get config');
      const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
      markStartupTrace('opencodeClient.getConfig:end', {
        directory: effectiveDirectory ?? null,
        durationMs: Math.round(ended - started),
      });
      if (generation === this.configCacheGeneration) {
        this.configCache.set(key, { config: response.data, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
      }
      return response.data;
    })();

    this.configInFlight.set(key, request);
    try {
      return await request;
    } finally {
      if (this.configInFlight.get(key) === request) {
        this.configInFlight.delete(key);
      }
    }
  }

  async updateConfig(config: Record<string, unknown>): Promise<Config> {
    // IMPORTANT: Do NOT pass directory parameter for config updates
    // The config should be global, not directory-specific
    const response = await this.client.config.update({ config: config as Config });
    const data = unwrapSdkData(response, 'global.config.update');
    this.clearConfigCache();
    return data;
  }

  /**
   * Update config with a partial modification function.
   * This handles the GET-modify-PATCH pattern required by the upstream API.
   *
   * NOTE: This method is deprecated for agent configuration.
   * Use backend endpoints at /api/config/agents/* instead, which write directly to files.
   *
   * @param modifier Function that receives current config and returns modified config
   * @returns Updated config from server
   */
  async updateConfigPartial(modifier: (config: Config) => Config): Promise<Config> {
    const currentConfig = await this.getConfig();
    const updatedConfig = modifier(currentConfig);
    const result = await this.updateConfig(updatedConfig);
    return result;
  }

  async getProviders(): Promise<{
    providers: Provider[];
    default: { [key: string]: string };
  }> {
    return this.getProvidersForConfig(this.currentDirectory);
  }

  async getProvidersForConfig(directory?: string | null): Promise<{
    providers: Provider[];
    default: { [key: string]: string };
  }> {
    const effectiveDirectory = this.normalizeCandidatePath(directory) ?? directory ?? this.currentDirectory ?? undefined;
    const key = effectiveDirectory ?? '';

    const existing = this.configProvidersInFlight.get(key);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      const response = await this.client.config.providers(
        effectiveDirectory ? { directory: effectiveDirectory } : undefined,
      );
      return unwrapSdkData(response, 'config.providers');
    })();

    this.configProvidersInFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.configProvidersInFlight.delete(key);
    }
  }

  // App Management - using config endpoint since /app doesn't exist in this version
  async getApp(): Promise<App> {
    // Return basic app info from config
    const config = await this.getConfig();
    return {
      version: "0.0.3", // from the OpenAPI spec
      config
    };
  }

  async initApp(): Promise<boolean> {
    try {
      // Just check if we can connect since there's no init endpoint
      return await this.checkHealth();
    } catch {
      return false;
    }
  }

  // Agent Management
  /**
   * Throws on fetch/SDK failure so caller-side retry loops (see
   * useAgentsStore) can observe failure and retry; silently returning an
   * empty list would defeat retries and clear the cached agent list.
   */
  async listAgents(directory?: string | null): Promise<Agent[]> {
    // Pass the directory explicitly so we don't depend on (and serialize behind)
    // withDirectory's shared context queue. Concurrent callers for the same
    // directory (e.g. config store + agents store at startup) share one request.
    const effectiveDirectory = this.normalizeCandidatePath(directory) ?? directory ?? this.currentDirectory ?? undefined;
    const key = effectiveDirectory ?? '';

    const existing = this.listAgentsInFlight.get(key);
    if (existing) {
      return existing;
    }

    const request = (async () => {
      const params = effectiveDirectory ? { directory: effectiveDirectory } : undefined;
      const response = await this.client.app.agents(params);
      if (!response.error && Array.isArray(response.data) && response.data.length > 0) {
        return response.data;
      }

      // SDK gap / endpoint drift: current OpenCode exposes the authoritative
      // agent list at /agent, while app.agents can be empty on some runtimes.
      const fallbackResponse = await runtimeFetch('/api/agent', {
        ...(effectiveDirectory ? { query: { directory: effectiveDirectory } } : {}),
      });
      if (!fallbackResponse.ok) {
        if (response.error) {
          throw new Error(`app.agents failed${response.response?.status ? ` (${response.response.status})` : ''}: ${formatSdkError(response.error)}`);
        }
        throw new Error(`agent.list failed (${fallbackResponse.status})`);
      }

      const fallbackData = await fallbackResponse.json().catch(() => null) as unknown;
      if (!Array.isArray(fallbackData)) {
        throw new Error('agent.list failed: invalid response');
      }
      return fallbackData as Agent[];
    })();

    this.listAgentsInFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.listAgentsInFlight.delete(key);
    }
  }

  // SSE infrastructure removed — EventPipeline in sync/event-pipeline.ts handles
  // all SSE event ingestion via the SDK's global.event() async iterator.

  // File Operations
  async readFile(path: string): Promise<string> {
    try {
      const response = await this.client.file.read({
        path,
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      });
      return String(unwrapSdkData(response, 'file.read'));
    } catch {
      // Return placeholder for development
      return `// Content of ${path}\n// This would be loaded from the server`;
    }
  }

  async listFiles(directory?: string): Promise<Record<string, unknown>[]> {
    try {
      const targetDir = directory || this.currentDirectory || '/';
      const response = await this.client.file.list({
        path: targetDir,
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      });
      const data = unwrapSdkData(response, 'file.list');
      return Array.isArray(data) ? data as Record<string, unknown>[] : [];
    } catch {
      // Return mock data for development
      return [];
    }
  }

  // Command Management
  async listCommands(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string; source?: string }>> {
    const response = await this.client.command.list(
      this.currentDirectory ? { directory: this.currentDirectory } : undefined
    );
    const commands = unwrapSdkData(response, 'command.list');
    // Return only lightweight info for autocomplete
    return (commands || []).map((cmd: Record<string, unknown>) => ({
      name: cmd.name as string,
      description: cmd.description as string | undefined,
      agent: cmd.agent as string | undefined,
      model: cmd.model as string | undefined,
      source: cmd.source as string | undefined,
      // Intentionally excluding template to keep memory usage low
    }));
  }

  async listCommandsWithDetails(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string; source?: string; template?: string }>> {
    const response = await this.client.command.list(
      this.currentDirectory ? { directory: this.currentDirectory } : undefined
    );
    const commands = unwrapSdkData(response, 'command.list');
    // Return full command details including template
    return (commands || []).map((cmd: Record<string, unknown>) => ({
      name: cmd.name as string,
      description: cmd.description as string | undefined,
      agent: cmd.agent as string | undefined,
      model: cmd.model as string | undefined,
      source: cmd.source as string | undefined,
      template: cmd.template as string | undefined,
    }));
  }

  async listSkillsWithDetails(): Promise<Array<{ name: string; description?: string; location: string; content?: string }>> {
    try {
      const response = await this.client.app.skills(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined,
      );
      const data = response.data;
      if (!Array.isArray(data)) {
        return [];
      }

      const skills: Array<{ name: string; description?: string; location: string; content?: string }> = [];
      for (const item of data as Array<Record<string, unknown>>) {
          const name = typeof item.name === 'string' ? item.name.trim() : '';
          const location = typeof item.location === 'string' ? item.location : '';
          if (!name || !location) {
            continue;
          }
          const skill: { name: string; description?: string; location: string; content?: string } = { name, location };
          if (typeof item.description === 'string') skill.description = item.description;
          if (typeof item.content === 'string') skill.content = item.content;
          skills.push(skill);
      }
      return skills;
    } catch {
      return [];
    }
  }

  async getCommandDetails(name: string): Promise<{ name: string; template: string; description?: string; agent?: string; model?: string } | null> {
    try {
      const response = await this.client.command.list(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );

      if (response.data) {
        const command = response.data.find((cmd: Record<string, unknown>) => cmd.name === name);
        if (command) {
          return {
            name: command.name as string,
            template: command.template as string,
            description: command.description as string | undefined,
            agent: command.agent as string | undefined,
            model: command.model as string | undefined
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Lightweight readiness check. Full diagnostics still live at /health.
  async checkHealth(): Promise<boolean> {
    try {
      const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.replace(/\/+$/, '') : this.baseUrl;
      const healthUrl = normalizedBase === '/api' || normalizedBase.endsWith('/api')
        ? '/api/opencode/health'
        : `${normalizedBase}/opencode/health`;
      markStartupTrace('opencodeClient.checkHealth:url', { baseUrl: this.baseUrl, healthUrl });
      const response = await runtimeFetch(healthUrl);
      markStartupTrace('opencodeClient.checkHealth:response', { status: response.status });
      if (!response.ok) {
        return false;
      }

      const healthData = await response.json();
      markStartupTrace('opencodeClient.checkHealth:result', { healthy: healthData?.healthy });

      return healthData?.healthy === true;
    } catch {
      return false;
    }
  }

  // File System Operations
  async createDirectory(
    dirPath: string,
    options?: { allowOutsideWorkspace?: boolean }
  ): Promise<{ success: boolean; path: string }> {
    const desktopFiles = getDesktopFilesApi();
    if (desktopFiles?.createDirectory) {
      try {
        return await desktopFiles.createDirectory(dirPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message || 'Failed to create directory');
      }
    }

    const payload = {
      path: dirPath,
      ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: true } : {}),
    };

    const response = await runtimeFetch(`${this.baseUrl}/fs/mkdir`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to create directory' }));
      throw new Error(error.error || 'Failed to create directory');
    }

    const result = await response.json();
    return result;
  }

  async cloneRepository(input: { remoteUrl: string; destinationPath: string; gitIdentityId?: string | null }): Promise<{ success: boolean; path: string; output?: string }> {
    const response = await runtimeFetch(`${this.baseUrl}/fs/clone`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to clone repository' }));
      throw new Error(error.error || 'Failed to clone repository');
    }

    return await response.json();
  }

  async listLocalDirectory(directoryPath: string | null | undefined, options?: { respectGitignore?: boolean }): Promise<FilesystemEntry[]> {
    const normalizedDirectoryPath = typeof directoryPath === 'string' ? normalizeFsPath(directoryPath.trim()) : '';
    const cacheKey = `${normalizedDirectoryPath}|${options?.respectGitignore ? '1' : '0'}`;
    const now = Date.now();
    const cached = this.listDirectoryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.entries;
    }

    const inFlight = this.listDirectoryInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const task = (async () => {
    const desktopFiles = getDesktopFilesApi();
    if (desktopFiles) {
      try {
        const result = await desktopFiles.listDirectory(directoryPath || '', options);
        if (!result || !Array.isArray(result.entries)) {
          return [];
        }
        const entries = result.entries.map<FilesystemEntry>((entry) => ({
          name: entry.name,
          path: normalizeFsPath(entry.path),
          isDirectory: !!entry.isDirectory,
          isFile: !entry.isDirectory,
          isSymbolicLink: false,
        }));
        this.listDirectoryCache.set(cacheKey, {
          entries,
          expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
        });
        return entries;
      } catch (error) {
        console.error('Failed to list directory contents:', error);
        throw error;
      }
    }

    try {
      const params = new URLSearchParams();
      if (directoryPath && directoryPath.trim().length > 0) {
        params.set('path', directoryPath);
      }
      if (options?.respectGitignore) {
        params.set('respectGitignore', 'true');
      }
      const query = params.toString();
      const response = await runtimeFetch(`${this.baseUrl}/fs/list${query ? `?${query}` : ''}`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message = typeof error.error === 'string' ? error.error : 'Failed to list directory';
        throw new Error(message);
      }

      const result = await response.json();
      if (!result || !Array.isArray(result.entries)) {
        return [];
      }

      const entries = result.entries as FilesystemEntry[];
      this.listDirectoryCache.set(cacheKey, {
        entries,
        expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS,
      });
      return entries;
    } catch (error) {
      console.error('Failed to list directory contents:', error);
      throw error;
    }
    })();

    const trackedTask = task.finally(() => {
      if (this.listDirectoryInFlight.get(cacheKey) === trackedTask) {
        this.listDirectoryInFlight.delete(cacheKey);
      }
    });
    this.listDirectoryInFlight.set(cacheKey, trackedTask);
    return trackedTask;
  }

  async searchFiles(
    query: string,
    options?: {
      directory?: string | null;
      limit?: number;
      includeHidden?: boolean;
      respectGitignore?: boolean;
      dirs?: boolean;
      type?: 'file' | 'directory';
    }
  ): Promise<ProjectFileSearchHit[]> {
    const directory = typeof options?.directory === 'string' && options.directory.trim().length > 0
      ? options.directory.trim()
      : this.currentDirectory;
    const normalizedDirectory = directory ? normalizeFsPath(directory) : null;
    const scopedClient = directory ? this.getScopedApiClient(directory) : this.client;

    try {
      const response = await scopedClient.find.files({
        query,
        limit: typeof options?.limit === 'number' && Number.isFinite(options.limit) ? options.limit : undefined,
        dirs: options?.dirs === false || options?.type === 'file' ? 'false' : 'true',
        type: options?.type,
      });

      const items = Array.isArray(response?.data) ? response.data : [];
      return items.map<ProjectFileSearchHit>((item) => {
        const normalizedRelativePath = normalizeFsPath(item);
        const name = normalizedRelativePath.split('/').filter(Boolean).pop() || normalizedRelativePath;
        const normalizedPath = normalizedDirectory
          ? normalizeFsPath(`${normalizedDirectory}/${normalizedRelativePath}`)
          : normalizeFsPath(normalizedRelativePath);

        return {
          name,
          path: normalizedPath,
          relativePath: normalizedRelativePath,
          extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
        };
      });
    } catch (error) {
      console.error('Failed to search files:', error);
      throw error;
    }
  }

  async getFilesystemHome(): Promise<string | null> {
    // The injected desktop home describes the LOCAL machine. It is only a
    // valid answer while the active runtime is the local one — after an
    // in-place switch to a remote host the home must come from that host's
    // /api/fs/home, not from the local Electron global.
    const runtimeKey = getRuntimeKey();
    if (!runtimeKey || runtimeKey === 'local') {
      const desktopHome = await getDesktopHomeDirectory();
      if (desktopHome) {
        return desktopHome;
      }
    }

    try {
      const response = await runtimeFetch(`${this.baseUrl}/fs/home`, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const message =
          typeof error.error === 'string' && error.error.length > 0
            ? error.error
            : 'Failed to resolve home directory';
        throw new Error(message);
      }

      const payload = await response.json();
      if (payload && typeof payload.home === 'string' && payload.home.length > 0) {
        return payload.home;
      }
      return null;
    } catch (error) {
      console.warn('Failed to resolve filesystem home directory:', error);
      return null;
    }
  }

  async setOpenCodeWorkingDirectory(directoryPath: string | null | undefined): Promise<DirectorySwitchResult | null> {
    if (!directoryPath || typeof directoryPath !== 'string' || !directoryPath.trim()) {
      console.warn('[OpencodeClient] setOpenCodeWorkingDirectory: invalid path', directoryPath);
      return null;
    }

    const url = `${this.baseUrl}/opencode/directory`;
    console.log('[OpencodeClient] POST', url, 'with path:', directoryPath);

    try {
      const response = await runtimeFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: directoryPath })
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        const error = payload ?? {};
        const message =
          typeof error.error === 'string' && error.error.length > 0
            ? error.error
            : 'Failed to update OpenCode working directory';
        throw new Error(message);
      }

      if (payload && typeof payload === 'object') {
        return payload as DirectorySwitchResult;
      }

      return {
        success: true,
        restarted: false,
        path: directoryPath
      };
    } catch (error) {
      console.warn('Failed to update OpenCode working directory:', error);
      throw error;
    }
  }
}

// Exported singleton instance
export const opencodeClient = new OpencodeService();

// Exported types
