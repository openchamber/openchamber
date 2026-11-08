import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLVideoElement: browser.HTMLVideoElement, Event: browser.Event, IS_REACT_ACT_ENVIRONMENT: true,
});
// React DOM and the i18n store read the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { MediaArtifact } = await import('./MediaArtifact');

const UNPLAYABLE = 'This file cannot be played here';

let reactRoot: Root | null = null;
let container: HTMLElement | null = null;

// Owns `src` the way FilesView does: a renewal replaces it.
const Host: React.FC<{ initial: string; renew: () => Promise<string> }> = ({ initial, renew }) => {
  const [src, setSrc] = React.useState(initial);
  const renewSrc = React.useCallback(async () => {
    const next = await renew();
    setSrc(next);
    return next;
  }, [renew]);
  return <MediaArtifact kind="audio" src={src} renewSrc={renewSrc} name="tone.wav" sizeBytes={null} />;
};

const render = async (initial: string, renew: () => Promise<string>) => {
  container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(<I18nProvider><Host initial={initial} renew={renew} /></I18nProvider>));
};

const audio = () => container?.querySelector('audio') ?? null;

// A playing element at `time`: happy-dom has no media engine to move these.
const playingAt = (element: HTMLAudioElement, time: number) => {
  Object.defineProperty(element, 'paused', { configurable: true, get: () => false });
  element.currentTime = time;
};

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  container?.remove();
  reactRoot = null;
  container = null;
});

describe('MediaArtifact', () => {
  test('a failed request gets a fresh URL and resumes at the same position and speed', async () => {
    let renewals = 0;
    await render('http://h/api/fs/raw?path=a&oc_url_token=old', async () => {
      renewals += 1;
      return 'http://h/api/fs/raw?path=a&oc_url_token=new';
    });
    const element = audio();
    if (!element) throw new Error('no audio element');
    playingAt(element, 123);
    element.playbackRate = 1.5;
    let played = 0;
    element.play = async () => { played += 1; };

    await act(async () => { element.dispatchEvent(new Event('error')); });
    expect(renewals).toBe(1);
    expect(audio()).toBe(element);
    expect(element.getAttribute('src')).toBe('http://h/api/fs/raw?path=a&oc_url_token=new');
    expect(container?.textContent).not.toContain(UNPLAYABLE);

    // A new src resets position and speed, as the media load algorithm does.
    element.currentTime = 0;
    element.playbackRate = 1;
    await act(async () => { element.dispatchEvent(new Event('loadedmetadata')); });
    expect(element.currentTime).toBe(123);
    expect(element.playbackRate).toBe(1.5);
    expect(played).toBe(1);
  });

  test('says the file cannot be played when a fresh URL is the same URL', async () => {
    const src = 'http://h/api/fs/raw?path=a&oc_url_token=valid';
    await render(src, async () => src);
    await act(async () => { audio()?.dispatchEvent(new Event('error')); });
    expect(container?.textContent).toContain(UNPLAYABLE);
  });

  test('says the file cannot be played when it fails again right after a renewal', async () => {
    let n = 0;
    await render('http://h/api/fs/raw?path=a&oc_url_token=t0', async () => `http://h/api/fs/raw?path=a&oc_url_token=t${++n}`);
    await act(async () => { audio()?.dispatchEvent(new Event('error')); });
    expect(container?.textContent).not.toContain(UNPLAYABLE);
    await act(async () => { audio()?.dispatchEvent(new Event('error')); });
    expect(n).toBe(1);
    expect(container?.textContent).toContain(UNPLAYABLE);
  });

  test('says the file cannot be played when the renewal fails', async () => {
    await render('http://h/api/fs/raw?path=a&oc_url_token=old', async () => { throw new Error('signed out'); });
    await act(async () => { audio()?.dispatchEvent(new Event('error')); });
    expect(container?.textContent).toContain(UNPLAYABLE);
  });
});
