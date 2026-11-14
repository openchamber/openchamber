import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator });

// happy-dom derives pointer and hover from maxTouchPoints, so a fine hovering
// pointer next to a touch digitizer cannot be expressed through its settings.
// Answer each query with a real MediaQueryList for a query that always
// (`all`) or never (`print`) matches on screen.
const realMatchMedia = browser.matchMedia.bind(browser);
/** What the primary pointer reports: `(pointer: coarse)` and `(hover: none)`. */
interface PrimaryPointer { coarse: boolean; noHover: boolean }
let pointer: PrimaryPointer = { coarse: false, noHover: false };
const matchMediaSpy = spyOn(browser, 'matchMedia').mockImplementation((query: string) => {
  if (query === '(pointer: coarse)') return realMatchMedia(pointer.coarse ? 'all' : 'print');
  if (query === '(hover: none)') return realMatchMedia(pointer.noHover ? 'all' : 'print');
  return realMatchMedia(query);
});

const { getDeviceInfo } = await import('./device');

const useDevice = (url: string, maxTouchPoints: number, next: PrimaryPointer) => {
  browser.happyDOM.setURL(url);
  browser.happyDOM.settings.navigator.maxTouchPoints = maxTouchPoints;
  pointer = next;
};

afterAll(() => {
  matchMediaSpy.mockRestore();
  browser.close();
});

describe('getDeviceInfo touch input', () => {
  test('a desktop surface driven by a hovering mouse is not touch even when a touch digitizer is present', () => {
    useDevice('http://localhost/?surface=desktop', 10, { coarse: false, noHover: false });
    const info = getDeviceInfo();
    expect(info.isDesktop).toBe(true);
    expect(info.hasTouchInput).toBe(false);
  });

  test('a desktop surface whose primary pointer is touch stays touch', () => {
    useDevice('http://localhost/?surface=desktop', 10, { coarse: true, noHover: true });
    const info = getDeviceInfo();
    expect(info.isDesktop).toBe(true);
    expect(info.hasTouchInput).toBe(true);
  });

  test('a browser tab still counts touch points as touch input', () => {
    useDevice('http://localhost/', 10, { coarse: false, noHover: false });
    expect(getDeviceInfo().hasTouchInput).toBe(true);
  });
});

describe('getDeviceInfo root classes', () => {
  const root = browser.document.documentElement;
  const classMutations = (run: () => void): number => {
    const observer = new browser.MutationObserver(() => {});
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    run();
    const count = observer.takeRecords().length;
    observer.disconnect();
    return count;
  };

  test('a repeated read with nothing changed leaves the root classes untouched', () => {
    useDevice('http://localhost/', 10, { coarse: true, noHover: true });
    getDeviceInfo();
    expect(classMutations(() => getDeviceInfo())).toBe(0);
  });

  test('a change of surface swaps exactly the classes that differ', () => {
    useDevice('http://localhost/', 10, { coarse: true, noHover: true });
    getDeviceInfo();
    expect(root.classList.contains('mobile-pointer')).toBe(true);
    expect(root.classList.contains('desktop-runtime')).toBe(false);

    useDevice('http://localhost/?surface=desktop', 10, { coarse: false, noHover: false });
    getDeviceInfo();
    expect(root.classList.contains('device-desktop')).toBe(true);
    expect(root.classList.contains('device-mobile')).toBe(false);
    expect(root.classList.contains('device-tablet')).toBe(false);
    expect(root.classList.contains('desktop-runtime')).toBe(true);
    expect(root.classList.contains('mobile-pointer')).toBe(false);
  });
});
