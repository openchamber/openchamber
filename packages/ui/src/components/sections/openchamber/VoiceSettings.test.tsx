import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18nStore } from '@/lib/i18n/store';
import { dict as ukDict } from '@/lib/i18n/messages/uk';
import { buildSettingsSearchResults } from '@/lib/settings/search';

import { Select, SelectItem } from '@/components/ui/select';

import { CompatibleVoiceField } from './CompatibleVoiceField';
import { VoiceSettings } from './VoiceSettings';

describe('VoiceSettings endpoint paths', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;
  let initialConfig: ReturnType<typeof useConfigStore.getState>;
  let initialI18n: ReturnType<typeof useI18nStore.getState>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'];

  beforeEach(() => {
    windowInstance = new Window();
    initialConfig = useConfigStore.getState();
    initialI18n = useI18nStore.getState();
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      ResizeObserver: windowInstance.ResizeObserver,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useConfigStore.setState(initialConfig);
      useI18nStore.setState(initialI18n);
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const inputWithPlaceholder = (placeholder: string) => (
    Array.from(host.querySelectorAll('input')).find((element) => element.placeholder === placeholder)
  );

  test('shows the saved speech endpoint path beside the custom server fields', async () => {
    useConfigStore.setState({
      voiceProvider: 'openai-compatible',
      showMessageTTSButtons: true,
      openaiCompatibleTtsEndpointPath: '/custom/speech',
    });
    await act(async () => root.render(
      <I18nProvider>
        <VoiceSettings />
      </I18nProvider>,
    ));

    expect(inputWithPlaceholder('/audio/speech')?.value).toBe('/custom/speech');
  });

  test('shows the saved transcription endpoint path beside the custom server fields', async () => {
    useConfigStore.setState({ dictationEnabled: true, sttProvider: 'openai-compatible', sttEndpointPath: '/speech_to_text' });
    await act(async () => root.render(
      <I18nProvider>
        <VoiceSettings />
      </I18nProvider>,
    ));

    expect(inputWithPlaceholder('/audio/transcriptions')?.value).toBe('/speech_to_text');
  });

  test('localized search results target rendered endpoint inputs and disappear with their controls', async () => {
    useI18nStore.setState({ locale: 'uk', dictionary: ukDict });
    useConfigStore.setState({
      voiceProvider: 'openai-compatible', sttProvider: 'openai-compatible',
      showMessageTTSButtons: true, autoReadAloudEnabled: false, dictationEnabled: true,
    });
    const results = () => buildSettingsSearchResults({
      query: ukDict['settings.voice.page.field.endpointPath'],
      t: (key) => ukDict[key], getPageTitle: (page) => page,
      runtimeCtx: {
        isVSCode: false, isWeb: true, isDesktop: false, isMobile: false,
        isDesktopLocalOrigin: false, isMac: false, isWindows: false, isLinux: false,
        routingAvailable: false, enterpriseMode: false, jevBlockedByEnterprise: false,
      },
    });
    await act(async () => root.render(<I18nProvider><VoiceSettings /></I18nProvider>));
    expect(results().map((result) => result.id)).toEqual(['voice.tts-endpoint-path', 'voice.stt-endpoint-path']);
    for (const result of results()) {
      const target = host.querySelector(`[data-settings-item="${result.id}"]`);
      expect(target?.querySelector('input')?.getAttribute('aria-label')).toBe(result.title);
      expect(target?.textContent).toContain(result.title);
    }
    await act(async () => { useConfigStore.setState({ showMessageTTSButtons: false, dictationEnabled: false }); });
    expect(results()).toEqual([]);
    expect(host.querySelector('[data-settings-item="voice.tts-endpoint-path"]')).toBeNull();
    expect(host.querySelector('[data-settings-item="voice.stt-endpoint-path"]')).toBeNull();
  });
});

describe('VoiceSettings custom server voice list', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;
  let initialConfig: ReturnType<typeof useConfigStore.getState>;
  let voicesAnswer: () => Promise<Response>;
  let voiceRequests: number;

  const SERVER_URL = 'http://localhost:8880/v1';
  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'];

  const listed = (voices: string[]) => () => Promise.resolve(Response.json({ voices }));
  const failed = (code: string) => () => Promise.resolve(Response.json({ code }, { status: 502 }));
  const held = () => {
    let release = (_response: Response) => {};
    const answer = new Promise<Response>((resolve) => { release = resolve; });
    return { answer: () => answer, release: (response: Response) => release(response) };
  };

  beforeEach(() => {
    windowInstance = new Window();
    initialConfig = useConfigStore.getState();
    voiceRequests = 0;
    voicesAnswer = listed([]);
    globalDescriptors = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      ResizeObserver: windowInstance.ResizeObserver,
      localStorage: windowInstance.localStorage,
      sessionStorage: windowInstance.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (input: Request | string) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/api/tts/voices')) {
          voiceRequests += 1;
          return voicesAnswer();
        }
        if (url.includes('/api/voice/keys')) return Response.json({ openai: false, openaiCompatible: false, stt: false });
        return new Response('', { status: 503 });
      },
    });
    useConfigStore.setState({
      voiceProvider: 'openai-compatible',
      showMessageTTSButtons: true,
      openaiCompatibleUrl: SERVER_URL,
      openaiCompatibleVoice: 'af_sky',
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useConfigStore.setState(initialConfig);
      windowInstance.close();
      for (const [name, descriptor] of globalDescriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });

  const renderPage = () => act(async () => root.render(<I18nProvider><VoiceSettings /></I18nProvider>));
  const settle = async (done: () => boolean) => {
    for (let round = 0; round < 20 && !done(); round += 1) await act(async () => {});
  };
  const voiceTrigger = () => host.querySelector('[data-slot="select-trigger"][aria-label="Voice"]');
  const voiceInput = () => host.querySelector<HTMLInputElement>('input[placeholder="af_sky"]');

  test('offers the voices the server lists, and drops them as soon as the server address changes', async () => {
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await renderPage();
    await settle(() => voiceTrigger() !== null);

    expect(voiceTrigger()?.textContent).toBe('af_sky');
    expect(voiceInput()).toBeNull();

    await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl('http://localhost:9/v1'); });

    expect(voiceTrigger()).toBeNull();
    expect(voiceInput()?.value).toBe('af_sky');
  });

  test('keeps a saved voice the server does not list', async () => {
    useConfigStore.setState({ openaiCompatibleVoice: 'af_bella+af_sky' });
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await renderPage();
    await settle(() => voiceTrigger() !== null);

    expect(voiceTrigger()?.textContent).toBe('Custom…');
    expect(voiceInput()?.value).toBe('af_bella+af_sky');
    expect(useConfigStore.getState().openaiCompatibleVoice).toBe('af_bella+af_sky');
  });

  test('a list that arrives while the user is in the field leaves the field in place', async () => {
    const pending = held();
    voicesAnswer = pending.answer;
    await renderPage();
    const input = voiceInput();
    if (!input) throw new Error('Missing voice field');
    await act(async () => { input.focus(); });

    pending.release(Response.json({ voices: ['af_bella', 'af_sky'] }));
    await settle(() => voiceTrigger() !== null);

    expect(voiceTrigger()?.textContent).toBe('Custom…');
    expect(voiceInput()).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  test('passing through the field before the list arrives does not turn it into a custom voice', async () => {
    const pending = held();
    voicesAnswer = pending.answer;
    await renderPage();
    const input = voiceInput();
    if (!input) throw new Error('Missing voice field');
    await act(async () => { input.focus(); });
    await act(async () => { input.blur(); });

    pending.release(Response.json({ voices: ['af_bella', 'af_sky'] }));
    await settle(() => voiceTrigger() !== null);

    expect(voiceTrigger()?.textContent).toBe('af_sky');
    expect(voiceInput()).toBeNull();
  });

  test('reads the list only for an address the user has finished typing', async () => {
    voicesAnswer = listed(['af_bella', 'af_sky']);
    const Probe = ({ committedUrl }: { committedUrl: string }) => {
      CompatibleVoiceField({ committedUrl, keyRevision: 0, children: null });
      return null;
    };
    await act(async () => root.render(<I18nProvider><Probe committedUrl={SERVER_URL} /></I18nProvider>));
    await settle(() => voiceRequests === 1);

    await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl('https://tts.example.co'); });
    for (let round = 0; round < 5; round += 1) await act(async () => {});
    expect(voiceRequests).toBe(1);

    await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl('https://tts.example.com/v1'); });
    await act(async () => root.render(<I18nProvider><Probe committedUrl="https://tts.example.com/v1" /></I18nProvider>));
    await settle(() => voiceRequests === 2);
    expect(voiceRequests).toBe(2);
  });

  test('the page reads the list when the address field is left, not while it is edited', async () => {
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await renderPage();
    await settle(() => voiceTrigger() !== null);
    expect(voiceRequests).toBe(1);
    const urlField = host.querySelector<HTMLInputElement>('input[placeholder="http://localhost:8880/v1"]');
    if (!urlField) throw new Error('Missing server URL field');

    await act(async () => {
      urlField.focus();
      useConfigStore.getState().setOpenaiCompatibleUrl('http://localhost:8881/v');
    });
    for (let round = 0; round < 5; round += 1) await act(async () => {});
    expect(voiceRequests).toBe(1);
    expect(voiceTrigger()).toBeNull();

    await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl('http://localhost:8881/v1'); });
    await act(async () => { urlField.blur(); });
    await settle(() => voiceTrigger() !== null);
    expect(voiceRequests).toBe(2);

    const clear = urlField.parentElement?.querySelector('button');
    await act(async () => { clear?.click(); });
    for (let round = 0; round < 5; round += 1) await act(async () => {});
    expect(voiceRequests).toBe(2);
    expect(voiceTrigger()).toBeNull();
  });

  test('names a refused key, and Retry reads the list again', async () => {
    voicesAnswer = failed('rejected_key');
    await renderPage();
    await settle(() => host.textContent?.includes('Retry') === true);

    expect(host.textContent).toContain("The server didn't accept the request. It may need an API key, or a different one.");
    expect(voiceRequests).toBe(1);

    voicesAnswer = listed(['af_bella', 'af_sky']);
    const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Retry');
    await act(async () => {
      retry?.focus();
      retry?.click();
    });
    await settle(() => voiceTrigger() !== null);

    expect(voiceTrigger()).not.toBeNull();
    expect(document.activeElement).toBe(voiceTrigger());
    expect(voiceRequests).toBe(2);
  });

  test('a saved key reads the list again and keeps the shown answer until the new one arrives', async () => {
    voicesAnswer = failed('rejected_key');
    let view: React.ReactNode = null;
    const Probe = ({ keyRevision }: { keyRevision: number }) => {
      view = CompatibleVoiceField({ committedUrl: SERVER_URL, keyRevision, children: null });
      return null;
    };
    const shows = (text: string) => {
      const description = React.isValidElement<{ description?: React.ReactNode }>(view) ? view.props.description : null;
      return descendants(description).some((node) => node.props.children === text);
    };
    await act(async () => root.render(<I18nProvider><Probe keyRevision={0} /></I18nProvider>));
    await settle(() => shows('Retry'));
    expect(shows('Retry')).toBe(true);
    expect(voiceRequests).toBe(1);

    const pending = held();
    voicesAnswer = pending.answer;
    await act(async () => root.render(<I18nProvider><Probe keyRevision={1} /></I18nProvider>));
    expect(voiceRequests).toBe(2);
    expect(shows('Retry')).toBe(true);

    pending.release(Response.json({ voices: ['af_bella', 'af_sky'] }));
    await settle(() => descendants(view).some((node) => node.type === Select));
    expect(shows('Retry')).toBe(false);
  });

  test('an older read that answers after a newer one is dropped', async () => {
    const older = held();
    voicesAnswer = older.answer;
    let view: React.ReactNode = null;
    const Probe = ({ keyRevision }: { keyRevision: number }) => {
      view = CompatibleVoiceField({ committedUrl: SERVER_URL, keyRevision, children: null });
      return null;
    };
    await act(async () => root.render(<I18nProvider><Probe keyRevision={0} /></I18nProvider>));
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await act(async () => root.render(<I18nProvider><Probe keyRevision={1} /></I18nProvider>));
    await settle(() => descendants(view).some((node) => node.type === Select));

    older.release(Response.json({ code: 'rejected_key' }, { status: 502 }));
    for (let round = 0; round < 5; round += 1) await act(async () => {});

    expect(voiceRequests).toBe(2);
    expect(descendants(view).some((node) => node.type === Select)).toBe(true);
  });

  test('picking Custom… keeps the saved voice and opens the field', async () => {
    voicesAnswer = listed(['af_bella', 'af_sky']);
    let view: React.ReactNode = null;
    const Probe = () => {
      view = CompatibleVoiceField({ committedUrl: SERVER_URL, keyRevision: 0, children: null });
      return null;
    };
    await act(async () => root.render(<I18nProvider><Probe /></I18nProvider>));
    const select = () => descendants(view).find((node) => node.type === Select);
    await settle(() => select() !== undefined);

    const customItem = descendants(view).find((node) => node.type === SelectItem && node.props.children === 'Custom…');
    const picker = select();
    if (!React.isValidElement<{ onValueChange: (value: string) => void }>(picker)) throw new Error('Missing voice picker');
    if (!React.isValidElement<{ value: string }>(customItem)) throw new Error('Missing Custom… item');
    await act(async () => { picker.props.onValueChange(customItem.props.value); });

    expect(useConfigStore.getState().openaiCompatibleVoice).toBe('af_sky');
    expect(descendants(view).some((node) => node.type === 'input')).toBe(true);
  });
});

const descendants = (node: React.ReactNode): React.ReactElement<{ children?: React.ReactNode }>[] => {
  if (Array.isArray(node)) return node.flatMap(descendants);
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return [node, ...descendants(node.props.children)];
};
