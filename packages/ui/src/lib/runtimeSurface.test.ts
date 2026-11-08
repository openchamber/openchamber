import { afterAll, afterEach, describe, expect, jest, test, spyOn } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator });

const nativeMatchMedia = browser.matchMedia.bind(browser);
const cleanups: Array<() => void> = [];
const restoreMocks: Array<() => void> = [];

const setPointerQueries = (coarse: boolean, noHover: boolean): void => {
  Object.defineProperty(browser, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query === '(pointer: coarse)') return nativeMatchMedia(coarse ? 'all' : 'print');
      if (query === '(hover: none)') return nativeMatchMedia(noHover ? 'all' : 'print');
      return nativeMatchMedia(query);
    },
  });
};

type BrowserConfig = {
  url?: string;
  width: number;
  height: number;
  screenWidth: number | undefined;
  screenHeight: number | undefined;
  coarse: boolean;
  noHover: boolean;
  touchPoints: number;
};

const configureBrowser = (config: BrowserConfig): void => {
  browser.happyDOM.setURL(config.url ?? 'http://localhost/');
  browser.happyDOM.setViewport({ width: config.width, height: config.height });
  Object.defineProperty(browser.screen, 'width', {
    configurable: true,
    writable: true,
    value: config.screenWidth,
  });
  Object.defineProperty(browser.screen, 'height', {
    configurable: true,
    writable: true,
    value: config.screenHeight,
  });
  browser.happyDOM.settings.navigator.maxTouchPoints = config.touchPoints;
  Object.assign(browser, { Capacitor: undefined, __OPENCHAMBER_ELECTRON__: undefined });
  window.__OPENCHAMBER_SURFACE__ = undefined;
  setPointerQueries(config.coarse, config.noHover);
};

const phone = (overrides: Partial<BrowserConfig> = {}): void => configureBrowser({
  width: 412,
  height: 915,
  screenWidth: 412,
  screenHeight: 915,
  coarse: true,
  noHover: true,
  touchPoints: 5,
  ...overrides,
});

const watchReloads = () => {
  const reload = spyOn(browser.location, 'reload').mockImplementation(() => {});
  restoreMocks.push(() => reload.mockRestore());
  return reload;
};

const dispatchResize = (): void => {
  browser.dispatchEvent(new browser.Event('resize'));
};

const { resolveHostedSurface, watchHostedSurfaceViewport } = await import('./runtimeSurface');

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const restore of restoreMocks.splice(0)) restore();
  jest.useRealTimers();
  window.__OPENCHAMBER_SURFACE__ = undefined;
});

afterAll(() => browser.close());

