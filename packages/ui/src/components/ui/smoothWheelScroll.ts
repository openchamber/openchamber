type WheelLike = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaZ' | 'deltaMode' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

type SmoothWheelState = {
  frame: number | null;
  target: number | null;
  animating: boolean;
};

const smoothWheelState = new WeakMap<HTMLElement, SmoothWheelState>();

const getState = (container: HTMLElement): SmoothWheelState => {
  const existing = smoothWheelState.get(container);
  if (existing) {
    return existing;
  }

  const state: SmoothWheelState = { frame: null, target: null, animating: false };
  smoothWheelState.set(container, state);
  return state;
};

export const cancelSmoothWheelScroll = (container: HTMLElement): void => {
  const state = smoothWheelState.get(container);
  if (!state) {
    return;
  }

  if (state.frame !== null) {
    cancelAnimationFrame(state.frame);
  }
  state.frame = null;
  state.target = null;
  state.animating = false;
};

export const smoothWheelScrollElement = (container: HTMLElement, event: WheelLike): void => {
  const state = getState(container);
  const clonedEvent = new WheelEvent('wheel', {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    bubbles: true,
    cancelable: true,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  });
  container.dispatchEvent(clonedEvent);

  const maxScroll = container.scrollHeight - container.clientHeight;
  if (state.target === null) {
    state.target = container.scrollTop;
  }

  state.target = Math.max(0, Math.min(maxScroll, state.target + event.deltaY));

  const smoothScroll = () => {
    state.frame = null;
    if (state.target === null) {
      state.animating = false;
      return;
    }

    const diff = state.target - container.scrollTop;
    if (Math.abs(diff) < 0.5) {
      container.scrollTop = state.target;
      state.target = null;
      state.animating = false;
      return;
    }

    container.scrollTop += diff * 0.25;
    state.frame = requestAnimationFrame(smoothScroll);
  };

  if (!state.animating) {
    state.animating = true;
    state.frame = requestAnimationFrame(smoothScroll);
  }
};
