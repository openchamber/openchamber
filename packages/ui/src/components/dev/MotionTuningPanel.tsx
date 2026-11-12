import React from 'react';
import { MOTION_SPRING_NAMES, springCss, type MotionSpringName } from '@/lib/motion/springs';
import { applyMotionTuning, readMotionTuning, resetMotionTuning, DEFAULT_MOTION_TUNING, type MotionTuning } from '@/lib/motion/tuning';

// A developer tool, mounted only in development builds and never shipped, so
// its labels stay out of the translated dictionaries.
const SPRING_LABELS = {
  popup: 'Popups open (menus, selects, tooltips)',
  layout: 'Layout moves (picker width)',
} satisfies Record<MotionSpringName, string>;

const Slider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
}> = ({ label, value, min, max, step, unit, onChange }) => (
  <label className="flex flex-col gap-1">
    <span className="flex justify-between typography-micro text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{value}{unit}</span>
    </span>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="w-full accent-[var(--primary)]"
    />
  </label>
);

/**
 * Live motion knobs for development: Ctrl+Alt+M (Cmd+Alt+M on macOS) shows
 * the panel. Each spring's perceived duration and bounce rewrite the motion
 * variables on the root element at once, so the change is felt in the app as
 * it is made, and the values stay on this device until Reset.
 */
const MotionTuningPanel: React.FC = () => {
  const [open, setOpen] = React.useState(false);
  const [tuning, setTuning] = React.useState<MotionTuning>(readMotionTuning);

  React.useEffect(() => {
    applyMotionTuning(readMotionTuning(), false);
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyM') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const update = (next: MotionTuning) => {
    setTuning(next);
    applyMotionTuning(next, true);
  };

  if (!open) return null;

  return (
    <div className="oc-glass-popover oc-glass-floating fixed bottom-4 start-4 z-[200] flex w-72 flex-col gap-3 rounded-xl p-3">
      <div className="flex items-center justify-between">
        <span className="typography-ui-label font-medium text-foreground">Motion</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="typography-micro text-muted-foreground hover:text-foreground"
            onClick={() => {
              resetMotionTuning();
              setTuning(DEFAULT_MOTION_TUNING);
            }}
          >
            Reset
          </button>
          <button type="button" className="typography-micro text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
      {MOTION_SPRING_NAMES.map((name) => {
        const spec = tuning.springs[name];
        const settle = springCss(spec).durationMs;
        const setSpec = (patch: Partial<typeof spec>) => update({ ...tuning, springs: { ...tuning.springs, [name]: { ...spec, ...patch } } });
        return (
          <div key={name} className="flex flex-col gap-2">
            <span className="typography-micro font-medium text-foreground">{SPRING_LABELS[name]}</span>
            <Slider label="Duration" value={spec.duration} min={0.1} max={0.8} step={0.01} unit="s" onChange={(duration) => setSpec({ duration })} />
            <Slider label="Bounce" value={spec.bounce} min={0} max={0.4} step={0.01} unit="" onChange={(bounce) => setSpec({ bounce })} />
            <span className="typography-micro text-muted-foreground">Settles in {settle}ms</span>
          </div>
        );
      })}
      <Slider
        label="Popup fade out"
        value={tuning.popupExitMs}
        min={0}
        max={300}
        step={10}
        unit="ms"
        onChange={(popupExitMs) => update({ ...tuning, popupExitMs })}
      />
    </div>
  );
};

export default MotionTuningPanel;
