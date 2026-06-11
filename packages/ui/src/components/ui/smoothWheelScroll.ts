type WheelLike = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaZ' | 'deltaMode' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>;

type SmoothWheelState = {
  frame: number | null;
  target: number | null;
  animating: boolean;
  lastAppliedTop: number | null;
};

const smoothWheelState = new WeakMap<HTMLElement, SmoothWheelState>();

const getState = (container: HTMLElement): SmoothWheelState => {
  const existing = smoothWheelState.get(container);
  if (existing) {
    return existing;
  }

  const state: SmoothWheelState = { frame: null, target: null, animating: false, lastAppliedTop: null };
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
  state.lastAppliedTop = null;
};

export const smoothWheelScrollElement = (container: HTMLElement, event: WheelLike): void => {
  const state = getState(container);
  if (state.animating && state.lastAppliedTop !== null && Math.abs(container.scrollTop - state.lastAppliedTop) > 2) {
    cancelSmoothWheelScroll(container);
  }

  const maxScroll = container.scrollHeight - container.clientHeight;
  if (state.target === null) {
    state.target = container.scrollTop;
  }

  state.target = Math.max(0, Math.min(maxScroll, state.target + event.deltaY));

  const smoothScroll = () => {
    state.frame = null;
    if (state.target === null) {
      state.animating = false;
      state.lastAppliedTop = container.scrollTop;
      return;
    }

    if (state.lastAppliedTop !== null && Math.abs(container.scrollTop - state.lastAppliedTop) > 2) {
      state.target = null;
      state.animating = false;
      state.lastAppliedTop = container.scrollTop;
      return;
    }

    const diff = state.target - container.scrollTop;
    if (Math.abs(diff) < 0.5) {
      container.scrollTop = state.target;
      state.target = null;
      state.animating = false;
      state.lastAppliedTop = container.scrollTop;
      return;
    }

    container.scrollTop += diff * 0.25;
    state.lastAppliedTop = container.scrollTop;
    state.frame = requestAnimationFrame(smoothScroll);
  };

  if (!state.animating) {
    state.animating = true;
    state.frame = requestAnimationFrame(smoothScroll);
  }
};
