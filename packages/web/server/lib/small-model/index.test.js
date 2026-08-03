import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The settings override is read straight from disk at module load, so without
// this the suite would resolve whatever small model the developer running it
// happens to have configured.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'small-model-settings-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

vi.mock('../opencode/auth.js', () => ({ readAuthFile: vi.fn() }));
vi.mock('../opencode/shared.js', () => ({
  readConfig: vi.fn(),
  readConfigLayers: vi.fn(),
}));
vi.mock('./catalog.js', () => ({
  getModelCatalog: vi.fn(),
  getCatalogProvider: vi.fn(),
}));
vi.mock('./call.js', () => ({ callSmallModel: vi.fn() }));

const { generateSmallModelText, describeSmallModel } = await import('./index.js');
const { readAuthFile } = await import('../opencode/auth.js');
const { readConfigLayers } = await import('../opencode/shared.js');
const { getModelCatalog } = await import('./catalog.js');
const { callSmallModel } = await import('./call.js');

// 8k context leaves 4k input tokens after the output reserve → 16k chars.
const CATALOG = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-haiku-4-5': { id: 'claude-haiku-4-5', limit: { context: 8_000 }, structured_output: true },
      'legacy-tiny': { id: 'legacy-tiny', limit: { context: 8_000 }, structured_output: false },
      'unlisted-capability': { id: 'unlisted-capability', limit: { context: 8_000 } },
    },
  },
};

const request = (overrides = {}) => ({
  prompt: 'x'.repeat(20_000),
  model: 'anthropic/claude-haiku-4-5',
  directory: '/proj',
  ...overrides,
});

describe('generateSmallModelText — oversized input', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ anthropic: { type: 'api', key: 'sk-ant' } });
    readConfigLayers.mockReturnValue({ mergedConfig: {} });
    getModelCatalog.mockResolvedValue(CATALOG);
    callSmallModel.mockReset();
    callSmallModel.mockResolvedValue('generated');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('truncates and flags the response by default', async () => {
    const result = await generateSmallModelText(request());

    expect(result.inputTruncated).toBe(true);
    const sent = callSmallModel.mock.calls.at(-1)[0].prompt;
    expect(sent.length).toBeLessThan(20_000);
    expect(sent.endsWith('…')).toBe(true);
  });

  it('refuses without calling the provider when the caller cannot survive truncation', async () => {
    await expect(generateSmallModelText(request({ onOverflow: 'error' })))
      .rejects.toMatchObject({
        statusCode: 413,
        code: 'context-too-small',
        requiredChars: 20_000,
        availableChars: 16_000,
      });

    expect(callSmallModel).not.toHaveBeenCalled();
  });

  it('leaves an input that fits untouched under either policy', async () => {
    const result = await generateSmallModelText(request({ prompt: 'short prompt', onOverflow: 'error' }));

    expect(result.inputTruncated).toBeUndefined();
    expect(callSmallModel.mock.calls.at(-1)[0].prompt).toBe('short prompt');
  });

  it('forwards schema, timeout, and abort signal to the transport', async () => {
    const controller = new AbortController();
    const schema = { type: 'object' };

    await generateSmallModelText(request({
      prompt: 'short',
      responseSchema: schema,
      timeoutMs: 240_000,
      signal: controller.signal,
    }));

    expect(callSmallModel.mock.calls.at(-1)[0]).toMatchObject({
      responseSchema: schema,
      timeoutMs: 240_000,
      signal: controller.signal,
    });
  });
});

describe('describeSmallModel — capability reporting', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ anthropic: { type: 'api', key: 'sk-ant' } });
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/claude-haiku-4-5' } });
    getModelCatalog.mockResolvedValue(CATALOG);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports the input budget and a known structured-output capability', async () => {
    const described = await describeSmallModel({ directory: '/proj' });

    expect(described).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      inputCharBudget: 16_000,
      contextTokens: 8_000,
      contextKnown: true,
      structuredOutput: true,
    });
  });

  it('reports an explicit false so callers can block the model', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/legacy-tiny' } });

    const described = await describeSmallModel({ directory: '/proj' });

    expect(described.structuredOutput).toBe(false);
  });

  it('reports null — not false — when the catalog omits the capability', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/unlisted-capability' } });

    const described = await describeSmallModel({ directory: '/proj' });

    expect(described.structuredOutput).toBeNull();
  });
});

// The input reserve and the requested output budget are the same number seen
// from two sides; if they drift, a caller that asks for a large answer overruns
// the model's context and the failure looks like a truncation bug.
describe('output budget and input reserve', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ anthropic: { type: 'api', key: 'sk-ant' } });
    readConfigLayers.mockReturnValue({ mergedConfig: {} });
    getModelCatalog.mockResolvedValue({
      anthropic: {
        id: 'anthropic',
        models: {
          roomy: { id: 'roomy', limit: { context: 100_000, output: 8_000 } },
          unlisted: { id: 'unlisted', limit: { context: 100_000 } },
        },
      },
    });
    callSmallModel.mockReset();
    callSmallModel.mockResolvedValue('generated');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('caps the request at the model\'s advertised output limit', async () => {
    await generateSmallModelText({
      prompt: 'short',
      model: 'anthropic/roomy',
      maxOutputTokens: 24_000,
    });

    expect(callSmallModel.mock.calls.at(-1)[0].maxOutputTokens).toBe(8_000);
  });

  it('honours the requested budget when the catalog states no output limit', async () => {
    await generateSmallModelText({
      prompt: 'short',
      model: 'anthropic/unlisted',
      maxOutputTokens: 24_000,
    });

    expect(callSmallModel.mock.calls.at(-1)[0].maxOutputTokens).toBe(24_000);
  });

  it('reserves exactly the requested output budget from the input allowance', async () => {
    // 100k context − 24k reserved for the answer = 76k tokens ≈ 304k chars.
    await expect(generateSmallModelText({
      prompt: 'x'.repeat(304_001),
      model: 'anthropic/unlisted',
      maxOutputTokens: 24_000,
      onOverflow: 'error',
    })).rejects.toMatchObject({ code: 'context-too-small', availableChars: 304_000 });

    await expect(generateSmallModelText({
      prompt: 'x'.repeat(303_999),
      model: 'anthropic/unlisted',
      maxOutputTokens: 24_000,
      onOverflow: 'error',
    })).resolves.toBeTruthy();
  });

  it('reports the same budget through describeSmallModel', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/unlisted' } });

    const described = await describeSmallModel({ directory: '/proj', outputReserveTokens: 24_000 });

    expect(described.inputCharBudget).toBe(304_000);
  });

  // A caller that wants "as much room as this model allows" cannot name a
  // number before knowing which model it got, so it hands over the decision.
  it('lets the reserve be decided from the resolved model\'s limits', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/roomy' } });

    const described = await describeSmallModel({
      directory: '/proj',
      outputReserveTokens: ({ contextTokens, outputTokenLimit }) => Math.min(contextTokens / 10, outputTokenLimit),
    });

    // 100k context, 8k output limit -> 8k reserved, leaving 92k tokens.
    expect(described.outputTokens).toBe(8_000);
    expect(described.inputCharBudget).toBe(92_000 * 4);
  });

  it('reports the reserve it used so the caller can request the same number', async () => {
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/unlisted' } });

    const described = await describeSmallModel({ directory: '/proj', outputReserveTokens: 24_000 });

    expect(described.outputTokens).toBe(24_000);
  });
});

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});
