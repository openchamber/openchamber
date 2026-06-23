import type { Snippet } from "../../types/snippet";
import { runtimeFetch } from "../runtime-fetch";

export type ConfigSetting = {
	key: string;
	value: unknown;
	defaultValue?: unknown;
	type?: string;
	label?: string;
	description?: string;
};

export type ConfigCategory = {
	id: string;
	label: string;
	settings: ConfigSetting[];
};

const parseErrorMessage = async (response: Response, fallback: string) => {
	try {
		const parsed = await response.json();
		if (
			parsed &&
			typeof parsed.error === "string" &&
			parsed.error.trim().length > 0
		) {
			return parsed.error;
		}
	} catch {
		return fallback;
	}
	return fallback;
};

export const fetchSettings = async (): Promise<ConfigCategory[]> => {
	const response = await runtimeFetch("/api/config/settings");
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to load settings"),
		);
	}
	const parsed = await response.json().catch(() => null);
	if (!parsed || !Array.isArray(parsed.categories)) {
		return [];
	}
	return parsed.categories as ConfigCategory[];
};

export const updateSetting = async (
	key: string,
	value: unknown,
): Promise<void> => {
	const safeKey = typeof key === "string" ? key.trim() : "";
	if (!safeKey) {
		throw new Error("key is required");
	}
	const response = await runtimeFetch("/api/config/settings", {
		method: "PUT",
		headers: {
			"content-type": "application/json",
			accept: "application/json",
		},
		body: JSON.stringify({ key: safeKey, value }),
	});
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to update setting"),
		);
	}
};

export const fetchCommands = async (): Promise<
	{ id: string; command: string; label?: string }[]
> => {
	const response = await runtimeFetch("/api/config/commands");
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to load commands"),
		);
	}
	const parsed = await response.json().catch(() => null);
	if (!parsed || !Array.isArray(parsed.commands)) {
		return [];
	}
	return parsed.commands as { id: string; command: string; label?: string }[];
};

// --- Command Config CRUD ---

export interface CommandConfigPayload {
	scope?: "user" | "project";
	sources?: {
		md?: { exists: boolean; scope?: "user" | "project" };
		json?: { exists: boolean; scope?: "user" | "project" };
	};
}

export interface CommandMutationResult {
	ok: boolean;
	error?: string;
	requiresReload?: boolean;
	message?: string;
	reloadDelayMs?: number;
}

// Unified mutation result used by agent, snippet, and MCP config endpoints
export interface ConfigMutationResult {
	ok: boolean;
	error?: string;
	requiresReload?: boolean;
	reloadFailed?: boolean;
	message?: string;
	warning?: string;
	reloadDelayMs?: number;
}

/** GET individual command config (used to detect scope for a specific command) */
export const fetchCommandConfig = async (
	name: string,
	directory?: string | null,
): Promise<{ ok: true; data: CommandConfigPayload } | { ok: false }> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	try {
		const response = await runtimeFetch(
			`/api/config/commands/${encodeURIComponent(name)}${queryParams}`,
			{
				headers: {
					"Cache-Control": "no-cache",
					...(directory ? { "x-opencode-directory": directory } : {}),
				},
			},
		);
		if (response.ok) {
			const data = await response.json().catch(() => null);
			return { ok: true, data: data ?? {} };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
};

/** POST create a new command config */
export const createCommandConfig = async (
	name: string,
	config: Record<string, unknown>,
	directory?: string | null,
): Promise<CommandMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/commands/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(config),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: payload?.error || "Failed to create command" };
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			message: payload?.message,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to create command",
		};
	}
};

/** PATCH update an existing command config */
export const updateCommandConfig = async (
	name: string,
	config: Record<string, unknown>,
	directory?: string | null,
): Promise<CommandMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/commands/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "PATCH",
				headers,
				body: JSON.stringify(config),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: payload?.error || "Failed to update command" };
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			message: payload?.message,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to update command",
		};
	}
};

