import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { OpenChamberLogo } from './OpenChamberLogo';
import { OPEN_CHAMBER_LOGO_ART as ART } from './openChamberLogoArt';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root;
let host: HTMLDivElement;

const render = (element: React.ReactElement) => act(async () => {
  root.render(<I18nProvider>{element}</I18nProvider>);
});
const advance = (ms: number) => act(async () => {
  jest.advanceTimersByTime(ms);
});
const tierOpacities = (logo = 0) => {
  const svg = host.querySelectorAll('svg')[logo];
  return ART.tiers.map((path) => Number(svg.querySelector(`path[d="${path}"]`)?.getAttribute('fill-opacity')));
};
const litPattern = (lit: number) => ART.tiers.map((_, index) => (index === lit ? ART.tierLit[index] : ART.tierRest[index]));

beforeEach(() => {
  jest.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  jest.useRealTimers();
});

test('a still logo shows its tiers at their resting opacity', async () => {
  await render(<OpenChamberLogo />);
  expect(tierOpacities()).toEqual([...ART.tierOpacity]);

  await advance(3000);
  expect(tierOpacities()).toEqual([...ART.tierOpacity]);
});

test('a loading logo lights one tier at a time, outer to core, once a second', async () => {
  await render(<OpenChamberLogo isAnimated />);
  const first = tierOpacities().findIndex((opacity, index) => opacity !== ART.tierRest[index]);
  expect(tierOpacities()).toEqual(litPattern(first));

  for (let step = 1; step <= ART.tiers.length; step += 1) {
    await advance(1000);
    expect(tierOpacities()).toEqual(litPattern((first + step) % ART.tiers.length));
  }
});

test('two logos on one page keep their own wall gradients', async () => {
  await render(<><OpenChamberLogo /><OpenChamberLogo /></>);
  const gradientIds = [...host.querySelectorAll('linearGradient')].map((gradient) => gradient.getAttribute('id'));
  expect(new Set(gradientIds).size).toBe(gradientIds.length);
  for (const svg of host.querySelectorAll('svg')) {
    for (const path of svg.querySelectorAll('path[fill^="url(#"]')) {
      const id = path.getAttribute('fill')?.slice(5, -1) ?? '';
      expect(svg.querySelector(`linearGradient[id="${id}"]`)).not.toBeNull();
    }
  }
});
