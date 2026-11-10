import { describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useProjectIdentityForm, type ProjectIdentitySaveData } from './useProjectIdentityForm';
import { useProjectIdentityAutoSave } from './useProjectIdentityAutoSave';
import { useProjectsStore } from '@/stores/useProjectsStore';

const project = (id: string, label: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({ id, path: `/repo/${id}`, label, ...extra });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('useProjectIdentityForm', () => {
  test('keeps the name being typed when the same project arrives as a new object, and follows the store when clean', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    type Capture = { form?: ReturnType<typeof useProjectIdentityForm> };
    const capture: Capture = {};
    const Harness = ({ entry }: { entry: ProjectEntry | null }) => {
      capture.form = useProjectIdentityForm(entry);
      return null;
    };
    const render = (entry: ProjectEntry | null) => act(async () => root.render(
      React.createElement(I18nProvider, null, React.createElement(Harness, { entry })),
    ));
    try {
      await render(project('app', 'App'));
      expect(capture.form?.name).toBe('App');

      // An untouched form follows a rename made elsewhere.
      await render(project('app', 'Application'));
      expect(capture.form?.name).toBe('Application');

      await act(async () => capture.form?.setName('Appli'));
      // A settings round trip replaces the projects array; the dialog memo
      // then yields a fresh object for the project still being edited.
      await render(project('app', 'Application'));
      expect(capture.form?.name).toBe('Appli');
      // Another window's change does not overwrite text the user changed.
      await render(project('app', 'Elsewhere'));
      expect(capture.form?.name).toBe('Appli');

      // The save lands: the store now matches the form, which becomes the
      // new baseline, so a later external change is adopted again.
      await render(project('app', 'Appli'));
      expect(capture.form?.hasChanges).toBe(false);
      await render(project('app', 'Appli v2'));
      expect(capture.form?.name).toBe('Appli v2');

      // Editing a different project seeds the form from that project.
      await render(project('lib', 'Lib'));
      expect(capture.form?.name).toBe('Lib');

      await render(null);
      expect(capture.form?.name).toBe('');
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe('useProjectIdentityAutoSave', () => {
  test('saves a change once even when the store keeps a value the form cannot match', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const saves: ProjectIdentitySaveData[] = [];
    type Capture = { form?: ReturnType<typeof useProjectIdentityForm>; setEntry?: (entry: ProjectEntry) => void };
    const capture: Capture = {};
    const Harness = () => {
      const [entry, setEntry] = React.useState(() => project('app', 'App', { defaultModel: 'openai/gpt-5.6' }));
      capture.form = useProjectIdentityForm(entry);
      capture.setEntry = setEntry;
      const onSave = React.useCallback(async (data: ProjectIdentitySaveData) => {
        saves.push(data);
        // A caller that persists the label but never the variant, as the
        // sidebar dialog did: the store echoes a project the form cannot equal.
        setEntry((current) => ({ ...current, label: data.label }));
      }, []);
      useProjectIdentityAutoSave(capture.form, onSave);
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      await act(async () => {
        capture.form?.setName('App renamed');
        capture.form?.handleDefaultVariantChange('low');
      });
      await act(async () => { await wait(700); });
      await act(async () => { await wait(700); });
      await act(async () => { await wait(700); });

      expect(saves.map((save) => [save.label, save.defaultVariant])).toEqual([['App renamed', 'low']]);
      expect(capture.form?.name).toBe('App renamed');
      expect(capture.form?.defaultVariant).toBe('low');
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe('useProjectIdentityForm icon upload validation', () => {
  test('rejects invalid icon files before they become pending', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    type Capture = { form?: ReturnType<typeof useProjectIdentityForm> };
    const capture: Capture = {};
    const Harness = ({ entry }: { entry: ProjectEntry | null }) => {
      capture.form = useProjectIdentityForm(entry);
      return null;
    };
    const render = (entry: ProjectEntry | null) => act(async () => root.render(
      React.createElement(I18nProvider, null, React.createElement(Harness, { entry })),
    ));
    try {
      await render(project('app', 'App'));

      const tooBig = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
      await act(async () => { capture.form?.handleUploadIcon(tooBig); });
      expect(capture.form?.pendingUploadIconFile).toBeNull();
      expect(capture.form?.pendingUploadIconPreviewUrl).toBeNull();

      const badType = new File(['x'], 'note.txt', { type: 'text/plain' });
      await act(async () => { capture.form?.handleUploadIcon(badType); });
      expect(capture.form?.pendingUploadIconFile).toBeNull();
      expect(capture.form?.pendingUploadIconPreviewUrl).toBeNull();

      const empty = new File([], 'empty.png', { type: 'image/png' });
      await act(async () => { capture.form?.handleUploadIcon(empty); });
      expect(capture.form?.pendingUploadIconFile).toBeNull();
      expect(capture.form?.pendingUploadIconPreviewUrl).toBeNull();

      const valid = new File(['x'], 'ok.png', { type: 'image/png' });
      await act(async () => { capture.form?.handleUploadIcon(valid); });
      expect(capture.form?.pendingUploadIconFile).toBe(valid);
      expect(capture.form?.pendingUploadIconPreviewUrl).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

describe('useProjectIdentityAutoSave unmount', () => {
  const runPendingSaveScenario = async (blocked: string, nextName: string, reopen: boolean | 'switch' | 'switch-clean' = false) => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const saves: ProjectIdentitySaveData[] = [];
    const savedProjects: string[] = [];
    let finishUpload: (result: { ok: true }) => void = () => {};
    const upload = new Promise<{ ok: true }>((resolve) => { finishUpload = resolve; });
    const originalUpload = useProjectsStore.getState().uploadProjectIcon;
    let uploadCount = 0;
    useProjectsStore.setState({ uploadProjectIcon: async () => {
      uploadCount += 1;
      return upload;
    } });
    let timer: (() => void) | undefined;
    const originalSetTimeout = globalThis.setTimeout;
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign((...parameters: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...args] = parameters;
      if (delay === 450 && typeof callback === 'function') {
        timer = () => callback(...args);
        return originalSetTimeout(() => {}, 60_000);
      }
      return originalSetTimeout(callback, delay, ...args);
    }, originalSetTimeout));
    let form: ReturnType<typeof useProjectIdentityForm> | undefined;
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const onSave = async (data: ProjectIdentitySaveData) => {
      activeSaves += 1;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      saves.push(data);
      if (blocked === 'save' && saves.length === 1) await upload;
      activeSaves -= 1;
    };
    const entry = project('app', 'App');
    const Harness = ({ selected = entry }: { selected?: ProjectEntry }) => {
      form = useProjectIdentityForm(selected);
      const save = React.useCallback(async (data: ProjectIdentitySaveData) => {
        savedProjects.push(selected.id);
        await onSave(data);
      }, [selected.id]);
      useProjectIdentityAutoSave(form, save);
      return null;
    };
    let unmounted = false;
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      await act(async () => {
        form?.setName('First name');
        if (blocked === 'upload') form?.handleUploadIcon(new File(['icon'], 'icon.png', { type: 'image/png' }));
      });
      await act(async () => timer?.());
      expect(uploadCount).toBe(blocked === 'upload' ? 1 : 0);
      await act(async () => form?.setName(nextName));
      if (reopen === 'switch' || reopen === 'switch-clean') {
        await act(async () => root.render(React.createElement(I18nProvider, null,
          React.createElement(Harness, { selected: project('lib', 'Lib') }))));
        if (reopen === 'switch') await act(async () => form?.setName('Lib renamed'));
        await act(async () => timer?.());
      } else if (reopen) {
        await act(async () => root.render(null));
        await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
        await act(async () => form?.setName('Newest name'));
        await act(async () => timer?.());
      } else {
        await act(async () => root.unmount());
        unmounted = true;
      }
      expect(saves.map((save) => save.label)).toEqual(blocked === 'upload' ? [] : ['First name']);
      await act(async () => { finishUpload({ ok: true }); await upload; });
      const expectedNames = nextName.trim() ? ['First name', nextName] : ['First name'];
      if (reopen === true) expectedNames.push('Newest name');
      if (reopen === 'switch') expectedNames.push('Lib renamed');
      expect(saves.map((save) => save.label)).toEqual(expectedNames);
      if (reopen === 'switch' || reopen === 'switch-clean') {
        expect(savedProjects).toEqual(reopen === 'switch' ? ['app', 'app', 'lib'] : ['app', 'app']);
      }
      expect(uploadCount).toBe(blocked === 'upload' ? 1 : 0);
      expect(maxActiveSaves).toBe(1);
    } finally {
      if (!unmounted) await act(async () => root.unmount());
      timeout.mockRestore();
      useProjectsStore.setState({ uploadProjectIcon: originalUpload });
      dom.restore();
    }
  };
  test('keeps the newer name after reopening while an old upload is pending', () => runPendingSaveScenario('upload', 'Before close', true));
  test('keeps the latest name when switching projects during an upload', () => runPendingSaveScenario('upload', 'Latest name', 'switch'));
  test('keeps the latest name when switching to a clean project during an upload', () => runPendingSaveScenario('upload', 'Latest name', 'switch-clean'));

  for (const { blocked, nextName } of [
    { blocked: 'upload', nextName: 'Latest name' },
    { blocked: 'save', nextName: 'Latest name' },
    { blocked: 'save', nextName: 'App' },
    { blocked: 'save', nextName: '   ' },
  ]) {
    test(`finishes ${blocked} and preserves "${nextName}" after unmount`, () => runPendingSaveScenario(blocked, nextName));
  }

  test('flushes a pending change when unmounted before the debounce fires', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const saves: ProjectIdentitySaveData[] = [];
    type Capture = { form?: ReturnType<typeof useProjectIdentityForm>; setEntry?: (entry: ProjectEntry) => void };
    const capture: Capture = {};
    const Harness = () => {
      const [entry, setEntry] = React.useState(() => project('app', 'App'));
      capture.form = useProjectIdentityForm(entry);
      capture.setEntry = setEntry;
      const onSave = React.useCallback(async (data: ProjectIdentitySaveData) => {
        saves.push(data);
        setEntry((current) => ({ ...current, label: data.label }));
      }, []);
      useProjectIdentityAutoSave(capture.form, onSave);
      return null;
    };
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Harness))));
      await act(async () => {
        capture.form?.setName('App renamed');
      });
      await act(async () => root.unmount());
      expect(saves.map((save) => save.label)).toEqual(['App renamed']);
    } finally {
      dom.restore();
    }
  });
});