/** DELETE a command config */
export const deleteCommandConfig = async (
	name: string,
	directory?: string | null,
): Promise<CommandMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers = directory ? { "x-opencode-directory": directory } : undefined;
	try {
		const response = await runtimeFetch(
			`/api/config/commands/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "DELETE",
				headers,
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: payload?.error || "Failed to delete command" };
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			message: payload?.message,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to delete command",
		};
	}
};

/** POST reload all server config */
export const reloadConfig = async (): Promise<CommandMutationResult> => {
	try {
		const response = await runtimeFetch("/api/config/reload", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to reload configuration",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload,
			message: payload?.message,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error ? err.message : "Failed to reload configuration",
		};
	}
};

// ============================================================
// Snippet Types
// ============================================================

export type SnippetScope = "global" | "project";

export interface SnippetCreatePayload {
	content: string;
	aliases?: string[];
	description?: string;
	scope?: SnippetScope;
}

export interface SnippetUpdatePayload {
	content?: string;
	aliases?: string[];
	description?: string;
}

export interface SnippetMutationResult {
	ok: boolean;
	error?: string;
	snippet?: Snippet;
}

/** GET /api/config/snippets - list all snippets */
export const fetchSnippets = async (
	directory?: string | null,
): Promise<Snippet[]> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	const response = await runtimeFetch(`/api/config/snippets${queryParams}`, {
		headers,
	});
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to load snippets"),
		);
	}
	try {
		const data: Snippet[] = await response.json();
		return data;
	} catch {
		return [];
	}
};

/** POST /api/config/snippets/:name - create a new snippet */
export const createSnippet = async (
	name: string,
	payload: SnippetCreatePayload,
	directory?: string | null,
): Promise<SnippetMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/snippets/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(payload),
			},
		);
		const data = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: data?.error || "Failed to create snippet" };
		}
		return { ok: true, snippet: data?.snippet };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to create snippet",
		};
	}
};

/** PATCH /api/config/snippets/:name - update an existing snippet */
export const updateSnippet = async (
	name: string,
	payload: SnippetUpdatePayload,
	directory?: string | null,
): Promise<SnippetMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/snippets/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "PATCH",
				headers,
				body: JSON.stringify(payload),
			},
		);
		const data = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: data?.error || "Failed to update snippet" };
		}
		return { ok: true, snippet: data?.snippet };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to update snippet",
		};
	}
};

/** DELETE /api/config/snippets/:name - delete a snippet */
export const deleteSnippet = async (
	name: string,
	directory?: string | null,
): Promise<SnippetMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	try {
		const response = await runtimeFetch(
			`/api/config/snippets/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "DELETE",
				headers: directory ? { "x-opencode-directory": directory } : undefined,
			},
		);
		const data = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: data?.error || "Failed to delete snippet" };
		}
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to delete snippet",
		};
	}
};

/** POST /api/config/snippets/expand - expand snippet references in text */
export const expandSnippets = async (
	text: string,
	directory?: string | null,
): Promise<string> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	const response = await runtimeFetch(
		`/api/config/snippets/expand${queryParams}`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({ text }),
		},
	);
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to expand snippets"),
		);
	}
	const data = await response.json().catch(() => null);
	return data?.text ?? text;
};

// ============== Agent Config CRUD ==============

export interface AgentConfigPayload {
	mode?: "primary" | "subagent" | "all";
	description?: string;
	model?: string | null;
	temperature?: number;
	top_p?: number;
	prompt?: string;
	permission?: Record<string, unknown> | null;
	disable?: boolean;
	scope?: "user" | "project";
}

export interface AgentConfigResponse extends AgentConfigPayload {
	sources?: {
		md?: { exists: boolean; scope?: "user" | "project"; path?: string };
		json?: { exists: boolean; scope?: "user" | "project" };
	};
}

/** GET individual agent config (scope, sources, and config fields) */
export const fetchAgentConfig = async (
	name: string,
	directory?: string | null,
): Promise<AgentConfigResponse | null> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	try {
		const response = await runtimeFetch(
			`/api/config/agents/${encodeURIComponent(name)}${queryParams}`,
			{
				headers: {
					"Cache-Control": "no-cache",
					...(directory ? { "x-opencode-directory": directory } : {}),
				},
			},
		);
		if (response.ok) {
			const data = await response.json().catch(() => null);
			return data as AgentConfigResponse | null;
		}
		return null;
	} catch {
		return null;
	}
};

/** POST create a new agent config */
export const createAgentConfig = async (
	name: string,
	config: Record<string, unknown>,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) headers["x-opencode-directory"] = directory;
	try {
		const response = await runtimeFetch(
			`/api/config/agents/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(config),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: payload?.error || "Failed to create agent" };
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to create agent",
		};
	}
};

/** PATCH update an existing agent config */
export const updateAgentConfig = async (
	name: string,
	config: Record<string, unknown>,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) headers["x-opencode-directory"] = directory;
	try {
		const response = await runtimeFetch(
			`/api/config/agents/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "PATCH",
				headers,
				body: JSON.stringify(config),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: payload?.error || "Failed to update agent" };
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to update agent",
		};
	}
};

