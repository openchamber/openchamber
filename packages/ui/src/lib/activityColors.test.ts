import { describe, expect, test } from 'bun:test';

import {
  getActivityColorCategory,
  getActivityColorStyle,
  getActivityColorVar,
  normalizeActivityToolName,
  REASONING_ACTIVITY_CATEGORY,
} from './activityColors';

describe('activity color categories', () => {
  test('classifies every documented tool family', () => {
    expect(getActivityColorCategory('read')).toBe('read');
    expect(getActivityColorCategory('list')).toBe('read');
    expect(getActivityColorCategory('lsp')).toBe('read');
    expect(getActivityColorCategory('edit')).toBe('edit');
    expect(getActivityColorCategory('multiedit')).toBe('edit');
    expect(getActivityColorCategory('apply_patch')).toBe('edit');
    expect(getActivityColorCategory('write')).toBe('write');
    expect(getActivityColorCategory('bash')).toBe('shell');
    expect(getActivityColorCategory('grep')).toBe('search');
    expect(getActivityColorCategory('glob')).toBe('search');
    expect(getActivityColorCategory('webfetch')).toBe('web');
    expect(getActivityColorCategory('websearch')).toBe('web');
    expect(getActivityColorCategory('codesearch')).toBe('web');
    expect(getActivityColorCategory('question')).toBe('question');
    expect(getActivityColorCategory('task')).toBe('agent');
    expect(getActivityColorCategory('skill')).toBe('agent');
  });

  test('keeps system bookkeeping and unknown tools neutral', () => {
    expect(getActivityColorCategory('todowrite')).toBe('system');
    expect(getActivityColorCategory('plan_enter')).toBe('system');
    expect(getActivityColorCategory('structuredoutput')).toBe('system');
    expect(getActivityColorCategory('openchamber_memory')).toBe('system');
    expect(getActivityColorCategory('linear_save_issue')).toBe('system');
    expect(getActivityColorCategory('totally_unknown_tool')).toBe('system');
    expect(getActivityColorCategory(undefined)).toBe('system');
    expect(getActivityColorCategory(null)).toBe('system');
    expect(getActivityColorCategory('')).toBe('system');
    expect(getActivityColorCategory('   ')).toBe('system');
  });

  test('normalizes dotted MCP names and :N suffixes before classifying', () => {
    expect(normalizeActivityToolName('mcp.edit')).toBe('edit');
    expect(normalizeActivityToolName('runtime.read:2')).toBe('read');
    expect(getActivityColorCategory('plugin.bash:1')).toBe('shell');
  });

  test('aliases shared by the tool renderers resolve to one category', () => {
    expect(getActivityColorCategory('file_read')).toBe('read');
    expect(getActivityColorCategory('str_replace_based_edit_tool')).toBe('edit');
    expect(getActivityColorCategory('file_write')).toBe('write');
    expect(getActivityColorCategory('terminal')).toBe('shell');
    expect(getActivityColorCategory('ripgrep')).toBe('search');
    expect(getActivityColorCategory('perplexity')).toBe('web');
  });
});

describe('activity color variables', () => {
  test('maps categories to their theme variables', () => {
    expect(getActivityColorVar('thinking')).toBe('var(--tools-activity-thinking)');
    expect(getActivityColorVar('shell')).toBe('var(--tools-activity-shell)');
    expect(getActivityColorVar('agent')).toBe('var(--tools-activity-agent)');
  });

  test('system stays neutral so rows keep the regular tool styling', () => {
    expect(getActivityColorVar('system')).toBeNull();
    expect(getActivityColorVar(undefined)).toBeNull();
    expect(getActivityColorStyle('system')).toBeNull();
    expect(getActivityColorStyle(undefined)).toBeNull();
  });

  test('returns paired icon and title colors for colored categories', () => {
    expect(getActivityColorStyle('edit')).toEqual({
      icon: 'var(--tools-activity-edit)',
      title: 'var(--tools-activity-edit)',
    });
  });

  test('reasoning and justification share the thinking category', () => {
    expect(REASONING_ACTIVITY_CATEGORY).toBe('thinking');
  });
});
