/**
 * Reproduction test for issue #1691:
 * "Hide All" / "Show All" applies to the entire models list while a filter is active.
 *
 * Root cause (line 998 of ProvidersPage.tsx):
 *   const allIds = providerModels     // ← uses the FULL list, NOT filteredModels
 *     .map((model) => (typeof model?.id === 'string' ? model.id : ''))
 *     .filter((id) => id.length > 0);
 *   hideAllModels(selectedProvider.id, allIds);
 *
 * When a search filter is active, `filteredModels` contains only the matching subset,
 * but `providerModels` contains ALL models for the provider. The buttons should
 * operate on `filteredModels` when a filter is active, not `providerModels`.
 *
 * Similarly, `showAllModels(selectedProvider.id)` removes ALL hidden entries for the
 * provider, not just the currently filtered ones.
 */
import { describe, expect, test } from 'bun:test';

/**
 * Simulates the exact filtering logic from ProvidersPage.tsx (lines 772-778).
 */
function filterModels(
  models: Array<{ id: string; name?: string }>,
  query: string,
): Array<{ id: string; name?: string }> {
  return models.filter((model) => {
    const name = typeof model?.name === 'string' ? model.name : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
  });
}

/**
 * Simulates the exact hideAllModels store implementation (useUIStore.ts lines 1765-1772).
 */
function hideAllModels(
  hiddenModels: Array<{ providerID: string; modelID: string }>,
  providerID: string,
  modelIDs: string[],
): Array<{ providerID: string; modelID: string }> {
  const current = hiddenModels.filter((item) => item.providerID !== providerID);
  const additions = modelIDs
    .filter((modelID) => typeof modelID === 'string' && modelID.length > 0)
    .map((modelID) => ({ providerID, modelID }));
  return [...additions, ...current];
}

/**
 * Simulates the exact showAllModels store implementation (useUIStore.ts lines 1775-1778).
 */
function showAllModels(
  hiddenModels: Array<{ providerID: string; modelID: string }>,
  providerID: string,
): Array<{ providerID: string; modelID: string }> {
  return hiddenModels.filter((item) => item.providerID !== providerID);
}