/** DELETE an agent config */
export const deleteAgentConfig = async (
	name: string,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers = directory ? { "x-opencode-directory": directory } : undefined;
	try {
		const response = await runtimeFetch(
			`/api/config/agents/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "DELETE",
				headers,
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return { ok: false, error: payload?.error || "Failed to delete agent" };
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to delete agent",
		};
	}
};

// ============== MCP Config CRUD ==============

export interface McpLocalConfig {
	type: "local";
	command: string[];
	environment?: Record<string, string>;
	enabled: boolean;
}

export interface McpOAuthConfig {
	clientId?: string;
	clientSecret?: string;
	scope?: string;
	redirectUri?: string;
}

export interface McpRemoteConfig {
	type: "remote";
	url: string;
	environment?: Record<string, string>;
	headers?: Record<string, string>;
	oauth?: McpOAuthConfig | false;
	timeout?: number;
	enabled: boolean;
}

export type McpServerConfig = (McpLocalConfig | McpRemoteConfig) & {
	name: string;
};

export type McpServerWithScope = McpServerConfig & {
	scope?: "user" | "project" | null;
};

// ----- MCP Config CRUD -----

/** GET /api/config/mcp - list all MCP server configs */
export const fetchMcpConfigs = async (
	directory?: string | null,
): Promise<McpServerWithScope[]> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	const response = await runtimeFetch(`/api/config/mcp${queryParams}`, {
		headers,
	});
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to load MCP configs"),
		);
	}
	try {
		const data: McpServerWithScope[] = await response.json();
		return data;
	} catch {
		return [];
	}
};

/** GET /api/config/mcp/:name - get a specific MCP server config */
export const fetchMcpConfig = async (
	name: string,
	directory?: string | null,
): Promise<McpServerWithScope | null> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`,
			{ headers },
		);
		if (!response.ok) {
			if (response.status === 404) return null;
			throw new Error(
				await parseErrorMessage(response, "Failed to fetch MCP config"),
			);
		}
		return (await response.json()) as McpServerWithScope;
	} catch (err) {
		if (
			err instanceof Error &&
			!err.message.startsWith("Failed to fetch MCP config")
		) {
			return null;
		}
		throw err;
	}
};

/** POST /api/config/mcp/:name - create a new MCP server config */
export const createMcpConfig = async (
	name: string,
	config: Record<string, unknown>,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(config),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to create MCP server",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to create MCP server",
		};
	}
};

/** PATCH /api/config/mcp/:name - update an existing MCP server config */
export const updateMcpConfig = async (
	name: string,
	config: Record<string, unknown>,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "PATCH",
				headers,
				body: JSON.stringify(config),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to update MCP server",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to update MCP server",
		};
	}
};

/** DELETE /api/config/mcp/:name - delete an MCP server config */
export const deleteMcpConfig = async (
	name: string,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/mcp/${encodeURIComponent(name)}${queryParams}`,
			{
				method: "DELETE",
				headers: directory ? { "x-opencode-directory": directory } : undefined,
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to delete MCP server",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to delete MCP server",
		};
	}
};
// ============================================================
// Plugin Types
// ============================================================

export type PluginScope = "user" | "project";
export type PluginParsedKind = "npm" | "path";

export interface PluginEntry {
	id: string;
	spec: string;
	options?: Record<string, unknown>;
	scope: PluginScope;
	kind: "config";
	parsedKind: PluginParsedKind;
}

export interface PluginFile {
	id: string;
	fileName: string;
	scope: PluginScope;
	kind: "file";
}

export interface PluginFileContent {
	fileName: string;
	scope: PluginScope;
	content: string;
}

export type RegistryResult =
	| {
			kind: "npm-ok";
			spec: string;
			name: string;
			currentVersion: string | null;
			latestVersion: string | null;
			versions: string[];
			hasUpdate: boolean;
	  }
	| {
			kind: "npm-missing-version";
			spec: string;
			name: string;
			currentVersion: string;
			latestVersion: string | null;
			versions: string[];
	  }
	| { kind: "npm-missing-package"; spec: string; name: string; error: string }
	| { kind: "npm-malformed"; spec: string; error: string }
	| { kind: "npm-network"; spec: string; error: string }
	| { kind: "path-ok"; spec: string; absolutePath: string }
	| { kind: "path-missing"; spec: string; absolutePath: string }
	| { kind: "path-unreadable"; spec: string; absolutePath: string };

interface PluginListResponse {
	entries: PluginEntry[];
	files: PluginFile[];
}

interface PluginRegistryResponse {
	results: RegistryResult[];
}

// ----- Plugin CRUD -----

/** GET /api/config/plugins - list all plugin entries and files */
export const fetchPlugins = async (
	directory?: string | null,
): Promise<PluginListResponse> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	const response = await runtimeFetch(`/api/config/plugins${queryParams}`, {
		headers,
	});
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to load plugins"),
		);
	}
	try {
		return (await response.json()) as PluginListResponse;
	} catch {
		return { entries: [], files: [] };
	}
};

/** GET /api/config/plugins/registry - query plugin registry info */
export const fetchPluginRegistry = async (
	specs: string[],
	options?: { refresh?: boolean; directory?: string | null },
): Promise<RegistryResult[]> => {
	const params = new URLSearchParams();
	params.set("specs", specs.map((s) => encodeURIComponent(s)).join(","));
	if (options?.refresh) params.set("refresh", "true");
	if (options?.directory) params.set("directory", options.directory);

	const url = `/api/config/plugins/registry?${params.toString()}`;
	const headers: Record<string, string> = {};
	if (options?.directory) {
		headers["x-opencode-directory"] = options.directory;
	}

	const response = await runtimeFetch(url, { headers });
	if (!response.ok) {
		throw new Error(
			await parseErrorMessage(response, "Failed to query plugin registry"),
		);
	}
	const data: PluginRegistryResponse = await response
		.json()
		.catch(() => ({ results: [] }));
	return data.results ?? [];
};

/** POST /api/config/plugins/entry - create a new plugin entry */
export const createPluginEntry = async (
	body: {
		spec: string;
		options?: Record<string, unknown>;
		scope?: PluginScope;
	},
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/plugins/entry${queryParams}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to create plugin entry",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error ? err.message : "Failed to create plugin entry",
		};
	}
};

/** PATCH /api/config/plugins/entry/:id - update a plugin entry */
export const updatePluginEntry = async (
	id: string,
	body: { spec?: string; options?: Record<string, unknown> },
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/plugins/entry/${encodeURIComponent(id)}${queryParams}`,
			{
				method: "PATCH",
				headers,
				body: JSON.stringify(body),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to update plugin entry",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error ? err.message : "Failed to update plugin entry",
		};
	}
};

