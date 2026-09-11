import { parse as parseJsonc } from 'jsonc-parser';

const isJsonObject = (value) => value !== null && value !== undefined && Object.getPrototypeOf(value) === Object.prototype;

/**
 * Append a managed OpenChamber plugin to the `plugin` list of an
 * `OPENCODE_CONFIG_CONTENT` value.
 *
 * Existing entries are preserved; an earlier entry for the same URL is dropped
 * so a restart never registers the same plugin twice. Every managed plugin
 * (agent tools, system prompt optimizer, MCP reconnect) goes through this one
 * merge so they compose in any order.
 *
 * @param {string | undefined} rawConfig the current `OPENCODE_CONFIG_CONTENT`, JSONC or unset
 * @param {string} pluginUrl `file://` URL of the materialized plugin
 * @param {string} purpose short noun phrase for the error message, e.g. "managed tool"
 * @returns {string} the merged config as JSON
 */
export const appendManagedPlugin = (rawConfig, pluginUrl, purpose) => {
  const errors = [];
  const text = (rawConfig ?? '').trim();
  const parsed = text ? parseJsonc(text, errors, { allowTrailingComma: true }) : {};
  if (errors.length > 0 || !isJsonObject(parsed)) {
    throw new Error(`OPENCODE_CONFIG_CONTENT must contain a valid JSON object before OpenChamber can inject its ${purpose}`);
  }
  if (parsed.plugin !== undefined && !Array.isArray(parsed.plugin)) {
    throw new Error(`OPENCODE_CONFIG_CONTENT plugin must be an array before OpenChamber can inject its ${purpose}`);
  }
  const configured = Array.isArray(parsed.plugin) ? parsed.plugin : [];
  parsed.plugin = [
    ...configured.filter((value) => value !== pluginUrl && (!Array.isArray(value) || value[0] !== pluginUrl)),
    pluginUrl,
  ];
  return JSON.stringify(parsed);
};
