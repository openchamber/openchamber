import { createOpencodeClient, OpencodeClient } from "@opencode-ai/sdk/v2";
import type { BackendControlSurface, BackendDescriptor, FilesAPI, RuntimeAPIs } from "../api/types";
import { getDesktopHomeDirectory } from "../desktop";
import type {
  Session,
  Message,
  Part,
  Provider,
  Config,
  Model,
  Agent,
  TextPartInput,
  FilePartInput,
} from "@opencode-ai/sdk/v2";
import type { PermissionRequest } from "@/types/permission";
import type { QuestionRequest } from "@/types/question";
import { waitForWorktreeBootstrap } from "@/lib/worktrees/worktreeBootstrap";

// Use relative path by default (works with both dev and nginx proxy server)
// Can be overridden with VITE_OPENCODE_URL for absolute URLs in special deployments
const DEFAULT_BASE_URL = import.meta.env.VITE_OPENCODE_URL || "/api";
const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;

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

const resolveDesktopBaseUrl = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }
  const desktopServer = (window as typeof window & {
    __OPENCHAMBER_DESKTOP_SERVER__?: { origin: string; apiPrefix?: string };
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }).__OPENCHAMBER_DESKTOP_SERVER__;

  const isDesktop = Boolean(
    (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__?.runtime?.isDesktop
  );

  if (!desktopServer || !isDesktop) {
    return null;
  }

  const origin = typeof desktopServer.origin === "string" && desktopServer.origin.length > 0 ? desktopServer.origin : null;
  if (!origin) {
    return null;
  }

  return `${origin}/api`;
};

interface App {
  version?: string;
  [key: string]: unknown;
}