describe('hosted surface detection', () => {
  test('a phone resolves mobile in portrait on initial load', () => {
    phone();

    expect(resolveHostedSurface()).toBe('mobile');
  });

  test('a phone resolves mobile in landscape on initial load', () => {
    phone({ width: 915, height: 412, screenWidth: 915, screenHeight: 412 });

    expect(resolveHostedSurface()).toBe('mobile');
  });

  test('the largest phone-sized screen stays mobile in both orientations', () => {
    phone({ width: 599, height: 960, screenWidth: 599, screenHeight: 960 });
    expect(resolveHostedSurface()).toBe('mobile');

    phone({ width: 960, height: 599, screenWidth: 960, screenHeight: 599 });
    expect(resolveHostedSurface()).toBe('mobile');
  });

  test('coarse-pointer tablets keep the viewport width rule in both orientations', () => {
    for (const shortSide of [600, 744, 768]) {
      phone({ width: shortSide, height: 1194, screenWidth: shortSide, screenHeight: 1194 });
      expect(resolveHostedSurface()).toBe('mobile');

      phone({ width: 1194, height: shortSide, screenWidth: 1194, screenHeight: shortSide });
      expect(resolveHostedSurface()).toBe('desktop');
    }

    phone({ width: 834, height: 1194, screenWidth: 834, screenHeight: 1194 });
    expect(resolveHostedSurface()).toBe('desktop');
  });

  test('rotating a tablet still reloads into the surface its viewport selects', () => {
    phone({ width: 768, height: 1024, screenWidth: 768, screenHeight: 1024 });
    expect(resolveHostedSurface()).toBe('mobile');
    const reload = watchReloads();
    jest.useFakeTimers();
    const dispose = watchHostedSurfaceViewport();
    cleanups.push(dispose);

    browser.happyDOM.setViewport({ width: 1024, height: 768 });
    Object.assign(browser.screen, { width: 1024, height: 768 });
    dispatchResize();
    jest.advanceTimersByTime(800);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('repeated phone rotation does not reload the mobile surface', () => {
    phone();
    expect(resolveHostedSurface()).toBe('mobile');
    const reload = watchReloads();
    jest.useFakeTimers();
    const dispose = watchHostedSurfaceViewport();
    cleanups.push(dispose);

    browser.happyDOM.setViewport({ width: 915, height: 412 });
    Object.assign(browser.screen, { width: 915, height: 412 });
    dispatchResize();
    jest.advanceTimersByTime(800);
    expect(reload).not.toHaveBeenCalled();

    browser.happyDOM.setViewport({ width: 412, height: 915 });
    Object.assign(browser.screen, { width: 412, height: 915 });
    dispatchResize();
    jest.advanceTimersByTime(800);
    expect(reload).not.toHaveBeenCalled();
  });

  test('a fine-primary touch laptop still uses the viewport width rule', () => {
    configureBrowser({
      width: 1200,
      height: 700,
      screenWidth: 1366,
      screenHeight: 768,
      coarse: false,
      noHover: false,
      touchPoints: 10,
    });
    expect(resolveHostedSurface()).toBe('desktop');

    browser.happyDOM.setViewport({ width: 768, height: 700 });
    window.__OPENCHAMBER_SURFACE__ = undefined;
    expect(resolveHostedSurface()).toBe('mobile');

    browser.happyDOM.setViewport({ width: 1200, height: 700 });
    window.__OPENCHAMBER_SURFACE__ = undefined;
    expect(resolveHostedSurface()).toBe('desktop');
  });

  test('hover:none and touch points alone do not extend the short-side route', () => {
    phone({
      width: 915,
      height: 412,
      screenWidth: 915,
      screenHeight: 412,
      coarse: false,
      noHover: true,
      touchPoints: 10,
    });

    expect(resolveHostedSurface()).toBe('desktop');
  });

  test('a coarse-pointer browser with a large screen still reloads when narrowed', () => {
    phone({
      width: 1200,
      height: 800,
      screenWidth: 1920,
      screenHeight: 1080,
    });
    expect(resolveHostedSurface()).toBe('desktop');
    const reload = watchReloads();
    jest.useFakeTimers();
    const dispose = watchHostedSurfaceViewport();
    cleanups.push(dispose);

    browser.happyDOM.setViewport({ width: 700, height: 800 });
    dispatchResize();
    jest.advanceTimersByTime(400);
    dispatchResize();
    jest.advanceTimersByTime(799);
    expect(reload).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a coarse-pointer browser still reloads when widened past the viewport threshold', () => {
    phone({
      width: 700,
      height: 800,
      screenWidth: 1920,
      screenHeight: 1080,
    });
    expect(resolveHostedSurface()).toBe('mobile');
    const reload = watchReloads();
    jest.useFakeTimers();
    const dispose = watchHostedSurfaceViewport();
    cleanups.push(dispose);

    browser.happyDOM.setViewport({ width: 1200, height: 800 });
    dispatchResize();
    jest.advanceTimersByTime(800);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a short innerHeight alone does not select mobile', () => {
    phone({
      width: 1200,
      height: 500,
      screenWidth: 1920,
      screenHeight: 1080,
    });

    expect(resolveHostedSurface()).toBe('desktop');
  });

  test('missing matchMedia cannot infer the short-side route', () => {
    phone({ width: 915, height: 412, screenWidth: 915, screenHeight: 412 });
    Object.defineProperty(browser, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });

    expect(resolveHostedSurface()).toBe('desktop');
  });

  test('invalid physical screen dimensions leave the short-side route disabled', () => {
    const invalidDimensions: Array<[number | undefined, number | undefined]> = [
      [0, 412],
      [915, 0],
      [Number.NaN, 412],
      [915, Number.NaN],
      [undefined, 412],
      [915, undefined],
    ];

    for (const [screenWidth, screenHeight] of invalidDimensions) {
      phone({
        width: 915,
        height: 412,
        screenWidth,
        screenHeight,
      });
      expect(resolveHostedSurface()).toBe('desktop');
    }
  });

  test('URL overrides and the explicit stamp precede the heuristic', () => {
    phone({
      url: 'http://localhost/?surface=desktop',
      width: 915,
      height: 412,
      screenWidth: 915,
      screenHeight: 412,
    });
    expect(resolveHostedSurface()).toBe('desktop');

    phone({ url: 'http://localhost/?surface=mobile', width: 1200, screenWidth: 1920, screenHeight: 1080 });
    expect(resolveHostedSurface()).toBe('mobile');

    phone({ url: 'http://localhost/?surface=desktop', width: 1200, screenWidth: 1920, screenHeight: 1080 });
    window.__OPENCHAMBER_SURFACE__ = 'mobile';
    expect(resolveHostedSurface()).toBe('mobile');
  });

  test('URL overrides suppress viewport watcher reloads', () => {
    phone({ url: 'http://localhost/?surface=desktop', width: 1200, screenWidth: 1920, screenHeight: 1080 });
    expect(resolveHostedSurface()).toBe('desktop');
    const reload = watchReloads();
    jest.useFakeTimers();
    const dispose = watchHostedSurfaceViewport();
    cleanups.push(dispose);

    browser.happyDOM.setViewport({ width: 400, height: 800 });
    dispatchResize();
    jest.advanceTimersByTime(800);

    expect(reload).not.toHaveBeenCalled();
  });

  test('Capacitor stays mobile and the native watcher is fixed', () => {
    phone({ width: 1200, height: 800, screenWidth: 1920, screenHeight: 1080 });
    Object.assign(browser, { Capacitor: { isNativePlatform: () => true } });
    expect(resolveHostedSurface()).toBe('mobile');
    const reload = watchReloads();
    jest.useFakeTimers();
    watchHostedSurfaceViewport();

    browser.happyDOM.setViewport({ width: 1200, height: 800 });
    dispatchResize();
    jest.advanceTimersByTime(800);

    expect(reload).not.toHaveBeenCalled();
  });

  test('query override takes precedence over the native runtime', () => {
    phone({
      url: 'http://localhost/?surface=desktop',
      width: 412,
      height: 915,
      screenWidth: 412,
      screenHeight: 915,
    });
    Object.assign(browser, { Capacitor: { isNativePlatform: () => true } });

    expect(resolveHostedSurface()).toBe('desktop');
  });

  test('disposing the watcher clears its timer and resize listener', () => {
    phone({ width: 1200, height: 800, screenWidth: 1920, screenHeight: 1080 });
    expect(resolveHostedSurface()).toBe('desktop');
    const reload = watchReloads();
    jest.useFakeTimers();
    const dispose = watchHostedSurfaceViewport();

    browser.happyDOM.setViewport({ width: 700, height: 800 });
    dispatchResize();
    dispose();
    jest.advanceTimersByTime(800);
    browser.happyDOM.setViewport({ width: 1200, height: 800 });
    dispatchResize();
    jest.advanceTimersByTime(800);

    expect(reload).not.toHaveBeenCalled();
  });
});
