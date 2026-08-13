import { describe, expect, it } from 'vitest';

import { hasScriptMismatch } from './script-guard.js';

// Fixtures are ordinary sentences, not isolated characters: the guard runs on
// real model output, and a single-character fixture would not catch a range
// typo that only shows up in mixed text.
const JA = 'このリポジトリの構成を教えてください';
const KO = '저장소 구조를 설명했습니다';
const ZH = '已说明该仓库的结构';
const EN = 'explain the repository layout';
const RU = 'Объяснил структуру репозитория';

describe('hasScriptMismatch', () => {
  it('flags a Korean output for a Japanese source', () => {
    expect(hasScriptMismatch(KO, JA)).toBe(true);
  });

  it('flags a Japanese output for a Korean source', () => {
    expect(hasScriptMismatch(JA, KO)).toBe(true);
  });

  it('flags a Chinese output for a Korean source', () => {
    expect(hasScriptMismatch(ZH, KO)).toBe(true);
  });

  it('flags a Korean output for a Chinese source', () => {
    expect(hasScriptMismatch(KO, ZH)).toBe(true);
  });

  it('flags a Korean output for an English source', () => {
    expect(hasScriptMismatch(KO, EN)).toBe(true);
  });

  it('flags a Russian output for an English source', () => {
    expect(hasScriptMismatch(RU, EN)).toBe(true);
  });

  // Han is shared by Japanese and Chinese, so a presence check cannot separate
  // them. Pinned so a later change does not "fix" this by splitting Han and
  // start dropping legitimate Japanese output whose source carried no Han.
  it('does not flag a Chinese output for a Japanese source', () => {
    expect(hasScriptMismatch(ZH, JA)).toBe(false);
  });

  it('does not flag a Japanese output for a Chinese source', () => {
    expect(hasScriptMismatch(JA, ZH)).toBe(false);
  });

  it('does not flag same-language output', () => {
    expect(hasScriptMismatch(JA, JA)).toBe(false);
    expect(hasScriptMismatch(KO, KO)).toBe(false);
    expect(hasScriptMismatch(EN, EN)).toBe(false);
  });

  // Latin is not a tracked class at all, so this passes trivially — that is the
  // point: cross-language Latin output (English versus German) is out of reach
  // for a script check and must not be mistaken for a gap in the ranges.
  it('does not flag accented Latin output', () => {
    expect(hasScriptMismatch('Struktur des Repos erklärt', EN)).toBe(false);
  });

  it('treats missing or non-string output as no mismatch', () => {
    expect(hasScriptMismatch('', JA)).toBe(false);
    expect(hasScriptMismatch(null, JA)).toBe(false);
    expect(hasScriptMismatch(undefined, JA)).toBe(false);
    expect(hasScriptMismatch(42, JA)).toBe(false);
  });

  it('treats a missing source as empty instead of throwing', () => {
    expect(hasScriptMismatch(EN, null)).toBe(false);
    expect(hasScriptMismatch(KO, undefined)).toBe(true);
  });
});
