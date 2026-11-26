import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { setTranscriptionPrompt } from '@/stores/useTranscriptionPromptStore';
import { useI18nStore } from '@/lib/i18n/store';
import { dict as ukDict } from '@/lib/i18n/messages/uk';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { buildSettingsSearchResults } from '@/lib/settings/search';

type VoiceSettingsModule = typeof import('./VoiceSettings');
type CompatibleVoiceFieldModule = typeof import('./CompatibleVoiceField');

let VoiceSettings: VoiceSettingsModule['VoiceSettings'];
let CompatibleVoiceField: CompatibleVoiceFieldModule['CompatibleVoiceField'];

let createRoot: typeof import('react-dom/client').createRoot;

const loadComponentsAfterDom = async () => {
  ({ createRoot } = await import('react-dom/client'));
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
      // The prompt textarea's overlay scrollbar measures on animation frames.
      requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
      cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
      MutationObserver: windowInstance.MutationObserver,
      fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    });
    host = document.createElement('div');
    document.body.append(host);
    await loadComponentsAfterDom();
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      useConfigStore.setState(initialConfig);
      setTranscriptionPrompt('');
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

  test('shows the saved transcription prompt only for a server provider, and search finds it there', async () => {
    const prompt = 'Español e inglés.\nTérminos: OpenChamber, Kubernetes';
    useConfigStore.setState({ dictationEnabled: true, sttProvider: 'openai-compatible' });
    setTranscriptionPrompt(prompt);
    const results = () => buildSettingsSearchResults({
      query: 'vocabulary',
      t: (key) => key, getPageTitle: (page) => page,
      runtimeCtx: {
        isVSCode: false, isWeb: true, isDesktop: false, isMobile: false,
        isDesktopLocalOrigin: false, isMac: false, isWindows: false, isLinux: false,
        routingAvailable: false, enterpriseMode: false, jevBlockedByEnterprise: false,
      },
    }).map((result) => result.id);
    await act(async () => root.render(<I18nProvider><VoiceSettings /></I18nProvider>));

    const field = host.querySelector<HTMLTextAreaElement>('[data-settings-item="voice.stt-prompt"] textarea');
    expect(field?.value).toBe(prompt);
    expect(results()).toContain('voice.stt-prompt');

    await act(async () => { useConfigStore.setState({ sttProvider: 'local' }); });
    expect(host.querySelector('[data-settings-item="voice.stt-prompt"]')).toBeNull();
    expect(results()).not.toContain('voice.stt-prompt');
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
  let sentVoiceReads: Array<{ baseURL: string; keyProvider?: string }>;
  let savedFor: Array<string | null>;
  let approvals: Array<{ baseURL: string; keyId: string; keyProvider?: string }>;
  let keyProvidersAnswer: () => Promise<Response>;
  let keyProviderReads: Array<string | null>;
  let approvalAnswer: () => Promise<Response>;
  let keyPuts: string[];
  let keySaveAnswer: () => Promise<Response>;

  const SERVER_ORIGIN = 'http://localhost:8880';
  const SERVER_URL = `${SERVER_ORIGIN}/v1`;
  const globalNames = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'ResizeObserver', 'localStorage', 'sessionStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle', 'IntersectionObserver', 'Event', 'CustomEvent', 'HTMLInputElement'];

  class FakeIntersectionObserver {
    observe() {}
    disconnect() {}
  }
  const enterRuntime = (runtimeKey: string) => switchRuntimeEndpoint({ apiBaseUrl: `http://${runtimeKey}.test`, runtimeKey });

  const listed = (voices: string[]) => () => Promise.resolve(Response.json({ voices }));
  const failed = (code: string, keyId?: string) => () => Promise.resolve(Response.json({ code, keyId }, { status: 502 }));
  const keySaved = (keyId: string) => () => Promise.resolve(Response.json({ openai: false, openaiCompatible: true, stt: false, openaiCompatibleKeyId: keyId }));
  const held = () => {
    let release = (_response: Response) => {};
    const answer = new Promise<Response>((resolve) => { release = resolve; });
    return { answer: () => answer, release: (response: Response) => release(response) };
  };

  beforeEach(async () => {
    windowInstance = new Window();
    initialConfig = useConfigStore.getState();
    voiceRequests = 0;
    sentVoiceReads = [];
    keyPuts = [];
    keySaveAnswer = () => Promise.resolve(Response.json({ openai: false, openaiCompatible: true, stt: false }));
    savedFor = [];
    approvals = [];
    keyProviderReads = [];
    keyProvidersAnswer = () => Promise.resolve(Response.json({ providers: [] }));
    approvalAnswer = () => Promise.resolve(Response.json({ approval: 'added' }));
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
      IntersectionObserver: FakeIntersectionObserver,
      Event: windowInstance.Event,
      CustomEvent: windowInstance.CustomEvent,
      HTMLInputElement: windowInstance.HTMLInputElement,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      fetch: async (input: Request | string, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.includes('/api/voice/key-providers')) {
          keyProviderReads.push(new URL(url, 'http://localhost').searchParams.get('baseURL'));
          return keyProvidersAnswer();
        }
        if (url.includes('/api/tts/voices/approval')) {
          approvals.push(JSON.parse(String(init?.body)));
          return approvalAnswer();
        }
        if (url.includes('/api/tts/voices')) {
          voiceRequests += 1;
          sentVoiceReads.push(JSON.parse(String(init?.body)));
          return voicesAnswer();
        }
        if (url.includes('/api/voice/keys') && init?.method === 'PUT') {
          keyPuts.push(String(init.body));
          savedFor.push(new URL(url, 'http://localhost').searchParams.get('speechServer'));
          return keySaveAnswer();
        }
        if (url.includes('/api/voice/keys')) return keysAnswer();
        return new Response('', { status: 503 });
      },
    });
    enterRuntime('runtime-a');
    useConfigStore.setState({
      voiceProvider: 'openai-compatible',
      showMessageTTSButtons: true,
      openaiCompatibleUrl: SERVER_URL,
      openaiCompatibleVoice: 'af_sky',
    });
    host = document.createElement('div');
    document.body.append(host);
    await loadComponentsAfterDom();
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
      ['redirected', 'The server redirected the request to another address. Check the server URL, or type the voice name.'],
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
    keySaveAnswer = keysAnswer;
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

  test('a listed voice named like the Custom… item is picked, in a short list and a long one', async () => {
    for (const [address, extra] of [[SERVER_URL, 0], ['http://localhost:8881/v1', 100]] as const) {
      voicesAnswer = listed(['custom', '$custom', 'af_sky', ...Array.from({ length: extra }, (_, index) => `voice_${index}`)]);
      useConfigStore.setState({ openaiCompatibleUrl: address, openaiCompatibleVoice: 'af_sky' });
      await renderField({ committedUrl: address });
      const trigger = () => host.querySelector('button[aria-label="Voice"], [data-slot="select-trigger"][aria-label="Voice"]');
      const option = (text: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === text);
      const choose = async (text: string) => {
        await settle(() => trigger() !== null);
        await press(trigger());
        await settle(() => option(text) !== undefined);
        await press(option(text));
        await settle(() => option(text) === undefined);
      };
      for (const id of ['custom', '$custom']) {
        await choose(id);
        expect(useConfigStore.getState().openaiCompatibleVoice).toBe(id);
        expect(trigger()?.textContent).toBe(id);
        expect(voiceInput()).toBeNull();
      }
      await choose('Custom…');
      expect(voiceInput()?.value).toBe('$custom');
    }
  });

  const rounds = async () => {
    for (let round = 0; round < 8; round += 1) await act(async () => {});
  };
  const typeInto = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(windowInstance.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const pressEnter = (input: HTMLInputElement) => act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  const keyField = () => {
    const field = host.querySelector<HTMLInputElement>('input[type="password"][aria-label="API key"]');
    if (!field) throw new Error('Missing API key field');
    return field;
  };
  const urlField = () => {
    const field = host.querySelector<HTMLInputElement>('input[placeholder="http://localhost:8880/v1"]');
    if (!field) throw new Error('Missing server URL field');
    return field;
  };
  const enterAddress = async (address: string) => {
    await typeInto(urlField(), address);
    await act(async () => { urlField().blur(); });
    await rounds();
  };
  const saveKey = async () => {
    await typeInto(keyField(), 'sk-new');
    await pressEnter(keyField());
    await rounds();
  };
  const buttonNamed = (text: string) => Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text);
  const reload = async () => {
    await act(async () => root.unmount());
    root = createRoot(host);
    await renderPage();
    await rounds();
  };

  test('a typed key and Enter save it once', async () => {
    await renderPage();
    await saveKey();

    expect(keyPuts).toEqual(['{"openaiCompatible":"sk-new"}']);
    expect(keyField().value).toBe('');
  });

  test('a failed save keeps the typed key, and Enter sends it once more', async () => {
    keySaveAnswer = () => Promise.resolve(new Response('', { status: 500 }));
    await renderPage();
    await saveKey();
    expect(keyPuts).toHaveLength(1);
    expect(keyField().value).toBe('sk-new');

    await act(async () => { keyField().focus(); });
    await pressEnter(keyField());
    await rounds();
    expect(keyPuts).toHaveLength(2);
    expect(keyField().value).toBe('sk-new');
    expect(approvals).toEqual([]);
  });

  test('saving a key names the server it is for, and nothing the page reads by itself approves one', async () => {
    keysAnswer = keySaved('key-a');
    keySaveAnswer = keySaved('key-a');
    await renderPage();
    await saveKey();
    expect(savedFor).toEqual(['http://localhost:8880']);

    await enterAddress('https://other.example/v1');
    await typeInto(urlField(), 'https://tts.example.co');
    await reload();
    await act(async () => { enterRuntime('runtime-b'); });
    await rounds();

    expect(sentVoiceReads.map((read) => read.baseURL)).toContain('https://tts.example.co');
    expect(sentVoiceReads.every((read) => Object.keys(read).join() === 'baseURL')).toBe(true);
    expect(approvals).toEqual([]);
  });

  test('voice key lookups and saves send only the origin, or nothing for an invalid address', async () => {
    useConfigStore.setState({ openaiCompatibleUrl: 'http://fake-user:fake-password@localhost:8880/v1?token=fake-token#fragment' });
    await renderPage();
    await saveKey();
    await enterAddress('not an address');
    await saveKey();
    expect(savedFor).toEqual(['http://localhost:8880', null]);
    expect(keyProviderReads).toEqual(['http://localhost:8880', null]);

    await enterAddress('blob:https://voice.test/fake-id');
    expect(keyProviderReads).toEqual(['http://localhost:8880', null, null]);
  });

  test('a key kept by an earlier build moves to the server without approving any address', async () => {
    localStorage.setItem('openaiCompatibleApiKey', 'sk-legacy');
    await renderPage();
    await rounds();
    expect(keyPuts).toEqual(['{"openaiCompatible":"sk-legacy"}']);
    expect(savedFor).toEqual([null]);
    expect(approvals).toEqual([]);
  });

  test('removing the key reads the list again and approves nothing', async () => {
    keysAnswer = keySaved('key-a');
    await renderPage();
    await rounds();
    const before = voiceRequests;
    const remove = keyField().parentElement?.querySelector('button');
    if (!remove) throw new Error('Missing remove button');
    await act(async () => { remove.click(); });
    await rounds();
    expect(keyPuts).toEqual(['{"openaiCompatible":null}']);
    expect(voiceRequests).toBe(before + 1);
    expect(approvals).toEqual([]);
  });

  test('a withheld key is named as such, and the action beside it approves the server before reading again', async () => {
    voicesAnswer = failed('key_not_sent', 'key-a');
    await renderPage();
    await settle(() => buttonNamed('Send saved key') !== undefined);
    expect(host.textContent).toContain("The saved key hasn't been sent to this server yet.");
    expect(host.textContent).not.toContain('a different one');
    expect(approvals).toEqual([]);

    voicesAnswer = listed(['af_bella', 'af_sky']);
    const pending = held();
    approvalAnswer = pending.answer;
    await act(async () => { buttonNamed('Send saved key')?.click(); });
    await rounds();
    expect(approvals).toEqual([{ baseURL: SERVER_URL, keyId: 'key-a' }]);
    expect(voiceRequests).toBe(1);

    pending.release(Response.json({ approval: 'added' }));
    await settle(() => voiceTrigger() !== null);
    expect(voiceRequests).toBe(2);
    await reload();
    expect(approvals).toHaveLength(1);
  });

  test('Retry approves with the key the last read named, so a key saved elsewhere since needs its own approval', async () => {
    keysAnswer = keySaved('key-a');
    voicesAnswer = failed('unreachable', 'key-a');
    await renderPage();
    await settle(() => retryButton() !== undefined);

    voicesAnswer = failed('key_not_sent', 'key-b');
    approvalAnswer = () => Promise.resolve(Response.json({ approval: 'refused' }));
    await act(async () => { retryButton()?.click(); });
    await settle(() => buttonNamed('Send saved key') !== undefined);
    await act(async () => { buttonNamed('Send saved key')?.click(); });
    await rounds();
    expect(approvals.map((approval) => approval.keyId)).toEqual(['key-a', 'key-b']);
  });

  test('Retry reads again when the approval cannot be stored', async () => {
    voicesAnswer = failed('unreachable', 'key-a');
    approvalAnswer = () => Promise.reject(new Error('offline'));
    await renderPage();
    await settle(() => retryButton() !== undefined);
    await act(async () => { retryButton()?.click(); });
    await rounds();
    expect(voiceRequests).toBe(2);
  });

  test('Preview approves the address without waiting for the list, and reads it again only when that changed something', async () => {
    keysAnswer = keySaved('key-a');
    voicesAnswer = held().answer;
    await renderPage();
    await rounds();
    expect(voiceRequests).toBe(1);

    voicesAnswer = listed(['af_sky']);
    const preview = () => host.querySelector<HTMLButtonElement>('button[aria-label="Preview"]');
    await act(async () => { preview()?.click(); });
    await rounds();
    expect(approvals).toEqual([{ baseURL: SERVER_URL, keyId: 'key-a' }]);
    expect(voiceRequests).toBe(2);

    approvalAnswer = () => Promise.resolve(Response.json({ approval: 'kept' }));
    await act(async () => { preview()?.click(); });
    await rounds();
    expect(approvals).toHaveLength(2);
    expect(voiceRequests).toBe(2);
  });

  test('a thousand voices open with the first fifty rows, and search finds one to pick', async () => {
    voicesAnswer = listed(Array.from({ length: 1000 }, (_, index) => `voice_${String(index).padStart(4, '0')}`));
    await renderField();
    const trigger = () => host.querySelector<HTMLElement>('button[aria-label="Voice"]');
    await settle(() => trigger() !== null);
    expect(trigger()?.textContent).toBe('Custom…');

    await press(trigger());
    const search = () => document.querySelector<HTMLInputElement>('input[data-slot="command-input"]');
    await settle(() => search() !== null);
    const items = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'));
    expect(items()).toHaveLength(51);
    expect(items().at(-1)?.textContent).toBe('Custom…');

    const field = search();
    if (!field) throw new Error('Missing voice search');
    await typeInto(field, 'VOICE_0987');
    expect(items().map((item) => item.textContent)).toEqual(['voice_0987', 'Custom…']);
    await pressEnter(field);
    await rounds();

    expect(useConfigStore.getState().openaiCompatibleVoice).toBe('voice_0987');
    expect(trigger()?.textContent).toBe('voice_0987');
    expect(search()).toBeNull();
  });

  const GATEWAY = { id: 'gateway', name: 'Gateway', keyId: 'key-gateway', matches: false, approved: false };
  const OTHER = { id: 'other', name: 'Other', keyId: 'key-other', matches: false, approved: false };
  const providersAre = (...providers: Array<typeof GATEWAY>) => {
    keyProvidersAnswer = () => Promise.resolve(Response.json({ providers }));
  };
  const keyTrigger = () => host.querySelector('[data-slot="select-trigger"][aria-label="OpenCode provider key"]');
  const pick = async (name: string) => {
    await press(keyTrigger());
    const option = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((item) => item.textContent === name);
    await settle(() => option() !== undefined);
    await press(option());
    await settle(() => option() === undefined);
  };
  const openPage = async () => {
    await renderPage();
    await rounds();
  };

  test('shows no Key choice while no OpenCode provider has a key', async () => {
    await openPage();

    expect(keyProviderReads).toEqual([SERVER_ORIGIN]);
    expect(keyTrigger()).toBeNull();
  });

  test('preselects the provider whose address matches the server, and sends its key only after the user taps Send key', async () => {
    providersAre({ ...GATEWAY, matches: true }, OTHER);
    await openPage();

    expect(keyTrigger()?.textContent).toBe('Gateway');
    expect(host.textContent).toContain("Gateway's key goes to http://localhost:8880 only after you approve it.");
    expect(host.textContent).not.toContain('Selected because');
    expect(buttonNamed('Send key')).toBeDefined();
    expect(approvals).toEqual([]);
    expect(useConfigStore.getState().openaiCompatibleKeyProvider).toBeUndefined();
    expect(sentVoiceReads.every((read) => !('keyProvider' in read))).toBe(true);

    providersAre({ ...GATEWAY, matches: true, approved: true }, OTHER);
    await act(async () => { buttonNamed('Send key')?.click(); });
    await rounds();

    expect(approvals).toEqual([{ baseURL: SERVER_URL, keyId: 'key-gateway', keyProvider: 'gateway' }]);
    expect(keyTrigger()?.textContent).toBe('Gateway');
    expect(host.textContent).toContain('Selected because this provider has the same server address.');
    expect(buttonNamed('Send key')).toBeUndefined();
    expect(useConfigStore.getState().openaiCompatibleKeyProvider).toBeUndefined();
  });

  test('selects nothing when two providers have the server address, or none does', async () => {
    providersAre({ ...GATEWAY, matches: true }, { ...OTHER, matches: true });
    await openPage();
    expect(keyTrigger()?.textContent).toBe('None');
    expect(host.textContent).not.toContain('Selected because');

    providersAre(GATEWAY, OTHER);
    await enterAddress('http://localhost:9/v1');
    expect(keyProviderReads.at(-1)).toBe('http://localhost:9');
    expect(keyTrigger()?.textContent).toBe('None');
  });

  test('stops selecting a provider while the address is being edited, and reads again for the finished one', async () => {
    providersAre({ ...GATEWAY, matches: true }, OTHER);
    await openPage();
    expect(keyTrigger()?.textContent).toBe('Gateway');

    await typeInto(urlField(), 'http://localhost:88');
    await rounds();
    expect(keyTrigger()?.textContent).toBe('None');
    expect(keyProviderReads).toEqual([SERVER_ORIGIN]);

    await act(async () => { urlField().blur(); });
    await rounds();
    expect(keyProviderReads).toEqual([SERVER_ORIGIN, 'http://localhost:88']);
  });

  test('a choice made by hand replaces the automatic one, is saved, and goes with the voice list read', async () => {
    providersAre({ ...GATEWAY, matches: true }, OTHER);
    await openPage();

    await pick('Other');

    expect(keyTrigger()?.textContent).toBe('Other');
    expect(useConfigStore.getState().openaiCompatibleKeyProvider).toBe('other');
    await settle(() => sentVoiceReads.at(-1)?.keyProvider === 'other');
    expect(sentVoiceReads.at(-1)).toEqual({ baseURL: SERVER_URL, keyProvider: 'other' });
  });

  test('None is a choice of its own: it is saved and stops the automatic selection', async () => {
    providersAre({ ...GATEWAY, matches: true }, OTHER);
    await openPage();

    await pick('None');
    await rounds();

    expect(useConfigStore.getState().openaiCompatibleKeyProvider).toBe('');
    expect(keyTrigger()?.textContent).toBe('None');
    expect(host.textContent).not.toContain('Selected because');
    await settle(() => sentVoiceReads.at(-1)?.keyProvider === '');
    expect(sentVoiceReads.at(-1)).toEqual({ baseURL: SERVER_URL, keyProvider: '' });
  });

  test('a provider with another address asks once: the key waits for the user, and the action approves that server', async () => {
    providersAre(GATEWAY, { ...OTHER, approved: false });
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'other' });
    await openPage();

    expect(keyTrigger()?.textContent).toBe('Other');
    expect(host.textContent).toContain("Other's key goes to http://localhost:8880 only after you approve it.");
    expect(approvals).toEqual([]);

    providersAre(GATEWAY, { ...OTHER, approved: true });
    const readsBefore = voiceRequests;
    await act(async () => { buttonNamed('Send key')?.click(); });
    await rounds();

    expect(approvals).toEqual([{ baseURL: SERVER_URL, keyId: 'key-other', keyProvider: 'other' }]);
    expect(buttonNamed('Send key')).toBeUndefined();
    expect(host.textContent).not.toContain('only after you approve it');
    expect(voiceRequests).toBeGreaterThan(readsBefore);
  });

  test('a provider already approved for the server is not asked about again, and one with its address that is not approved is', async () => {
    providersAre({ ...GATEWAY, approved: true }, { ...OTHER, matches: true });
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'gateway' });
    await openPage();
    expect(keyTrigger()?.textContent).toBe('Gateway');
    expect(buttonNamed('Send key')).toBeUndefined();

    await pick('Other');
    expect(buttonNamed('Send key')).toBeDefined();
    expect(host.textContent).toContain("Other's key goes to http://localhost:8880 only after you approve it.");
  });

  test('a typed key comes first: the choice is off and the line says so', async () => {
    providersAre({ ...GATEWAY, matches: true }, OTHER);
    useConfigStore.setState({ voiceApiKeys: { openai: false, openaiCompatible: true, stt: false }, openaiCompatibleKeyProvider: 'other' });
    keysAnswer = () => Promise.resolve(Response.json({ openai: false, openaiCompatible: true, stt: false }));
    await openPage();

    expect(keyTrigger()?.textContent).toBe('None');
    await press(keyTrigger());
    await rounds();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(useConfigStore.getState().openaiCompatibleKeyProvider).toBe('other');
    expect(host.textContent).toContain('The key typed above is used instead.');
    expect(host.textContent).not.toContain('Selected because');
  });

  test('the transcription server has its own choice, selected by its own address and saved apart', async () => {
    useConfigStore.setState({ voiceProvider: 'browser', dictationEnabled: true, sttProvider: 'openai-compatible', sttServerUrl: 'http://localhost:8001/v1' });
    providersAre({ ...GATEWAY, matches: true }, OTHER);
    await openPage();

    expect(keyProviderReads).toEqual(['http://localhost:8001']);
    expect(keyTrigger()?.textContent).toBe('Gateway');
    await pick('Other');
    expect(useConfigStore.getState().sttKeyProvider).toBe('other');
    expect(useConfigStore.getState().openaiCompatibleKeyProvider).toBeUndefined();
  });

  describe('when the transcription address changes while the page is open', () => {
    const OLD_URL = 'http://localhost:8001/v1';
    const NEW_URL = 'http://localhost:8002/v1';
    const sttField = () => {
      const field = host.querySelector<HTMLInputElement>(`input[placeholder="${OLD_URL}"]`);
      if (!field) throw new Error('Missing transcription URL field');
      return field;
    };

    beforeEach(async () => {
      useConfigStore.setState({ voiceProvider: 'browser', dictationEnabled: true, sttProvider: 'openai-compatible', sttServerUrl: OLD_URL });
      providersAre({ ...GATEWAY, matches: true }, OTHER);
      await openPage();
      expect(keyProviderReads).toEqual(['http://localhost:8001']);
    });

    // Settings sync from the server after the page mounted from the browser's copy, so the address can change under a field nobody is editing.
    test('a change from outside the field is the address the Key choice is for', async () => {
      await act(async () => { useConfigStore.setState({ sttServerUrl: NEW_URL }); });
      await rounds();

      expect(keyProviderReads).toEqual(['http://localhost:8001', 'http://localhost:8002']);
      expect(keyTrigger()?.textContent).toBe('Gateway');
      expect(host.textContent).toContain("Gateway's key goes to http://localhost:8002 only after you approve it.");
      expect(buttonNamed('Send key')).toBeDefined();

      await act(async () => { buttonNamed('Send key')?.click(); });
      await rounds();
      expect(approvals).toEqual([{ baseURL: NEW_URL, keyId: 'key-gateway', keyProvider: 'gateway' }]);
    });

    test('a late answer for the address chosen before does not replace the failure line of the address chosen now', async () => {
      const inFlight = held();
      approvalAnswer = inFlight.answer;
      await act(async () => { buttonNamed('Send key')?.click(); });
      await act(async () => { useConfigStore.setState({ sttServerUrl: NEW_URL }); });
      await rounds();
      approvalAnswer = () => Promise.resolve(Response.json({ error: 'boom' }, { status: 500 }));
      await act(async () => { buttonNamed('Send key')?.click(); });
      await rounds();
      expect(approvals.map((approval) => approval.baseURL)).toEqual([OLD_URL, NEW_URL]);
      expect(host.textContent).toContain('The approval could not be saved. Try again.');

      await act(async () => { inFlight.release(Response.json({ approval: 'added' })); });
      await rounds();

      expect(host.textContent).toContain('The approval could not be saved. Try again.');
      expect(buttonNamed('Send key')).toBeDefined();
    });

    test('an address being typed is read only once the field is left', async () => {
      await typeInto(sttField(), 'http://localhost:80');
      await rounds();
      expect(keyProviderReads).toEqual(['http://localhost:8001']);
      expect(buttonNamed('Send key')).toBeUndefined();

      await act(async () => { sttField().blur(); });
      await rounds();
      expect(keyProviderReads).toEqual(['http://localhost:8001', 'http://localhost']);
    });
  });

  test('Retry after a failed list reads the list again and never approves a provider', async () => {
    providersAre(GATEWAY, OTHER);
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'other' });
    voicesAnswer = failed('rejected_key', 'key-other');
    await openPage();
    await settle(() => retryButton() !== undefined);
    const readsBefore = voiceRequests;

    await act(async () => { retryButton()?.click(); });
    await rounds();

    expect(voiceRequests).toBeGreaterThan(readsBefore);
    expect(approvals.filter((approval) => approval.keyProvider !== undefined)).toEqual([]);
    expect(host.textContent).toContain("Other's key goes to http://localhost:8880 only after you approve it.");
    expect(sentVoiceReads.at(-1)).toEqual({ baseURL: SERVER_URL, keyProvider: 'other' });
  });

  test('a refused approval reads the providers again, says the key changed, and approves the new key on the next action', async () => {
    providersAre(GATEWAY, OTHER);
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'other' });
    await openPage();
    approvalAnswer = () => Promise.resolve(Response.json({ approval: 'refused' }));
    providersAre(GATEWAY, { ...OTHER, keyId: 'key-other-2' });
    const readsBefore = keyProviderReads.length;

    await act(async () => { buttonNamed('Send key')?.click(); });
    await rounds();

    expect(approvals).toEqual([{ baseURL: SERVER_URL, keyId: 'key-other', keyProvider: 'other' }]);
    expect(keyProviderReads).toHaveLength(readsBefore + 1);
    expect(host.textContent).toContain('The key of Other changed. It goes to http://localhost:8880 only after you approve the new key.');

    approvalAnswer = () => Promise.resolve(Response.json({ approval: 'added' }));
    providersAre(GATEWAY, { ...OTHER, keyId: 'key-other-2', approved: true });
    await act(async () => { buttonNamed('Send key')?.click(); });
    await rounds();

    expect(approvals.at(-1)).toEqual({ baseURL: SERVER_URL, keyId: 'key-other-2', keyProvider: 'other' });
    expect(host.textContent).not.toContain('changed');
    expect(buttonNamed('Send key')).toBeUndefined();
  });

  const unsavedApprovals: Array<[string, () => Promise<Response>]> = [
    ['the request cannot be made', () => Promise.reject(new Error('offline'))],
    ['the answer is not JSON', () => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))],
    ['the server answers 500', () => Promise.resolve(Response.json({ error: 'boom' }, { status: 500 }))],
  ];
  for (const [cause, answer] of unsavedApprovals) test(`says the approval could not be saved when ${cause}, and the next tap tries again`, async () => {
    providersAre(GATEWAY, OTHER);
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'other' });
    await openPage();
    approvalAnswer = answer;

    await act(async () => { buttonNamed('Send key')?.click(); });
    await rounds();

    expect(host.textContent).toContain('The approval could not be saved. Try again.');
    expect(host.textContent).not.toContain('changed');
    expect(buttonNamed('Send key')).toBeDefined();

    approvalAnswer = () => Promise.resolve(Response.json({ approval: 'added' }));
    providersAre(GATEWAY, { ...OTHER, approved: true });
    await act(async () => { buttonNamed('Send key')?.click(); });
    await rounds();

    expect(approvals).toHaveLength(2);
    expect(host.textContent).not.toContain('could not be saved');
    expect(buttonNamed('Send key')).toBeUndefined();
  });

  // An approval still in flight for one provider answers after the user moved on: its answer belongs to the provider it was sent for.
  const approvalResults = {
    added: () => Response.json({ approval: 'added' }),
    refused: () => Response.json({ approval: 'refused' }),
    failed: () => Response.json({ error: 'boom' }, { status: 500 }),
  };
  const currentLines = {
    failed: 'The approval could not be saved. Try again.',
    refused: 'The key of Gateway changed. It goes to http://localhost:8880 only after you approve the new key.',
  };
  for (const late of ['added', 'refused', 'failed'] as const) {
    for (const current of ['failed', 'refused'] as const) {
      test(`a late '${late}' for the provider chosen before does not replace the '${current}' line of the provider chosen now`, async () => {
        providersAre(GATEWAY, OTHER);
        useConfigStore.setState({ openaiCompatibleKeyProvider: 'other' });
        await openPage();
        const inFlight = held();
        approvalAnswer = inFlight.answer;
        await act(async () => { buttonNamed('Send key')?.click(); });
        await pick('Gateway');
        approvalAnswer = () => Promise.resolve(approvalResults[current]());
        await act(async () => { buttonNamed('Send key')?.click(); });
        await rounds();
        expect(approvals.map((approval) => approval.keyProvider)).toEqual(['other', 'gateway']);
        expect(host.textContent).toContain(currentLines[current]);

        await act(async () => { inFlight.release(approvalResults[late]()); });
        await rounds();

        expect(host.textContent).toContain(currentLines[current]);
        expect(buttonNamed('Send key')).toBeDefined();
      });
    }
  }

  test('Retry reads the providers again, so a key that changed while the page stayed open can be approved again', async () => {
    providersAre(GATEWAY, { ...OTHER, approved: true });
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'other' });
    voicesAnswer = failed('rejected_key');
    await openPage();
    await settle(() => retryButton() !== undefined);
    expect(buttonNamed('Send key')).toBeUndefined();
    const readsBefore = keyProviderReads.length;

    providersAre(GATEWAY, { ...OTHER, keyId: 'key-other-2', approved: false });
    await act(async () => { retryButton()?.click(); });
    await rounds();

    expect(keyProviderReads).toHaveLength(readsBefore + 1);
    expect(host.textContent).toContain("Other's key goes to http://localhost:8880 only after you approve it.");
    expect(approvals.filter((approval) => approval.keyProvider !== undefined)).toEqual([]);

    providersAre(GATEWAY, { ...OTHER, keyId: 'key-other-2', approved: true });
    await act(async () => { buttonNamed('Send key')?.click(); });
    await rounds();

    expect(approvals.at(-1)).toEqual({ baseURL: SERVER_URL, keyId: 'key-other-2', keyProvider: 'other' });
    expect(buttonNamed('Send key')).toBeUndefined();
  });

  describe('with read-aloud and dictation both on a custom server', () => {
    const DICTATION_URL = 'http://localhost:8880/transcribe/v1';
    const ELSEWHERE_URL = 'http://localhost:8001/v1';
    let grantedOrigins: Set<string>;

    // Grants are per origin, as on the server: the mocks answer from this set, not from one flag for every address.
    const originOf = (address: string | null | undefined) => new URL(address ?? 'http://nothing.test').origin;
    const sendKeyButtons = () => Array.from(host.querySelectorAll('button')).filter((button) => button.textContent === 'Send key');

    beforeEach(() => {
      grantedOrigins = new Set();
      keyProvidersAnswer = () => Promise.resolve(Response.json({
        providers: [{ ...GATEWAY, matches: true, approved: grantedOrigins.has(originOf(keyProviderReads.at(-1))) }],
      }));
      approvalAnswer = () => {
        grantedOrigins.add(originOf(approvals.at(-1)?.baseURL));
        return Promise.resolve(Response.json({ approval: 'added' }));
      };
      voicesAnswer = () => (grantedOrigins.has(originOf(sentVoiceReads.at(-1)?.baseURL)) ? listed(['af_bella', 'af_sky']) : failed('rejected_key'))();
    });

    const bothOnTheSameServer = async () => {
      useConfigStore.setState({ dictationEnabled: true, sttProvider: 'openai-compatible', sttServerUrl: DICTATION_URL });
      await openPage();
      await settle(() => retryButton() !== undefined);
      expect(sendKeyButtons()).toHaveLength(2);
    };

    test('approving from Dictation clears the prompt of read-aloud and loads its voice list without Retry', async () => {
      await bothOnTheSameServer();

      await act(async () => { sendKeyButtons()[0]?.click(); });
      await settle(() => voiceTrigger() !== null);

      expect(approvals).toEqual([{ baseURL: DICTATION_URL, keyId: 'key-gateway', keyProvider: 'gateway' }]);
      expect(sendKeyButtons()).toHaveLength(0);
      expect(retryButton()).toBeUndefined();
      expect(voiceTrigger()?.textContent).toBe('af_sky');
    });

    test('approving from read-aloud clears the prompt of Dictation too', async () => {
      await bothOnTheSameServer();

      await act(async () => { sendKeyButtons()[1]?.click(); });
      await settle(() => voiceTrigger() !== null);

      expect(approvals).toEqual([{ baseURL: SERVER_URL, keyId: 'key-gateway', keyProvider: 'gateway' }]);
      expect(sendKeyButtons()).toHaveLength(0);
      expect(voiceTrigger()?.textContent).toBe('af_sky');
    });

    for (const approval of ['refused', 'added'] as const) {
      test(`the working read-aloud voice list is not read again when Dictation is on another server and its approval is ${approval}`, async () => {
        useConfigStore.setState({ dictationEnabled: true, sttProvider: 'openai-compatible', sttServerUrl: ELSEWHERE_URL, openaiCompatibleKeyProvider: '' });
        grantedOrigins.add(originOf(SERVER_URL));
        await openPage();
        await settle(() => voiceTrigger() !== null);
        expect(voiceTrigger()?.textContent).toBe('af_sky');
        expect(sendKeyButtons()).toHaveLength(1);
        if (approval === 'refused') approvalAnswer = () => Promise.resolve(Response.json({ approval: 'refused' }));
        const readsBefore = voiceRequests;
        const providerReadsBefore = keyProviderReads.length;

        await act(async () => { sendKeyButtons()[0]?.click(); });
        await rounds();

        expect(approvals).toEqual([{ baseURL: ELSEWHERE_URL, keyId: 'key-gateway', keyProvider: 'gateway' }]);
        expect(keyProviderReads.length).toBeGreaterThan(providerReadsBefore);
        expect(voiceRequests).toBe(readsBefore);
        expect(retryButton()).toBeUndefined();
        expect(voiceTrigger()?.textContent).toBe('af_sky');
      });
    }
  });

  test('a refusal that arrives after the user picked another provider is not blamed on that provider', async () => {
    providersAre(GATEWAY, OTHER);
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'other' });
    await openPage();
    const pending = held();
    approvalAnswer = pending.answer;
    await act(async () => { buttonNamed('Send key')?.click(); });
    await pick('Gateway');
    expect(host.textContent).toContain("Gateway's key goes to http://localhost:8880 only after you approve it.");

    pending.release(Response.json({ approval: 'refused' }));
    await rounds();

    expect(approvals).toEqual([{ baseURL: SERVER_URL, keyId: 'key-other', keyProvider: 'other' }]);
    expect(keyTrigger()?.textContent).toBe('Gateway');
    expect(host.textContent).toContain("Gateway's key goes to http://localhost:8880 only after you approve it.");
    expect(host.textContent).not.toContain('changed');
  });

  test('a provider list that cannot be read shows an error and Retry, not an empty list', async () => {
    keyProvidersAnswer = () => Promise.resolve(new Response('', { status: 503 }));
    await openPage();

    expect(keyTrigger()).not.toBeNull();
    expect(host.textContent).toContain('The OpenCode providers could not be read.');

    keyProvidersAnswer = () => Promise.reject(new Error('offline'));
    await act(async () => { buttonNamed('Retry')?.click(); });
    await rounds();
    expect(host.textContent).toContain('The OpenCode providers could not be read.');

    providersAre({ ...GATEWAY, matches: true });
    await act(async () => { buttonNamed('Retry')?.click(); });
    await rounds();
    expect(host.textContent).not.toContain('could not be read');
    expect(keyTrigger()?.textContent).toBe('Gateway');
  });

  test('None can still be saved while the provider list cannot be read', async () => {
    keyProvidersAnswer = () => Promise.resolve(new Response('', { status: 503 }));
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'gateway' });
    await openPage();

    expect(host.textContent).toContain('The OpenCode providers could not be read.');
    await pick('None');
    await rounds();

    expect(useConfigStore.getState().openaiCompatibleKeyProvider).toBe('');
    expect(keyTrigger()?.textContent).toBe('None');
    expect(buttonNamed('Retry')).toBeDefined();
  });

  test('a chosen provider that is gone, or has no key any more, is shown as unavailable and sends nothing', async () => {
    providersAre(GATEWAY);
    useConfigStore.setState({ openaiCompatibleKeyProvider: 'gone' });
    await openPage();

    expect(keyTrigger()?.textContent).toBe('gone');
    expect(host.textContent).toContain('gone has no key in OpenCode now, so no key is sent.');
    expect(buttonNamed('Send key')).toBeUndefined();

    providersAre();
    await enterAddress('http://localhost:9/v1');
    expect(host.textContent).toContain('gone has no key in OpenCode now, so no key is sent.');
  });
});