/** DELETE /api/config/plugins/entry/:id - delete a plugin entry */
export const deletePluginEntry = async (
	id: string,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	try {
		const response = await runtimeFetch(
			`/api/config/plugins/entry/${encodeURIComponent(id)}${queryParams}`,
			{
				method: "DELETE",
				headers: directory ? { "x-opencode-directory": directory } : undefined,
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to delete plugin entry",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error ? err.message : "Failed to delete plugin entry",
		};
	}
};

/** GET /api/config/plugins/file/:id - read a plugin file */
export const fetchPluginFile = async (
	id: string,
	directory?: string | null,
): Promise<PluginFileContent | null> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/plugins/file/${encodeURIComponent(id)}${queryParams}`,
			{ headers },
		);
		if (!response.ok) {
			if (response.status === 404) return null;
			throw new Error(
				await parseErrorMessage(response, "Failed to read plugin file"),
			);
		}
		return (await response.json()) as PluginFileContent;
	} catch (err) {
		if (
			err instanceof Error &&
			!err.message.startsWith("Failed to read plugin file")
		) {
			return null;
		}
		throw err;
	}
};

/** POST /api/config/plugins/file - create a new plugin file */
export const createPluginFile = async (
	body: { fileName: string; content: string; scope: PluginScope },
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/plugins/file${queryParams}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to create plugin file",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error ? err.message : "Failed to create plugin file",
		};
	}
};

/** PUT /api/config/plugins/file/:id - update an existing plugin file */
export const updatePluginFile = async (
	id: string,
	body: { content: string },
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (directory) {
		headers["x-opencode-directory"] = directory;
	}
	try {
		const response = await runtimeFetch(
			`/api/config/plugins/file/${encodeURIComponent(id)}${queryParams}`,
			{
				method: "PUT",
				headers,
				body: JSON.stringify(body),
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to update plugin file",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error ? err.message : "Failed to update plugin file",
		};
	}
};

/** DELETE /api/config/plugins/file/:id - delete a plugin file */
export const deletePluginFile = async (
	id: string,
	directory?: string | null,
): Promise<ConfigMutationResult> => {
	const queryParams = directory
		? `?directory=${encodeURIComponent(directory)}`
		: "";
	try {
		const response = await runtimeFetch(
			`/api/config/plugins/file/${encodeURIComponent(id)}${queryParams}`,
			{
				method: "DELETE",
				headers: directory ? { "x-opencode-directory": directory } : undefined,
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok) {
			return {
				ok: false,
				error: payload?.error || "Failed to delete plugin file",
			};
		}
		return {
			ok: true,
			requiresReload: payload?.requiresReload ?? true,
			reloadFailed: payload?.reloadFailed === true,
			message: payload?.message,
			warning: payload?.warning,
			reloadDelayMs: payload?.reloadDelayMs,
		};
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof Error ? err.message : "Failed to delete plugin file",
		};
	}
};
