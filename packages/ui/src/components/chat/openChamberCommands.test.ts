import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import {
  getOpenChamberCommands,
  getLatestCompletedAssistantMessageId,
  getLatestCompletedAssistantMessageIdFromRecords,
  mergeOpenChamberCommands,
  parseSideChatCommand,
} from './openChamberCommands';

const message = (id: string, role: 'user' | 'assistant', completed?: number): Message => ({
  id,
  role,
  sessionID: 'parent',
  time: { created: Number(id.replace(/\D/g, '')) || 1, ...(completed === undefined ? {} : { completed }) },
} as Message);

describe('OpenChamber side commands', () => {
  test('discovers commands only on web or desktop main chat', () => {
    expect(getOpenChamberCommands({ surface: 'main', isMobile: false, isVSCode: false }).map((item) => item.name)).toEqual(['side', 'btw']);
    expect(getOpenChamberCommands({ surface: 'embedded', isMobile: false, isVSCode: false })).toEqual([]);
    expect(getOpenChamberCommands({ surface: 'main', isMobile: true, isVSCode: false })).toEqual([]);
    expect(getOpenChamberCommands({ surface: 'main', isMobile: false, isVSCode: true })).toEqual([]);
  });

  test('adds localized descriptions to both aliases', () => {
    expect(getOpenChamberCommands({
      surface: 'main',
      isMobile: false,
      isVSCode: false,
      sideChatDescription: 'Localized side description',
      btwDescription: 'Localized alias description',
    }).map((item) => item.description)).toEqual([
      'Localized side description',
      'Localized alias description',
    ]);
  });

  test('parses exact case-insensitive aliases and preserves multiline trailing text', () => {
    expect(parseSideChatCommand('/SIDE explain this\nwith details')).toEqual({ name: 'side', prompt: 'explain this\nwith details' });
    expect(parseSideChatCommand('/btw')).toEqual({ name: 'btw', prompt: '' });
    expect(parseSideChatCommand('/sidebar explain this')).toBeNull();
    expect(parseSideChatCommand(' /side explain this')).toBeNull();
  });

  test('keeps OpenChamber commands ahead of colliding project commands without duplicates', () => {
    const merged = mergeOpenChamberCommands(
      getOpenChamberCommands({ surface: 'main', isMobile: false, isVSCode: false }),
      [{ id: 'project:side', name: 'side' }, { id: 'project:test', name: 'test' }],
    );
    expect(merged.map((item) => item.id)).toEqual(['openchamber:side', 'openchamber:btw', 'project:test']);
  });
});

describe('latest completed assistant selection', () => {
  test('ignores a streaming tail and selects the newest authoritative completion', () => {
    expect(getLatestCompletedAssistantMessageId([
      message('msg1', 'assistant', 100),
      message('msg2', 'user'),
      message('msg3', 'assistant', 300),
      message('msg4', 'assistant'),
    ])).toBe('msg3');
  });

  test('returns null when no assistant completion exists', () => {
    expect(getLatestCompletedAssistantMessageId([message('msg1', 'user'), message('msg2', 'assistant')])).toBeNull();
  });

  test('selects completed assistant messages from API records', () => {
    expect(getLatestCompletedAssistantMessageIdFromRecords([
      { info: message('msg1', 'assistant', 100) },
      { info: message('msg2', 'assistant') },
    ])).toBe('msg1');
  });
});
