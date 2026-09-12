import { applyTone, type Tone } from './badge.ts';
import { el, ensureStyle, setText, type Handle } from './dom.ts';
import { UI_CSS } from './style.ts';

export type ProgressProps = {
  /** 0 to 100. Values outside that range are clamped. */
  value: number;
  tone?: Tone;
  label?: string;
};

export type ProgressHandle = Handle<ProgressProps>;

export const clampProgress = (value: number): number => (
  Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0
);

export const mountProgress = (root: Element, initial: ProgressProps): ProgressHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  const node = el('div', 'oc-sdk oc-sdk-progress');
  const caption = el('div', 'oc-sdk-progress-label');
  const label = el('span');
  const percent = el('span');
  caption.append(label, percent);
  const track = el('div', 'oc-sdk-progress-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  const fill = el('div', 'oc-sdk-progress-fill');
  track.append(fill);
  node.append(caption, track);
  root.append(node);

  const paint = (): void => {
    const value = clampProgress(props.value);
    applyTone(fill, props.tone);
    fill.style.transform = `scaleX(${value / 100})`;
    track.setAttribute('aria-valuenow', String(value));
    if (props.label) track.setAttribute('aria-label', props.label); else track.removeAttribute('aria-label');
    setText(label, props.label);
    setText(percent, `${value}%`);
    caption.hidden = !props.label;
  };
  paint();

  return {
    update: (next) => {
      props = { ...props, ...next };
      paint();
    },
    dispose: () => {
      node.remove();
    },
  };
};
