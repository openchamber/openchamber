import { describe, expect, it } from 'vitest';
import {
  applyViewportMetrics,
  clearViewportMetrics,
  MAX_VIEWPORT_DIMENSION,
  MIN_VIEWPORT_DIMENSION,
  readViewportMetrics,
} from './viewport-metrics.js';

const chromeMetrics = () => ({
  cssLayoutViewport: { clientWidth: 980, clientHeight: 1800 },
  cssVisualViewport: { clientWidth: 390, clientHeight: 844, scale: 2.5 },
});

const observedMetrics = {
  layoutWidth: 980, layoutHeight: 1800, visualWidth: 390, visualHeight: 844, visualScale: 2.5,
};

const fakeCdp = (...responses) => ({
  calls: [],
  async sendSession(sessionId, method, params = {}) {
    this.calls.push({ sessionId, method, params });
    if (responses.length === 0) throw new Error(`Unexpected CDP command: ${method}`);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  },
});

describe('viewport metrics reads', () => {
  it('returns observed CSS layout and visual metrics without using legacy pixel values', async () => {
    const cdp = fakeCdp({ ...chromeMetrics(), layoutViewport: { clientWidth: 1, clientHeight: 1 } });

    await expect(readViewportMetrics(cdp, 'page-1')).resolves.toEqual(observedMetrics);
    expect(cdp.calls).toEqual([{ sessionId: 'page-1', method: 'Page.getLayoutMetrics', params: {} }]);
  });

  it('accepts finite positive fractional CSS dimensions and visual scales', async () => {
    const cdp = fakeCdp({
      cssLayoutViewport: { clientWidth: 390.5, clientHeight: 844.25 },
      cssVisualViewport: { clientWidth: 195.25, clientHeight: 422.125, scale: 0.5 },
    });

    await expect(readViewportMetrics(cdp, 'page-1')).resolves.toEqual({
      layoutWidth: 390.5, layoutHeight: 844.25, visualWidth: 195.25, visualHeight: 422.125, visualScale: 0.5,
    });
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', {}],
    ['legacy only', { layoutViewport: { clientWidth: 390, clientHeight: 844 }, visualViewport: { clientWidth: 390, clientHeight: 844, scale: 1 } }],
    ['missing layout', { cssVisualViewport: chromeMetrics().cssVisualViewport }],
    ['missing visual', { cssLayoutViewport: chromeMetrics().cssLayoutViewport }],
  ])('rejects %s metrics instead of returning empty or legacy values', async (_name, response) => {
    await expect(readViewportMetrics(fakeCdp(response), 'page-1')).rejects.toThrow('Invalid viewport metrics');
  });

  it.each([
    ['cssLayoutViewport', 'clientWidth'], ['cssLayoutViewport', 'clientHeight'],
    ['cssVisualViewport', 'clientWidth'], ['cssVisualViewport', 'clientHeight'], ['cssVisualViewport', 'scale'],
  ])('requires %s.%s to be a finite positive number', async (group, field) => {
    for (const invalid of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '100', true]) {
      const response = chromeMetrics();
      response[group][field] = invalid;
      await expect(readViewportMetrics(fakeCdp(response), 'page-1')).rejects.toThrow('Invalid viewport metrics');
    }
  });

  it('propagates a metrics command failure', async () => {
    const failure = new Error('Metrics unavailable');

    await expect(readViewportMetrics(fakeCdp(failure), 'page-1')).rejects.toBe(failure);
  });
});

describe('viewport metrics writes', () => {
  it('exports inclusive dimension bounds of 1 through 3840', () => {
    expect(MIN_VIEWPORT_DIMENSION).toBe(1);
    expect(MAX_VIEWPORT_DIMENSION).toBe(3840);
  });

  it.each([
    { width: 1, height: 3840, mobile: false },
    { width: 3840, height: 1, mobile: true },
    { width: 390, height: 844, mobile: false },
    { width: 1440, height: 900, mobile: true },
  ])('applies $width×$height with explicit mobile=$mobile and DPR 1', async (viewport) => {
    const cdp = fakeCdp({}, chromeMetrics());

    await expect(applyViewportMetrics(cdp, 'page-1', viewport)).resolves.toEqual(observedMetrics);
    expect(cdp.calls).toEqual([
      { sessionId: 'page-1', method: 'Emulation.setDeviceMetricsOverride', params: { ...viewport, deviceScaleFactor: 1 } },
      { sessionId: 'page-1', method: 'Page.getLayoutMetrics', params: {} },
    ]);
  });

  it.each(['width', 'height'])('rejects invalid %s before sending a CDP command', async (dimension) => {
    for (const invalid of [undefined, null, 0, -1, 3841, 1.5, NaN, Infinity, '390']) {
      const cdp = fakeCdp();

      await expect(applyViewportMetrics(cdp, 'page-1', {
        width: 390, height: 844, mobile: false, [dimension]: invalid,
      })).rejects.toThrow('Invalid viewport dimensions');
      expect(cdp.calls).toEqual([]);
    }
  });

  it('rejects nonboolean mobile values before sending a CDP command', async () => {
    for (const mobile of [undefined, null, 0, 1, 'false', 'true', {}, []]) {
      const cdp = fakeCdp();

      await expect(applyViewportMetrics(cdp, 'page-1', { width: 390, height: 844, mobile })).rejects.toThrow('Invalid viewport mobile mode');
      expect(cdp.calls).toEqual([]);
    }
  });

  it('clears the override and returns Chrome observations', async () => {
    const cdp = fakeCdp({}, chromeMetrics());

    await expect(clearViewportMetrics(cdp, 'page-1')).resolves.toEqual(observedMetrics);
    expect(cdp.calls).toEqual([
      { sessionId: 'page-1', method: 'Emulation.clearDeviceMetricsOverride', params: {} },
      { sessionId: 'page-1', method: 'Page.getLayoutMetrics', params: {} },
    ]);
  });

  it.each([
    ['apply', (cdp) => applyViewportMetrics(cdp, 'page-1', { width: 390, height: 844, mobile: false })],
    ['clear', (cdp) => clearViewportMetrics(cdp, 'page-1')],
  ])('%s waits for the write and propagates write and read failures', async (_name, write) => {
    const pending = Promise.withResolvers();
    const cdp = fakeCdp(pending.promise, chromeMetrics());
    const operation = write(cdp);
    await Promise.resolve();
    expect(cdp.calls).toHaveLength(1);
    pending.resolve({});
    await expect(operation).resolves.toEqual(observedMetrics);

    const failure = new Error('Chrome command failed');
    const failedWrite = fakeCdp(failure);
    await expect(write(failedWrite)).rejects.toBe(failure);
    expect(failedWrite.calls).toHaveLength(1);
    await expect(write(fakeCdp({}, failure))).rejects.toBe(failure);
    await expect(write(fakeCdp({}, {}))).rejects.toThrow('Invalid viewport metrics');
  });
});
