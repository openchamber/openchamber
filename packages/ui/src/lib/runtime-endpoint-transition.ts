export type RuntimeEndpointTransitionCoalescer<T> = {
  schedule: (value: T) => void;
  cancel: () => void;
};

export const createRuntimeEndpointTransitionCoalescer = <T>(
  apply: (value: T) => void,
  delayMs = 50,
): RuntimeEndpointTransitionCoalescer<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | undefined;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = undefined;
  };

  return {
    schedule: (value) => {
      pending = value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const next = pending;
        pending = undefined;
        if (next !== undefined) apply(next);
      }, delayMs);
    },
    cancel,
  };
};
