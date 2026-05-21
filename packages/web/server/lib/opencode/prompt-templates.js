import {
  readConfigLayers,
  writeConfig,
  getJsonWriteTarget,
  CONFIG_FILE,
} from './shared.js';

const SECTION_KEY = 'promptTemplates';

const DEFAULT_TEMPLATES = {
  simple: {
    name: 'Simple',
    body: 'Implement this task using the simplest possible approach. Prefer readability and straightforward solutions over clever abstractions. Keep the code easy to understand and maintain.',
    isDefault: true,
  },
  fast: {
    name: 'Fast',
    body: 'Implement this task as quickly as possible. Optimize for speed of development. Use the most direct path to a working solution. Favor existing libraries and proven patterns.',
    isDefault: true,
  },
  'memory-efficient': {
    name: 'Memory Efficient',
    body: 'Implement this task with memory efficiency in mind. Minimize memory allocations, use streaming where possible, avoid holding large data structures in memory, and prefer lazy evaluation.',
    isDefault: true,
  },
  'cpu-efficient': {
    name: 'CPU Efficient',
    body: 'Implement this task with CPU efficiency in mind. Optimize algorithms, minimize unnecessary computations, use efficient data structures, and avoid redundant work.',
    isDefault: true,
  },
  'tests-first': {
    name: 'Tests First',
    body: 'Implement this task using a test-driven approach. Write tests first, then implement the minimum code to pass them. Ensure comprehensive test coverage including edge cases.',
    isDefault: true,
  },
  'spec-first': {
    name: 'Spec First',
    body: 'Implement this task by first creating a detailed specification, then implementing according to the spec. Start by documenting the requirements, interfaces, and expected behavior before writing any implementation code.',
    isDefault: true,
  },
};

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

function ensureDefaults(templates) {
  if (!templates || typeof templates !== 'object') {
    return { ...DEFAULT_TEMPLATES };
  }

  let changed = false;
  const result = { ...templates };

  for (const [id, template] of Object.entries(DEFAULT_TEMPLATES)) {
    if (!(id in result)) {
      result[id] = { ...template };
      changed = true;
    }
  }

  return changed ? result : templates;
}

function readTemplatesFromConfig(workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const merged = layers.mergedConfig || {};
  const raw = merged[SECTION_KEY];

  if (!raw || typeof raw !== 'object') {
    return ensureDefaults(null);
  }

  return ensureDefaults(raw);
}

function writeTemplatesToConfig(templates, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const target = getJsonWriteTarget(layers, 'user');
  const config = { ...target.config };
  config[SECTION_KEY] = templates;
  writeConfig(config, target.path || CONFIG_FILE);
}

export function listPromptTemplates(workingDirectory) {
  const templates = readTemplatesFromConfig(workingDirectory);
  return Object.entries(templates).map(([id, value]) => ({
    id,
    name: value.name || id,
    body: value.body || '',
    isDefault: value.isDefault === true,
  }));
}

export function getPromptTemplate(id, workingDirectory) {
  const templates = readTemplatesFromConfig(workingDirectory);
  const entry = templates[id];
  if (!entry) {
    return null;
  }
  return {
    id,
    name: entry.name || id,
    body: entry.body || '',
    isDefault: entry.isDefault === true,
  };
}

export function createPromptTemplate(id, config, workingDirectory) {
  const templates = readTemplatesFromConfig(workingDirectory);

  if (templates[id]) {
    throw new Error(`Prompt template "${id}" already exists`);
  }

  templates[id] = {
    name: config.name || id,
    body: config.body || '',
    isDefault: false,
  };

  writeTemplatesToConfig(templates, workingDirectory);
  return getPromptTemplate(id, workingDirectory);
}

export function updatePromptTemplate(id, updates, workingDirectory) {
  const templates = readTemplatesFromConfig(workingDirectory);
  const existing = templates[id];

  if (!existing) {
    throw new Error(`Prompt template "${id}" not found`);
  }

  templates[id] = {
    ...existing,
    ...(updates.name !== undefined ? { name: updates.name } : {}),
    ...(updates.body !== undefined ? { body: updates.body } : {}),
  };

  writeTemplatesToConfig(templates, workingDirectory);
  return getPromptTemplate(id, workingDirectory);
}

export function deletePromptTemplate(id, workingDirectory) {
  const templates = readTemplatesFromConfig(workingDirectory);

  if (!templates[id]) {
    throw new Error(`Prompt template "${id}" not found`);
  }

  delete templates[id];
  writeTemplatesToConfig(templates, workingDirectory);
}

export { slugify };
