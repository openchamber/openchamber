import { describe, expect, it } from 'vitest';
import { EXT_UNCARRIABLE, buildExtUrl, transferErrorProperty, withTransferErrorDetails } from './code-transfer.js';
import { nameNotAllowedHere } from './code-out.js';

describe('transfer character boundaries', () => {
  it('keeps the ASCII control range separate from C1 controls and Unicode separators', () => {
    for (let code = 0; code <= 0xffff; code += 1) {
      expect(EXT_UNCARRIABLE.test(String.fromCharCode(code))).toBe(code <= 31 || code === 127);
    }
    expect(buildExtUrl(['git', 'space % name', '\u0085\u2028\u2029'])).toBe('ext::git space% %%% name \u0085\u2028\u2029');
  });

  it('keeps the Windows control-character acceptance rule', () => {
    for (let code = 0; code <= 159; code += 1) {
      const name = `file${String.fromCharCode(code)}name`;
      const result = nameNotAllowedHere([name], [name], { platform: 'win32' });
      const reserved = code >= 1 && code <= 31 || '<>:"\\|?*'.includes(String.fromCharCode(code));
      expect(result?.rule === 'reserved_character').toBe(reserved);
    }
  });
});

describe('transfer failure properties', () => {
  it('keeps boxed primitives and native null-property failures', () => {
    expect(transferErrorProperty('text', 'code')).toBeUndefined();
    expect(() => transferErrorProperty(null, 'code')).toThrow("Cannot read properties of null (reading 'code')");
    expect(() => transferErrorProperty(undefined, 'message')).toThrow("Cannot read properties of undefined (reading 'message')");
  });

  it('spreads error details without adopting a prototype or dropping symbol keys', () => {
    const symbol = Symbol('detail');
    const details = JSON.parse('{"__proto__":{"inherited":true},"step":"fetch"}');
    details[symbol] = 'kept';
    const extended = withTransferErrorDetails(details, { recorded: false });
    expect(Object.getPrototypeOf(extended)).toBe(Object.prototype);
    expect(Object.hasOwn(extended, '__proto__')).toBe(true);
    expect(extended[symbol]).toBe('kept');
    expect(extended).toEqual({ ...details, recorded: false });
    expect(withTransferErrorDetails('ab', { recorded: false })).toEqual({ 0: 'a', 1: 'b', recorded: false });
  });
});
