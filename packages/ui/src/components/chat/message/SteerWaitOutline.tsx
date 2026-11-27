import { useRoundedBox, type RoundedBox } from '@/hooks/useRoundedBox';

const DASH = 10;
const GAP = 6;
const STROKE = 1;

const outlinePath = (box: RoundedBox) => {
  const inset = STROKE / 2;
  const left = inset;
  const top = inset;
  const right = box.width - inset;
  const bottom = box.height - inset;
  const limit = Math.max(0, Math.min(right - left, bottom - top) / 2);
  const corner = (radius: number) => Math.min(limit, Math.max(0, radius - inset));
  const tl = corner(box.topLeft);
  const tr = corner(box.topRight);
  const br = corner(box.bottomRight);
  const bl = corner(box.bottomLeft);
  const d = [
    `M ${left + tl} ${top}`,
    `H ${right - tr}`,
    `A ${tr} ${tr} 0 0 1 ${right} ${top + tr}`,
    `V ${bottom - br}`,
    `A ${br} ${br} 0 0 1 ${right - br} ${bottom}`,
    `H ${left + bl}`,
    `A ${bl} ${bl} 0 0 1 ${left} ${bottom - bl}`,
    `V ${top + tl}`,
    `A ${tl} ${tl} 0 0 1 ${left + tl} ${top}`,
    'Z',
  ].join(' ');
  const straight = 2 * (right - left) + 2 * (bottom - top) - 2 * (tl + tr + br + bl);
  const length = straight + (Math.PI / 2) * (tl + tr + br + bl);
  const tiles = Math.max(1, Math.round(length / (DASH + GAP)));
  return { d, pathLength: tiles * (DASH + GAP) };
};

export const SteerWaitOutline = () => {
  const [ref, box] = useRoundedBox<HTMLSpanElement>();
  const outline = box && box.width > 0 && box.height > 0 ? outlinePath(box) : null;
  return (
    <span ref={ref} aria-hidden="true" className="pointer-events-none absolute -inset-px rounded-[inherit] text-foreground">
      {outline ? (
        <svg className="absolute inset-0 overflow-visible" width={box?.width} height={box?.height}>
          <path
            d={outline.d}
            pathLength={outline.pathLength}
            fill="none"
            strokeWidth={STROKE}
            stroke="currentColor"
            strokeOpacity={0.28}
            strokeDasharray={`${DASH} ${GAP}`}
          />
        </svg>
      ) : null}
    </span>
  );
};
