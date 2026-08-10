// Key definitions for CDP Input.dispatchKeyEvent. Only keys agents and the
// interactive preview realistically need; unknown single characters fall back
// to text-producing key events.
const SPECIAL_KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
};

for (let index = 1; index <= 12; index += 1) {
  SPECIAL_KEYS[`f${index}`] = { key: `F${index}`, code: `F${index}`, keyCode: 111 + index };
}

const MODIFIER_BITS = {
  alt: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const characterDefinition = (character) => {
  const upper = character.toUpperCase();
  const isLetter = /^[a-z]$/i.test(character);
  const isDigit = /^[0-9]$/.test(character);
  return {
    key: character,
    code: isLetter ? `Key${upper}` : isDigit ? `Digit${character}` : '',
    keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
    text: character,
  };
};

// Parses combos such as "Enter", "Control+A", or "Meta+Shift+ArrowLeft".
export const parseKeyCombo = (combo) => {
  if (typeof combo !== 'string' || !combo.trim()) return null;
  const parts = combo.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let modifiers = 0;
  let definition = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (Object.hasOwn(MODIFIER_BITS, lower)) {
      modifiers |= MODIFIER_BITS[lower];
      continue;
    }
    if (definition) return null;
    if (Object.hasOwn(SPECIAL_KEYS, lower)) {
      definition = SPECIAL_KEYS[lower];
    } else if (part.length === 1) {
      definition = characterDefinition(part);
    } else {
      return null;
    }
  }
  if (!definition) return null;
  // Text is suppressed for shortcuts so Control+A selects instead of typing.
  const emitsText = modifiers === 0 || modifiers === MODIFIER_BITS.shift;
  return {
    modifiers,
    key: definition.key,
    code: definition.code,
    keyCode: definition.keyCode,
    text: emitsText ? definition.text : undefined,
  };
};

export const keyEventsForCombo = (parsed) => {
  const base = {
    modifiers: parsed.modifiers,
    key: parsed.key,
    code: parsed.code,
    windowsVirtualKeyCode: parsed.keyCode,
    nativeVirtualKeyCode: parsed.keyCode,
  };
  return [
    { ...base, type: parsed.text ? 'keyDown' : 'rawKeyDown', ...(parsed.text ? { text: parsed.text } : {}) },
    { ...base, type: 'keyUp' },
  ];
};