describe('Issue #1691 - Hide/Show All ignores active filter', () => {
  // Simulate OpenRouter's model list, with some models matching "free" and some not
  const mockModels: Array<{ id: string; name?: string }> = [
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'openai/o1-mini', name: 'O1 Mini (Free)' },
    { id: 'openai/o3-mini', name: 'O3 Mini (Free)' },
    { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash' },
    { id: 'google/gemini-2.0-flash-lite-preview-02-05', name: 'Gemini 2.0 Flash Lite Preview' },
    { id: 'google/gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Free)' },
    { id: 'google/gemma-3-27b-it', name: 'Gemma 3 27B IT' },
    { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B Instruct' },
    { id: 'mistralai/mistral-small-24b-instruct-2501', name: 'Mistral Small 24B' },
    { id: 'qwen/qwq-32b', name: 'QwQ 32B' },
  ];

  // Models that match the query "free" (case-insensitive in name or id)
  const MODELS_MATCHING_FREE = ['openai/o1-mini', 'openai/o3-mini', 'google/gemini-2.0-flash-exp'];
  const PROVIDER = 'openrouter';

  test('filtering with "free" returns only matching models', () => {
    const filtered = filterModels(mockModels, 'free');
    const filteredIds = filtered.map((m) => m.id).sort();
    expect(filteredIds).toEqual([...MODELS_MATCHING_FREE].sort());
    // Confirm some models are excluded from the filtered view
    expect(filteredIds).not.toContain('openai/gpt-4o');
    expect(filteredIds).not.toContain('meta-llama/llama-3.3-70b-instruct');
  });

  test('BUG: Hide All uses providerModels (full list) instead of filteredModels', () => {
    // Simulate having the filter "free" active
    const filtered = filterModels(mockModels, 'free');
    expect(filtered.length).toBe(3); // sanity check: only 3 models match "free"

    // This is what the component currently does (BUG):
    // It uses `providerModels` (the full list) instead of `filteredModels`
    const allIds = mockModels  // ← BUG: should be `filteredModels`, not `providerModels`
      .map((model) => (typeof model?.id === 'string' ? model.id : ''))
      .filter((id) => id.length > 0);

    // Verify: all 12 models are passed to hideAllModels, not just the 3 filtered ones
    expect(allIds.length).toBe(mockModels.length); // 12 models, not 3
    expect(allIds.length).not.toBe(filtered.length); // 12 !== 3

    // When hideAllModels is called with all 12 IDs, ALL models become hidden
    let hiddenModels: Array<{ providerID: string; modelID: string }> = [];
    hiddenModels = hideAllModels(hiddenModels, PROVIDER, allIds);

    // All 12 models are now hidden (including ones NOT matching the filter)
    expect(hiddenModels.length).toBe(mockModels.length);
    for (const model of mockModels) {
      expect(hiddenModels.some((h) => h.modelID === model.id)).toBe(true);
    }
  });

  test('CORRECT behavior: Hide All should use filteredModels when filter is active', () => {
    // Simulate having the filter "free" active
    const filtered = filterModels(mockModels, 'free');
    expect(filtered.length).toBe(3);

    // This is how it SHOULD work:
    const allIds = filtered  // ← CORRECT: uses filtered list
      .map((model) => (typeof model?.id === 'string' ? model.id : ''))
      .filter((id) => id.length > 0);

    expect(allIds.length).toBe(filtered.length); // 3 models only
    expect(allIds).not.toContain('openai/gpt-4o'); // non-filtered model is excluded

    // Only the 3 filtered models become hidden
    let hiddenModels: Array<{ providerID: string; modelID: string }> = [];
    hiddenModels = hideAllModels(hiddenModels, PROVIDER, allIds);

    expect(hiddenModels.length).toBe(3);
    for (const model of filtered) {
      expect(hiddenModels.some((h) => h.modelID === model.id)).toBe(true);
    }
    // Models not matching the filter should NOT be hidden
    expect(hiddenModels.some((h) => h.modelID === 'openai/gpt-4o')).toBe(false);
    expect(hiddenModels.some((h) => h.modelID === 'meta-llama/llama-3.3-70b-instruct')).toBe(false);
  });

  test('BUG: Show All removes ALL hidden models for provider, ignoring filter', () => {
    // Simulate having some models hidden and a filter active
    const initialHidden = [
      { providerID: PROVIDER, modelID: 'openai/o1-mini' },
      { providerID: PROVIDER, modelID: 'openai/o3-mini' },
      { providerID: PROVIDER, modelID: 'google/gemini-2.0-flash-exp' },
      { providerID: PROVIDER, modelID: 'meta-llama/llama-3.3-70b-instruct' }, // this one is NOT in filtered view
    ];

    // Filter is "free" - user sees only 3 models as hidden
    const filtered = filterModels(mockModels, 'free');
    const filteredHidden = initialHidden.filter((h) =>
      filtered.some((m) => m.id === h.modelID),
    );
    expect(filteredHidden.length).toBe(3); // user sees 3 hidden models

    // Current behavior: showAllModels removes ALL hidden entries for provider
    const afterShowAll = showAllModels(initialHidden, PROVIDER);
    expect(afterShowAll.length).toBe(0); // ALL hidden models removed, including the non-filtered one

    // But if user intended "Show All" to only affect the 3 visible/filtered models,
    // models like `meta-llama/llama-3.3-70b-instruct` (not in filtered view) would
    // have been inadvertently shown too
    const expectedIfScoped = initialHidden.filter(
      (h) => !filtered.some((m) => m.id === h.modelID),
    );
    expect(expectedIfScoped.length).toBe(1); // the non-filtered hidden model remains hidden
    expect(expectedIfScoped[0].modelID).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  test('the exact code path: providersModels vs filteredModels in onClick', () => {
    // This test replicates the exact code from ProvidersPage.tsx lines 997-1002
    // to demonstrate the bug in the most literal way possible

    const modelQuery = 'free';

    // --- This is the current (buggy) code path ---
    const providerModels = mockModels; // the full list

    const buggyAllIds = providerModels
      .map((model) => (typeof model?.id === 'string' ? model.id : ''))
      .filter((id) => id.length > 0);

    // --- This is the correct code path (what should happen) ---
    const filteredModels = filterModels(mockModels, modelQuery);

    const correctAllIds = filteredModels
      .map((model) => (typeof model?.id === 'string' ? model.id : ''))
      .filter((id) => id.length > 0);

    // The buggy path passes 12 models, the correct path passes only 3
    expect(buggyAllIds.length).toBe(12);
    expect(correctAllIds.length).toBe(3);

    // Models that don't match the filter should NOT be included in the hide-all
    // but the current buggy code includes them
    const nonMatchingModels = providerModels.filter(
      (m) => !filteredModels.some((fm) => fm.id === m.id),
    );
    for (const nm of nonMatchingModels) {
      expect(buggyAllIds).toContain(nm.id);        // BUG: non-matching model is included
      expect(correctAllIds).not.toContain(nm.id);   // CORRECT: non-matching model is excluded
    }
  });
});
