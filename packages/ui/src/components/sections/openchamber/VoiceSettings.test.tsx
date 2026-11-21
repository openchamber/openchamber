import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18nStore } from '@/lib/i18n/store';
import { dict as ukDict } from '@/lib/i18n/messages/uk';
import { buildSettingsSearchResults } from '@/lib/settings/search';

type VoiceSettingsModule = typeof import('./VoiceSettings');
type CompatibleVoiceFieldModule = typeof import('./CompatibleVoiceField');

let VoiceSettings: VoiceSettingsModule['VoiceSettings'];
let CompatibleVoiceField: CompatibleVoiceFieldModule['CompatibleVoiceField'];

const loadComponentsAfterDom = async () => {
  ({ VoiceSettings } = await import('./VoiceSettings'));
  ({ CompatibleVoiceField } = await import('./CompatibleVoiceField'));
};

describe('VoiceSettings endpoint paths', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let globalDescriptors: Map<string, PropertyDescriptor | undefined>;
  let initialConfig: ReturnType<typeof useConfigStore.getState>;
  let initialI18n: ReturnType<typeof useI18nStore.getState>;

  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver'];

  beforeEach(async () => {
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
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      MutationObserver: windowInstance.MutationObserver,
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await loadComponentsAfterDom();
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
  let keysAnswer: () => Promise<Response>;
  let voiceRequests: number;

  const SERVER_URL = 'http://localhost:8880/v1';
  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle'];

  const listed = (voices: string[]) => () => Promise.resolve(Response.json({ voices }));
  const failed = (code: string) => () => Promise.resolve(Response.json({ code }, { status: 502 }));
  const held = () => {
    let release = (_response: Response) => {};
    const answer = new Promise<Response>((resolve) => { release = resolve; });
    return { answer: () => answer, release: (response: Response) => release(response) };
  };

  beforeEach(async () => {
    windowInstance = new Window();
    initialConfig = useConfigStore.getState();
    voiceRequests = 0;
    voicesAnswer = listed([]);
    keysAnswer = () => Promise.resolve(Response.json({ openai: false, openaiCompatible: false, stt: false }));
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
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      MutationObserver: windowInstance.MutationObserver,
      MouseEvent: windowInstance.MouseEvent,
      PointerEvent: windowInstance.PointerEvent,
      KeyboardEvent: windowInstance.KeyboardEvent,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      fetch: async (input: Request | string) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/api/tts/voices')) {
          voiceRequests += 1;
          return voicesAnswer();
        }
        if (url.includes('/api/voice/keys')) return keysAnswer();
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
    await loadComponentsAfterDom();
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
  const press = async (target: Element | null | undefined) => {
    if (!target) throw new Error('Nothing to press');
    for (const type of ['pointerover', 'pointerenter', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const init = { bubbles: true, cancelable: true, button: 0 };
      await act(async () => {
        target.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse' }) : new MouseEvent(type, init));
      });
    }
  };
  const retryButton = () => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Retry');
  const renderField = ({ committedUrl = SERVER_URL, keyRevision = 0 }: { committedUrl?: string; keyRevision?: number } = {}) => act(async () => root.render(
    <I18nProvider>
      <CompatibleVoiceField committedUrl={committedUrl} keyRevision={keyRevision}>{null}</CompatibleVoiceField>
    </I18nProvider>,
  ));

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
    await renderField();
    await settle(() => voiceRequests === 1);

    await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl('https://tts.example.co'); });
    for (let round = 0; round < 5; round += 1) await act(async () => {});
    expect(voiceRequests).toBe(1);

    await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl('https://tts.example.com/v1'); });
    await renderField({ committedUrl: 'https://tts.example.com/v1' });
    await settle(() => voiceRequests === 2);
    expect(voiceRequests).toBe(2);
    expect(voiceTrigger()).not.toBeNull();
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

  test('names a redirect or an oversized list, without a Retry that would fail again', async () => {
    for (const [code, text] of [
      ['redirected', 'The server redirected the request to another address. Enter that address instead.'],
      ['list_too_large', "The server's voice list is larger than 1 MB, so it can't be shown. Type the voice name instead."],
    ]) {
      const address = `http://localhost:8880/${code}`;
      voicesAnswer = failed(code);
      await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl(address); });
      await renderField({ committedUrl: address });
      await settle(() => host.textContent?.includes(text) === true);

      expect(host.textContent).toContain(text);
      expect(retryButton()).toBeUndefined();
      expect(voiceInput()?.value).toBe('af_sky');
    }
  });

  test('Enter in an empty API key field keeps the focus there', async () => {
    await renderPage();
    const keyField = host.querySelector<HTMLInputElement>('input[type="password"][aria-label="API key"]');
    if (!keyField) throw new Error('Missing API key field');
    await act(async () => { keyField.focus(); });
    await act(async () => {
      keyField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

    expect(document.activeElement).toBe(keyField);
  });

  test('a saved key reads the list again and keeps the shown answer until the new one arrives', async () => {
    voicesAnswer = failed('rejected_key');
    await renderField();
    await settle(() => retryButton() !== undefined);
    expect(retryButton()).toBeDefined();
    expect(voiceRequests).toBe(1);

    const pending = held();
    voicesAnswer = pending.answer;
    await renderField({ keyRevision: 1 });
    expect(voiceRequests).toBe(2);
    expect(retryButton()).toBeDefined();

    pending.release(Response.json({ voices: ['af_bella', 'af_sky'] }));
    await settle(() => voiceTrigger() !== null);
    expect(voiceTrigger()?.textContent).toBe('af_sky');
    expect(retryButton()).toBeUndefined();
  });

  test('an older read that answers after a newer one is dropped', async () => {
    const older = held();
    voicesAnswer = older.answer;
    await renderField();
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await renderField({ keyRevision: 1 });
    await settle(() => voiceTrigger() !== null);

    older.release(Response.json({ code: 'rejected_key' }, { status: 502 }));
    for (let round = 0; round < 5; round += 1) await act(async () => {});

    expect(voiceRequests).toBe(2);
    expect(voiceTrigger()).not.toBeNull();
    expect(retryButton()).toBeUndefined();
  });

  test('a key saved while the address is being edited sends nothing to the old address', async () => {
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await renderField();
    await settle(() => voiceRequests === 1);

    await act(async () => { useConfigStore.getState().setOpenaiCompatibleUrl('http://localhost:8881/v'); });
    await renderField({ keyRevision: 1 });
    for (let round = 0; round < 5; round += 1) await act(async () => {});

    expect(voiceRequests).toBe(1);
  });

  test('the first read waits until a key kept by an earlier build has moved to the server', async () => {
    const keys = held();
    keysAnswer = () => keys.answer().then((response) => response.clone());
    localStorage.setItem('openaiCompatibleApiKey', 'sk-legacy');
    const moving = useConfigStore.getState().refreshVoiceApiKeys({ force: true });
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await renderPage();
    for (let round = 0; round < 5; round += 1) await act(async () => {});
    expect(voiceRequests).toBe(0);

    keys.release(Response.json({ openai: false, openaiCompatible: true, stt: false }));
    await act(async () => { await moving; });
    await settle(() => voiceTrigger() !== null);
    expect(voiceRequests).toBe(1);
    expect(voiceTrigger()).not.toBeNull();
  });

  test('picking Custom… keeps the saved voice and opens the field', async () => {
    voicesAnswer = listed(['af_bella', 'af_sky']);
    await renderField();
    await settle(() => voiceTrigger() !== null);

    await press(voiceTrigger());
    const customItem = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'Custom…');
    await settle(() => customItem() !== undefined);
    await press(customItem());
    await settle(() => voiceInput() !== null);

    expect(useConfigStore.getState().openaiCompatibleVoice).toBe('af_sky');
    expect(voiceTrigger()?.textContent).toBe('Custom…');
    expect(voiceInput()?.value).toBe('af_sky');
  });
});
