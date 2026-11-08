import { beforeEach, describe, expect, test } from 'bun:test';

import { dropFormDraft, formDraftScope, loadFormDraft, resetFormDrafts, saveFormDraft, type FormDraftScope } from './formDrafts';

const scope = (overrides: Partial<FormDraftScope> = {}): FormDraftScope => ({
  runtimeKey: 'runtime-a',
  directory: '/repo',
  sessionID: 'ses_1',
  formID: 'frm_1',
  ...overrides,
});

const draft = {
  fieldsSignature: 'q0:string',
  values: { q0: { text: 'half filled', number: null, boolean: false, selected: [], custom: true, acknowledged: false } },
  step: 1,
};

beforeEach(() => {
  resetFormDrafts();
});

describe('form drafts', () => {
  test('a draft is restored into the exact scope it was left in', () => {
    saveFormDraft(scope(), draft);
    expect(loadFormDraft(scope())).toEqual(draft);
    // Another mount of the same request shares the answer.
    expect(loadFormDraft(scope())).toBe(loadFormDraft(scope()));
  });

  test('no other runtime, directory, session or request sees the draft', () => {
    saveFormDraft(scope(), draft);
    expect(loadFormDraft(scope({ runtimeKey: 'runtime-b' }))).toBeNull();
    expect(loadFormDraft(scope({ directory: '/other' }))).toBeNull();
    expect(loadFormDraft(scope({ sessionID: 'ses_2' }))).toBeNull();
    expect(loadFormDraft(scope({ formID: 'frm_2' }))).toBeNull();
  });

  test('dropping a draft removes it from its scope', () => {
    saveFormDraft(scope(), draft);
    expect(loadFormDraft(scope())).toEqual(draft);
    dropFormDraft(scope());
    expect(loadFormDraft(scope())).toBeNull();
  });

  test('reset clears saved drafts', () => {
    saveFormDraft(scope(), draft);
    resetFormDrafts();
    expect(loadFormDraft(scope())).toBeNull();
  });

  test('holds a bounded number of drafts', () => {
    for (let index = 0; index < 60; index += 1) {
      saveFormDraft(scope({ formID: `frm_${index}` }), draft);
    }
    expect(loadFormDraft(scope({ formID: 'frm_0' }))).toBeNull();
    expect(loadFormDraft(scope({ formID: 'frm_59' }))).toEqual(draft);
  });

  test('the scope a surface builds names this runtime and request', () => {
    const built = formDraftScope({ id: 'frm_1', sessionID: 'ses_1' }, '/repo');
    expect(built.directory).toBe('/repo');
    expect(built.sessionID).toBe('ses_1');
    expect(built.formID).toBe('frm_1');
    expect(built.runtimeKey.length).toBeGreaterThan(0);
  });
});
