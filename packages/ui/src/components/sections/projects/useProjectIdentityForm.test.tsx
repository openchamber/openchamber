import { describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { installHookTestDom } from '@/components/session/sidebar/test-utils/testDom';
import { useProjectIdentityForm, type ProjectIdentitySaveData } from './useProjectIdentityForm';
import { useProjectIdentityAutoSave } from './useProjectIdentityAutoSave';

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
