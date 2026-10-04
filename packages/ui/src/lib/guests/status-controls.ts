import { HostRequestError, type GuestStatusControl, type GuestStatusControlEvent } from '@openchamber/sdk';

export type GuestStatusControlBinding = {
  controls: GuestStatusControl[];
  dispatch: (event: GuestStatusControlEvent) => void;
};

type StatusControlHost = {
  isActive: () => boolean;
  onChange: (binding: GuestStatusControlBinding | null) => void;
  post: (event: GuestStatusControlEvent) => void;
  now?: () => number;
  getContext?: () => string | null;
};

const PUBLICATIONS_PER_SECOND = 20;

/** Owns one status frame's header. Retained UI callbacks cannot outlive its definitions. */
export const createGuestStatusControls = ({ isActive, onChange, post, now = () => performance.now(), getContext = () => null }: StatusControlHost) => {
  let disposed = false;
  let generation = 0;
  let signature = '[]';
  let windowStart = now();
  let publications = 0;

  return {
    set(controls: GuestStatusControl[]): void {
      if (disposed || !isActive()) throw new HostRequestError('DISABLED', 'This status frame is no longer active.');
      const nextSignature = JSON.stringify(controls);
      if (signature === nextSignature) return;
      const time = now();
      if (time - windowStart >= 1000) {
        windowStart = time;
        publications = 0;
      }
      if (publications >= PUBLICATIONS_PER_SECOND) {
        throw new HostRequestError('HOST_REJECTED', 'Status controls changed too often.');
      }
      publications += 1;
      signature = nextSignature;
      generation += 1;
      const owner = generation;
      const context = getContext();
      onChange(controls.length === 0 ? null : {
        controls,
        dispatch(event) {
          if (disposed || owner !== generation || context !== getContext() || !isActive()) return;
          const control = controls.find((candidate) => candidate.id === event.id);
          if (!control || control.disabled) return;
          if (control.kind === 'button') {
            if (event.value !== undefined) return;
          } else if (!control.options.some((option) => option.value === event.value)) return;
          post(event);
        },
      });
    },
    retire(): void {
      if (disposed) return;
      generation += 1;
      signature = '[]';
      onChange(null);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      onChange(null);
    },
  };
};
