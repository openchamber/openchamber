import { describe, expect, test } from 'bun:test';
import { applyTerminalModifier, terminalControlCharacter, terminalSequenceForKey } from './terminalInput';

describe('terminal input translation', () => {
  test('translates navigation, editing, and control keys', () => {
    expect(terminalSequenceForKey('arrow-up', null)).toBe('\u001b[A');
    expect(terminalSequenceForKey('arrow-left', 'ctrl')).toBe('\u001b[1;5D');
    expect(terminalSequenceForKey('arrow-right', 'alt')).toBe('\u001b[1;3C');
    expect(terminalSequenceForKey('enter', null)).toBe('\r');
    expect(terminalControlCharacter('c')).toBe('\u0003');
    expect(terminalControlCharacter('[')).toBeNull();
    expect(applyTerminalModifier('c', 'ctrl')).toBe('\u0003');
    expect(applyTerminalModifier('b', 'alt')).toBe('\u001bb');
    expect(applyTerminalModifier('\u001b[1;3C', 'alt')).toBe('\u001b[1;3C');
  });
});
