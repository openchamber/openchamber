export type TerminalModifier = 'ctrl' | 'alt';
export type TerminalQuickKey = 'esc' | 'tab' | 'enter' | 'arrow-up' | 'arrow-down' | 'arrow-left' | 'arrow-right';

const sequences: Record<TerminalQuickKey, string> = {
  esc: '\u001b', tab: '\t', enter: '\r',
  'arrow-up': '\u001b[A', 'arrow-down': '\u001b[B', 'arrow-left': '\u001b[D', 'arrow-right': '\u001b[C',
};

export const terminalSequenceForKey = (key: TerminalQuickKey, modifier: TerminalModifier | null): string => {
  if (modifier && key.startsWith('arrow-')) {
    const suffix = modifier === 'ctrl' ? '5' : '3';
    const direction = { 'arrow-up': 'A', 'arrow-down': 'B', 'arrow-right': 'C', 'arrow-left': 'D' }[key as 'arrow-up' | 'arrow-down' | 'arrow-right' | 'arrow-left'];
    return `\u001b[1;${suffix}${direction}`;
  }
  return sequences[key];
};

export const terminalControlCharacter = (value: string): string | null => {
  const character = value[0]?.toUpperCase();
  if (!character || character < 'A' || character > 'Z') return null;
  return String.fromCharCode(character.charCodeAt(0) & 0b11111);
};

export const applyTerminalModifier = (value: string, modifier: TerminalModifier): string => {
  if (!value) return value;
  if (modifier === 'ctrl') return terminalControlCharacter(value) ?? value;
  return value.length === 1 && value !== '\u001b' ? `\u001b${value}` : value;
};
