import fs from 'fs';
import path from 'path';
import { OPENCODE_CONFIG_DIR, readConfigFile } from './shared.js';

const OH_MY_OPENCODE_FILE = path.join(OPENCODE_CONFIG_DIR, 'oh-my-opencode.json');

/**
 * Check if oh-my-opencode plugin is installed by examining opencode.json's plugin array.
 */
function isOhMyOpencodeInstalled(workingDirectory) {
  const config = readConfigFile(path.join(OPENCODE_CONFIG_DIR, 'opencode.json'));
  const plugins = config?.plugin;
  if (!Array.isArray(plugins)) return false;
  return plugins.some(
    (p) => typeof p === 'string' && p.startsWith('oh-my-opencode')
  );
}

/**
 * Read the oh-my-opencode.json configuration file.
 * Returns null if file does not exist.
 */
function readOhMyOpencodeConfig() {
  if (!fs.existsSync(OH_MY_OPENCODE_FILE)) {
    return null;
  }
  try {
    const content = fs.readFileSync(OH_MY_OPENCODE_FILE, 'utf8');
    const normalized = content.trim();
    if (!normalized) return null;
    return JSON.parse(normalized);
  } catch (error) {
    console.error(`Failed to read oh-my-opencode config: ${OH_MY_OPENCODE_FILE}`, error);
    return null;
  }
}

/**
 * Write updated categories to oh-my-opencode.json.
 * Preserves all existing fields, only updates the categories section.
 * @param {Record<string, {model: string, variant?: string}>} categories
 */
function writeOhMyOpencodeCategories(categories) {
  let existing = {};
  if (fs.existsSync(OH_MY_OPENCODE_FILE)) {
    try {
      const content = fs.readFileSync(OH_MY_OPENCODE_FILE, 'utf8');
      const normalized = content.trim();
      if (normalized) {
        existing = JSON.parse(normalized);
      }
    } catch (error) {
      console.error('Failed to read existing oh-my-opencode config for update:', error);
    }

    // Create backup before writing
    const backupFile = `${OH_MY_OPENCODE_FILE}.openchamber.backup`;
    try {
      fs.copyFileSync(OH_MY_OPENCODE_FILE, backupFile);
      console.log(`Created oh-my-opencode backup: ${backupFile}`);
    } catch {
      // Non-fatal
    }
  }

  existing.categories = categories;

  try {
    fs.writeFileSync(OH_MY_OPENCODE_FILE, JSON.stringify(existing, null, 2), 'utf8');
    console.log('Successfully wrote oh-my-opencode categories');
  } catch (error) {
    console.error('Failed to write oh-my-opencode config:', error);
    throw new Error('Failed to write oh-my-opencode configuration');
  }
}

/**
 * Write updated agents to oh-my-opencode.json.
 * Preserves all existing fields, only updates the agents section.
 * @param {Record<string, {model: string, variant?: string}>} agents
 */
function writeOhMyOpencodeAgents(agents) {
  let existing = {};
  if (fs.existsSync(OH_MY_OPENCODE_FILE)) {
    try {
      const content = fs.readFileSync(OH_MY_OPENCODE_FILE, 'utf8');
      const normalized = content.trim();
      if (normalized) {
        existing = JSON.parse(normalized);
      }
    } catch (error) {
      console.error('Failed to read existing oh-my-opencode config for agent update:', error);
    }

    // Create backup before writing
    const backupFile = `${OH_MY_OPENCODE_FILE}.openchamber.backup`;
    try {
      fs.copyFileSync(OH_MY_OPENCODE_FILE, backupFile);
      console.log(`Created oh-my-opencode backup: ${backupFile}`);
    } catch {
      // Non-fatal
    }
  }

  existing.agents = agents;

  try {
    fs.writeFileSync(OH_MY_OPENCODE_FILE, JSON.stringify(existing, null, 2), 'utf8');
    console.log('Successfully wrote oh-my-opencode agents');
  } catch (error) {
    console.error('Failed to write oh-my-opencode config:', error);
    throw new Error('Failed to write oh-my-opencode configuration');
  }
}

export {
  OH_MY_OPENCODE_FILE,
  isOhMyOpencodeInstalled,
  readOhMyOpencodeConfig,
  writeOhMyOpencodeCategories,
  writeOhMyOpencodeAgents,
};
