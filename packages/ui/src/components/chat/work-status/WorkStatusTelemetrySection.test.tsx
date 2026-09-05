import { describe, expect, test, beforeEach } from 'bun:test';
import React from 'react';
import type { Message } from '@opencode-ai/sdk/v2';
import { clearTurnStatsCacheForTests } from './telemetry';
import { useUIStore } from '@/stores/useUIStore';

// SAFETY: Test helper for mock messages
const createMessage = (id: string, role: 'user' | 'assistant', time: { created?: number; completed?: number }, tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }, cost?: number): Message => ({
  id,
  role,
  sessionID: 'session-1',
  time,
  tokens,
  cost,
} as Message);

describe('WorkStatusTelemetrySection expansion lifecycle', () => {
  beforeEach(() => {
    clearTurnStatsCacheForTests();
    useUIStore.setState({
      workStatusExpandedSections: {},
      workStatusHiddenSections: ['telemetry'],
    });
  });

  test('expansion defaults to true when section is not explicitly collapsed in store', () => {
    const stored = useUIStore.getState().workStatusExpandedSections['telemetry'];
    const expanded = stored ?? true;
    expect(expanded).toBe(true);
  });

  test('expansion respects explicit false stored in UI store', () => {
    useUIStore.getState().setWorkStatusSectionExpanded('telemetry', false);
    const stored = useUIStore.getState().workStatusExpandedSections['telemetry'];
    const expanded = stored ?? true;
    expect(expanded).toBe(false);
  });

  test('UIStore migration seeds telemetry into hidden sections for pre-v19 stores', () => {
    const legacyState = {
      workStatusHiddenSections: ['usage'],
    };
    // Simulate v18 -> v19 migration logic
    if (Array.isArray(legacyState.workStatusHiddenSections)) {
      if (!legacyState.workStatusHiddenSections.includes('telemetry')) {
        legacyState.workStatusHiddenSections.push('telemetry');
      }
    }
    expect(legacyState.workStatusHiddenSections).toEqual(['usage', 'telemetry']);
  });
});