export type FilesystemEntry = {
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

export type DirectorySwitchResult = {
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
  if (typeof window === "undefined") {
    return null;
  }
  const apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__;
  if (apis && apis.runtime?.isDesktop && apis.files) {
    return apis.files;
  }
  return null;
};

const isDirectoryNotFoundError = (error: unknown): boolean => {
  return error instanceof Error && /directory not found/i.test(error.message);
};

class OpencodeService {
  private client: OpencodeClient;
  private baseUrl: string;
  private scopedClients: Map<string, OpencodeClient> = new Map();
  private currentDirectory: string | undefined = undefined;
  private directoryContextQueue: Promise<void> = Promise.resolve();
  private listDirectoryInFlight: Map<string, Promise<FilesystemEntry[]>> = new Map();
  private listDirectoryCache: Map<string, { entries: FilesystemEntry[]; expiresAt: number }> = new Map();

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    const desktopBase = resolveDesktopBaseUrl();
    const requestedBaseUrl = desktopBase || baseUrl;
    this.baseUrl = ensureAbsoluteBaseUrl(requestedBaseUrl);
    this.client = createOpencodeClient({ baseUrl: this.baseUrl });
  }

  getBaseUrl(): string {
    return this.baseUrl;
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
    const scoped = createOpencodeClient({ baseUrl: this.baseUrl, directory: normalized });
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
    this.currentDirectory = this.normalizeCandidatePath(directory) ?? directory;
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
      this.currentDirectory = this.normalizeCandidatePath(directory) ?? directory;
      try {
        return await fn();
      } finally {
        this.currentDirectory = previousDirectory;
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

  async createSession(params?: { parentID?: string; title?: string; backendId?: string }): Promise<Session> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/openchamber/harness/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
        ...(params?.parentID ? { parentID: params.parentID } : {}),
        ...(params?.title ? { title: params.title } : {}),
        ...(params?.backendId ? { backendId: params.backendId } : {}),
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = typeof payload?.error === 'string' ? payload.error : `Failed to create session (status ${response.status})`;
      throw new Error(message);
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') {
      throw new Error('Failed to create session');
    }
    return payload as Session;
  }

  async getSession(id: string): Promise<Session> {
    const response = await this.client.session.get({
      sessionID: id,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
    });
    if (!response.data) throw new Error('Session not found');
    return response.data;
  }

  async deleteSession(id: string): Promise<boolean> {
    const response = await this.client.session.delete({
      sessionID: id,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
    });
    return response.data || false;
  }

  async updateSession(id: string, title?: string): Promise<Session> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/openchamber/harness/session/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
        ...(typeof title === 'string' ? { title } : {}),
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = typeof payload?.error === 'string' ? payload.error : `Failed to update session (${response.status})`;
      throw new Error(message);
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') throw new Error('Failed to update session');
    return payload as Session;
  }

  async archiveSession(id: string, archivedAt: number): Promise<Session> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/openchamber/harness/session/${encodeURIComponent(id)}/update`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
        time: { archived: archivedAt },
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = typeof payload?.error === 'string' ? payload.error : `Failed to archive session (${response.status})`;
      throw new Error(message);
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') throw new Error('Failed to archive session');
    return payload as Session;
  }

  async getSessionMessages(id: string, limit?: number): Promise<{ info: Message; parts: Part[] }[]> {
    const response = await this.client.session.messages({
      sessionID: id,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
    return response.data || [];
  }

  async getSessionTodos(sessionId: string): Promise<Array<{ id: string; content: string; status: string; priority: string }>> {
    try {
      const base = this.baseUrl.replace(/\/$/, "");
      const url = new URL(`${base}/session/${encodeURIComponent(sessionId)}/todo`);

      if (this.currentDirectory && this.currentDirectory.length > 0) {
        url.searchParams.set("directory", this.currentDirectory);
      }

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json().catch(() => null);
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
    format?: {
      type: 'json_schema';
      schema: Record<string, unknown>;
      retryCount?: number;
    };
    sandboxOverride?: string;
  }): Promise<string> {
    // Generate a temporary client-side ID for optimistic UI
    // This ID won't be sent to the server - server will generate its own
    const baseTimestamp = Date.now();
    const tempMessageId = params.messageId ?? `temp_${baseTimestamp}_${Math.random().toString(36).substring(2, 9)}`;

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

    if (this.currentDirectory) {
      await waitForWorktreeBootstrap(this.currentDirectory);
    }

    if (params.format) {
      console.info('[git-generation][browser] send structured message', {
        sessionId: params.id,
        providerID: params.providerID,
        modelID: params.modelID,
        agent: params.agent,
        variant: params.variant,
        directory: this.currentDirectory,
        baseUrl: this.baseUrl,
        formatType: params.format.type,
      });
    }

    try {
      const base = this.baseUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}/openchamber/harness/session/${encodeURIComponent(params.id)}/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
          model: {
            providerID: params.providerID,
            modelID: params.modelID,
          },
          ...(params.agent ? { agent: params.agent } : {}),
          ...(params.variant ? { variant: params.variant } : {}),
          ...(params.messageId ? { messageID: params.messageId } : {}),
          ...(params.format ? { format: params.format } : {}),
          ...(params.sandboxOverride ? { sandboxOverride: params.sandboxOverride } : {}),
          parts,
        }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        const message = typeof payload?.error === 'string' ? payload.error : `Failed to send message (${response.status})`;
        throw new Error(message);
      }
    } catch (error) {
      const detail = (() => {
        if (error && typeof error === 'object') {
          const data = 'data' in error ? error.data : undefined;
          if (typeof data === 'string' && data.trim()) {
            return data.trim();
          }
          if (Array.isArray((error as { error?: unknown }).error)) {
            return JSON.stringify((error as { error?: unknown }).error);
          }
        }
        return error instanceof Error ? error.message : String(error);
      })();
      throw new Error(`Failed to send message: ${detail}`);
    }

    // Return temporary ID for optimistic UI
    // Real messageID will come from server via SSE events
    return tempMessageId;
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
  }): Promise<string> {
    const baseTimestamp = Date.now();
    const tempMessageId = params.messageId ?? `temp_${baseTimestamp}_${Math.random().toString(36).substring(2, 9)}`;

    const parts: FilePartInput[] = [];
    if (params.files && params.files.length > 0) {
      for (const file of params.files) {
        parts.push(await this.toNormalizedFilePartInput(file));
      }
    }

    const payload: Record<string, unknown> = {
      command: params.command,
      arguments: params.arguments ?? '',
      model: `${params.providerID}/${params.modelID}`,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      ...(params.agent ? { agent: params.agent } : {}),
      ...(params.variant ? { variant: params.variant } : {}),
      ...(parts.length > 0 ? { parts } : {}),
      ...(params.messageId ? { messageID: params.messageId } : {}),
    };

    const base = this.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/openchamber/harness/session/${encodeURIComponent(params.id)}/command`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        // ignore
      }
      const suffix = detail && detail.trim().length > 0 ? `: ${detail.trim()}` : '';
      throw new Error(`Failed to run command (${response.status})${suffix}`);
    }

    return tempMessageId;
  }

  async abortSession(id: string): Promise<boolean> {
    const base = this.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${base}/openchamber/harness/session/${encodeURIComponent(id)}/abort`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const message = typeof payload?.error === 'string' ? payload.error : `Failed to abort session (${response.status})`;
      throw new Error(message);
    }
    const payload = await response.json().catch(() => null) as { ok?: unknown } | null;
    return Boolean(payload?.ok);
  }

  async revertSession(sessionId: string, messageId: string, partId?: string): Promise<Session> {
    const response = await this.client.session.revert({
      sessionID: sessionId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      messageID: messageId,
      partID: partId
    });
    if (!response.data) throw new Error('Failed to revert session');
    return response.data;
  }

  async unrevertSession(sessionId: string): Promise<Session> {
    const response = await this.client.session.unrevert({
      sessionID: sessionId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {})
    });
    if (!response.data) throw new Error('Failed to unrevert session');
    return response.data;
  }

  async forkSession(sessionId: string, messageId?: string): Promise<Session> {
    const base = this.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/openchamber/harness/session/${encodeURIComponent(sessionId)}/fork`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
        ...(messageId ? { messageID: messageId } : {}),
      }),
    });
    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch (error) {
        console.warn('[opencodeClient] Failed to read fork session error body:', error);
      }
      throw new Error(bodyText || `Failed to fork session (status ${response.status})`);
    }

    const payload = await response.json().catch(() => null) as Session | { error?: string } | null;

    if (!payload || ('error' in payload && typeof payload.error === 'string')) {
      throw new Error('Failed to fork session');
    }

    return payload as Session;
  }

  async getSessionStatus(): Promise<
    Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>
  > {
    return this.getSessionStatusForDirectory(this.currentDirectory ?? null);
  }

  async getSessionStatusForDirectory(
    directory: string | null | undefined
  ): Promise<Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>> {
    try {
      const base = this.baseUrl.replace(/\/$/, "");
      const url = new URL(`${base}/session/status`);

      const trimmedDirectory = typeof directory === "string" ? directory.trim() : "";
      if (trimmedDirectory.length > 0) {
        url.searchParams.set("directory", trimmedDirectory);
      }

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        return {};
      }

      const data = await response.json().catch(() => null);
      if (!data || typeof data !== "object") {
        return {};
      }

      return data as Record<
        string,
        { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }
      >;
    } catch {
      return {};
    }
  }

  async getGlobalSessionStatus(): Promise<
    Record<string, { type: "idle" | "busy" | "retry"; attempt?: number; message?: string; next?: number }>
  > {
    return this.getSessionStatusForDirectory(null);
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
      // Web server endpoint - use relative path that works with both dev and prod
      const response = await fetch('/api/session-activity', {
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
    options?: { message?: string }
  ): Promise<boolean> {
    const result = await this.client.permission.reply({
      requestID: requestId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      reply,
      ...(options?.message ? { message: options.message } : {}),
    });
    return result.data || false;
  }

  async listPendingPermissions(options?: { directories?: Array<string | null | undefined> }): Promise<PermissionRequest[]> {
    const fetches: Array<Promise<PermissionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<PermissionRequest[]> => {
      try {
        const trimmed = typeof directory === 'string' ? directory.trim() : '';
        const result = await this.client.permission.list(trimmed ? { directory: trimmed } : undefined);
        return (result.data || []) as unknown as PermissionRequest[];
      } catch {
        return [];
      }
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
  async replyToQuestion(requestId: string, answers: string[] | string[][]): Promise<boolean> {
    const normalizedAnswers: string[][] = (() => {
      if (!Array.isArray(answers) || answers.length === 0) {
        return [];
      }
      if (Array.isArray(answers[0])) {
        return answers as string[][];
      }
      return [answers as string[]];
    })();

    const result = await this.client.question.reply({
      requestID: requestId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
      answers: normalizedAnswers,
    });
    return result.data || false;
  }

  async rejectQuestion(requestId: string): Promise<boolean> {
    const result = await this.client.question.reject({
      requestID: requestId,
      ...(this.currentDirectory ? { directory: this.currentDirectory } : {}),
    });
    return result.data || false;
  }

  async listPendingQuestions(options?: { directories?: Array<string | null | undefined> }): Promise<QuestionRequest[]> {
    const fetches: Array<Promise<QuestionRequest[]>> = [];

    const fetchForDirectory = async (directory?: string | null): Promise<QuestionRequest[]> => {
      try {
        const trimmed = typeof directory === 'string' ? directory.trim() : '';
        const result = await this.client.question.list(trimmed ? { directory: trimmed } : undefined);
        return (result.data || []) as unknown as QuestionRequest[];
      } catch {
        return [];
      }
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
  async getConfig(): Promise<Config> {
    const response = await this.client.config.get();
    if (!response.data) throw new Error('Failed to get config');
    return response.data;
  }

  async updateConfig(config: Record<string, unknown>): Promise<Config> {
    // IMPORTANT: Do NOT pass directory parameter for config updates
    // The config should be global, not directory-specific
    const url = `${this.baseUrl}/config`;

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[OpencodeClient] Failed to update config:', response.status, errorText);
      throw new Error(`Failed to update config: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
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
    const response = await this.client.config.providers(
      this.currentDirectory ? { directory: this.currentDirectory } : undefined
    );
    if (!response.data) throw new Error('Failed to get providers');
    return response.data;
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

  async getHarnessBackends(): Promise<{ defaultBackend: string; backends: BackendDescriptor[] }> {
    const response = await fetch('/api/openchamber/backends', {
      headers: {
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to load harness backends (status ${response.status})`);
    }
    const payload = await response.json().catch(() => null) as { defaultBackend?: unknown; backends?: unknown } | null;
    return {
      defaultBackend: typeof payload?.defaultBackend === 'string' ? payload.defaultBackend : 'opencode',
      backends: Array.isArray(payload?.backends) ? payload.backends as BackendDescriptor[] : [],
    };
  }

  async getHarnessControlSurface(params?: {
    backendId?: string;
    sessionId?: string;
    providerId?: string;
    modelId?: string;
  }): Promise<BackendControlSurface> {
    const searchParams = new URLSearchParams();
    if (this.currentDirectory) {
      searchParams.set('directory', this.currentDirectory);
    }
    if (params?.backendId) {
      searchParams.set('backendId', params.backendId);
    }
    if (params?.sessionId) {
      searchParams.set('sessionId', params.sessionId);
    }
    if (params?.providerId) {
      searchParams.set('providerId', params.providerId);
    }
    if (params?.modelId) {
      searchParams.set('modelId', params.modelId);
    }

    const query = searchParams.toString();
    const response = await fetch(`/api/openchamber/harness/control-surface${query ? `?${query}` : ''}`, {
      headers: {
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to load harness control surface (status ${response.status})`);
    }
    const payload = await response.json().catch(() => null);
    if (!payload || typeof payload !== 'object') {
      throw new Error('Failed to load harness control surface');
    }
    return payload as BackendControlSurface;
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
  async listAgents(): Promise<Agent[]> {
    try {
      const response = await this.client.app.agents(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      return response.data || [];
    } catch {
      return [];
    }
  }

  // SSE infrastructure removed — EventPipeline in sync/event-pipeline.ts handles
  // all SSE event ingestion via the SDK's global.event() async iterator.

  // File Operations
  async readFile(path: string): Promise<string> {
    try {
      // For now, we'll use a placeholder implementation
      // In a real implementation, this would call an API endpoint to read the file
      const response = await fetch(`${this.baseUrl}/files/read`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path,
          directory: this.currentDirectory
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to read file: ${response.statusText}`);
      }

      const data = await response.text();
      return data;
    } catch {
      // Return placeholder for development
      return `// Content of ${path}\n// This would be loaded from the server`;
    }
  }

  async listFiles(directory?: string): Promise<Record<string, unknown>[]> {
    try {
      const targetDir = directory || this.currentDirectory || '/';
      const response = await fetch(`${this.baseUrl}/files/list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ directory: targetDir })
      });

      if (!response.ok) {
        throw new Error(`Failed to list files: ${response.statusText}`);
      }

      const data = await response.json();
      return data;
    } catch {
      // Return mock data for development
      return [];
    }
  }

  // Command Management
  async listCommands(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string }>> {
    try {
      const response = await this.client.command.list(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      // Return only lightweight info for autocomplete
      return (response.data || []).map((cmd: Record<string, unknown>) => ({
        name: cmd.name as string,
        description: cmd.description as string | undefined,
        agent: cmd.agent as string | undefined,
        model: cmd.model as string | undefined
        // Intentionally excluding template to keep memory usage low
      }));
    } catch {
      return [];
    }
  }

  async listCommandsWithDetails(): Promise<Array<{ name: string; description?: string; agent?: string; model?: string; template?: string }>> {
    try {
      const response = await this.client.command.list(
        this.currentDirectory ? { directory: this.currentDirectory } : undefined
      );
      // Return full command details including template
      return (response.data || []).map((cmd: Record<string, unknown>) => ({
        name: cmd.name as string,
        description: cmd.description as string | undefined,
        agent: cmd.agent as string | undefined,
        model: cmd.model as string | undefined,
        template: cmd.template as string | undefined,
      }));
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

  // Health Check - using /health endpoint for detailed status
  async checkHealth(): Promise<boolean> {
    try {
      // Health endpoint is at root, not under /api
      let healthUrl: string;
      const normalizedBase = this.baseUrl.endsWith('/') ? this.baseUrl.replace(/\/+$/, '') : this.baseUrl;
      if (normalizedBase === '/api') {
        healthUrl = '/health';
      } else if (normalizedBase.endsWith('/api')) {
        // Desktop: http://127.0.0.1:PORT/api -> http://127.0.0.1:PORT/health
        healthUrl = `${normalizedBase.slice(0, -4)}/health`;
      } else {
        healthUrl = `${normalizedBase}/health`;
      }
      const response = await fetch(healthUrl);
      if (!response.ok) {
        return false;
      }

      const healthData = await response.json();

      // Check if the upstream API is ready (not just OpenChamber server)
      if (healthData.isOpenCodeReady === false) {
        return false;
      }

      return true;
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

    const response = await fetch(`${this.baseUrl}/fs/mkdir`, {
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
        if (!isDirectoryNotFoundError(error)) {
          console.error('Failed to list directory contents:', error);
        }
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
      const response = await fetch(`${this.baseUrl}/fs/list${query ? `?${query}` : ''}`);
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
      if (!isDirectoryNotFoundError(error)) {
        console.error('Failed to list directory contents:', error);
      }
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
    // Optimization: Check for desktop runtime first to avoid unnecessary network calls
    // and fix the "SyntaxError" warning when the endpoint is missing
    const desktopHome = await getDesktopHomeDirectory();
    if (desktopHome) {
      return desktopHome;
    }

    try {
      const response = await fetch(`${this.baseUrl}/fs/home`, {
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
      const response = await fetch(url, {
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
export type { Session, Message, Part, Provider, Config, Model };
export type { App };
