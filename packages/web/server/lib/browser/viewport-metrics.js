export const MIN_VIEWPORT_DIMENSION = 1;
export const MAX_VIEWPORT_DIMENSION = 3840;

export const readViewportMetrics = async (cdp, sessionId) => {
  const response = await cdp.sendSession(sessionId, 'Page.getLayoutMetrics');
  const metrics = {
    layoutWidth: response?.cssLayoutViewport?.clientWidth,
    layoutHeight: response?.cssLayoutViewport?.clientHeight,
    visualWidth: response?.cssVisualViewport?.clientWidth,
    visualHeight: response?.cssVisualViewport?.clientHeight,
    visualScale: response?.cssVisualViewport?.scale,
  };
  if (!Object.values(metrics).every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Invalid viewport metrics');
  }
  return metrics;
};

export const applyViewportMetrics = async (cdp, sessionId, { width, height, mobile }) => {
  if (![width, height].every((value) => Number.isInteger(value)
    && value >= MIN_VIEWPORT_DIMENSION && value <= MAX_VIEWPORT_DIMENSION)) {
    throw new Error('Invalid viewport dimensions');
  }
  if (![true, false].includes(mobile)) throw new Error('Invalid viewport mobile mode');
  await cdp.sendSession(sessionId, 'Emulation.setDeviceMetricsOverride', {
    width, height, mobile, deviceScaleFactor: 1,
  });
  return readViewportMetrics(cdp, sessionId);
};

export const clearViewportMetrics = async (cdp, sessionId) => {
  await cdp.sendSession(sessionId, 'Emulation.clearDeviceMetricsOverride');
  return readViewportMetrics(cdp, sessionId);
};
