import React from 'react';

/**
 * One run of the "levitation" logo animation (docs/references/brand/cube-levitation.html):
 * the three roof plates lift off in turn, the cube makes one full turn while the
 * plates spin at their own rates, then the plates settle back and flash. The
 * run starts and ends in the exact pose of `OpenChamberLogo` at the same size,
 * so it can stand in for the static logo and hand back to it without a jump.
 */

const DURATION_MS = 9000;
// The canvas is larger than the logo to leave room for the lifted plates and the turn.
const CANVAS_SCALE = 3;
// The logo's vertical edge is 48 of its 100 viewBox units; an isometric edge of
// length 2 projects to 2 * sqrt(2/3) cube units.
const CUBE_SCALE = 48 / (2 * Math.sqrt(2 / 3)) / 100;

type Vec3 = [number, number, number];
type Mat3 = number[];
type Plate = { h: number; r: number; fill: number; edge: number };
type Pose = { M: Mat3; P: Mat3; plates: Plate[] };

const { sin, cos, PI, max, min, sqrt, atan } = Math;
const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (s: number, a: number, b: number) => clamp((s - a) / (b - a));
const eio = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const eout = (x: number) => 1 - Math.pow(1 - x, 3);
const sstep = (x: number) => x * x * (3 - 2 * x);
const mm = (A: Mat3, B: Mat3): Mat3 => {
  const R = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return R;
};
const mv = (M: Mat3, v: Vec3): Vec3 => [
  M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
  M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
  M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
];
const RX = (a: number): Mat3 => [1, 0, 0, 0, cos(a), -sin(a), 0, sin(a), cos(a)];
const RY = (a: number): Mat3 => [cos(a), 0, sin(a), 0, 1, 0, -sin(a), 0, cos(a)];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Isometric view: yaw 45 degrees, pitch atan(1/sqrt 2), the logo's own projection.
const VIEW = mm(RX(atan(1 / sqrt(2))), RY(PI / 4));
const LIGHT: Vec3 = (() => {
  const l: Vec3 = [0.35, -0.6, 0.5];
  return sc(l, 1 / sqrt(dot(l, l)));
})();
const FACES: { n: Vec3; u: Vec3; v: Vec3 }[] = [
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
];
const quad = (c: Vec3, u: Vec3, v: Vec3): Vec3[] => [add(add(c, u), v), add(add(c, u), sc(v, -1)), add(add(c, sc(u, -1)), sc(v, -1)), add(add(c, sc(u, -1)), v)];
const BASE = [0.22, 0.27, 0.85];
const LIT = [0.55, 0.55, 1];
const SCALE = [0.8, 0.58, 0.36];
const REST_G = sqrt(2 / 3);

const levitate = (s: number): Pose => {
  const spin = eio(seg(s, 0.2, 0.74));
  const plates: Plate[] = [];
  for (let i = 0; i < 3; i++) {
    const lift = eout(seg(s, 0.08 + 0.04 * i, 0.26 + 0.04 * i));
    const fs = 0.68 + 0.045 * i;
    const fe = fs + 0.16;
    const fall = seg(s, fs, fe);
    const height = 0.42 + 0.42 * i;
    const float = lift * (1 - sstep(fall));
    const bob = 0.06 * sin(2 * PI * s * 4 + i * 1.7) * float;
    const h = height * lift * (1 - eio(fall)) + bob;
    const r = eio(seg(s, 0.24, 0.72)) * [-PI, 2 * PI, -3 * PI][i];
    const land = s >= fe - 0.03 ? sin(PI * seg(s, fe - 0.03, fe + 0.09)) : 0;
    const charge = sin(PI * seg(s, 0.025 * (2 - i), 0.06 + 0.025 * (2 - i)));
    plates.push({ h, r, fill: BASE[i] + (LIT[i] - BASE[i]) * max(land, charge, float * 0.4), edge: float });
  }
  return { M: RY(spin * 2 * PI), P: RX(0.32 * sin(PI * spin)), plates };
};

/** The colour as RGB, through the canvas so any CSS colour syntax works. */
const toRgb = (color: string): [number, number, number] => {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return [128, 128, 128];
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
};

const draw = (ctx: CanvasRenderingContext2D, pose: Pose, box: number, cubeScale: number, dpr: number, rgb: [number, number, number]) => {
  const rgba = (a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(a)})`;
  const path = (pts: Vec3[]) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box, box);
  const S = cubeScale;
  const c = box / 2;
  const lw = S * 0.075;
  const R = mm(mm(pose.P, VIEW), pose.M);
  const proj = (p: Vec3): Vec3 => {
    const q = mv(R, p);
    return [c + S * q[0], c - S * q[1], q[2]];
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const face of FACES) {
    const nv = mv(R, face.n);
    if (nv[2] <= 1e-3) continue;
    const pts = quad(face.n, face.u, face.v).map(proj);
    const base = 0.06 + 0.11 * max(0, dot(nv, LIGHT));
    // Depth gradient along the face plane, so the shading turns smoothly with the cube.
    const g: Vec3 = [-nv[2] * nv[0], -nv[2] * nv[1], 1 - nv[2] * nv[2]];
    const gl = sqrt(g[0] * g[0] + g[1] * g[1]);
    const m = clamp(gl / REST_G);
    const center = proj(face.n);
    path(pts);
    if (gl > 1e-4) {
      const dx = g[0] / gl;
      const dy = -g[1] / gl;
      const ext = S * 1.3;
      const gradient = ctx.createLinearGradient(center[0] - dx * ext, center[1] - dy * ext, center[0] + dx * ext, center[1] + dy * ext);
      gradient.addColorStop(0, rgba(base * (1 - 0.65 * m)));
      gradient.addColorStop(1, rgba(base * (1 + 0.5 * m)));
      ctx.fillStyle = gradient;
    } else {
      ctx.fillStyle = rgba(base);
    }
    ctx.fill();
    ctx.strokeStyle = rgba(1);
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  const top = FACES[0];
  if (mv(R, top.n)[2] <= 1e-3) return;
  const plates = pose.plates.map((plate, i) => ({ ...plate, i })).sort((a, b) => a.h - b.h);
  for (const plate of plates) {
    const cs = cos(plate.r);
    const sn = sin(plate.r);
    const k = SCALE[plate.i];
    const u = sc(add(sc(top.u, cs), sc(top.v, sn)), k);
    const v = sc(add(sc(top.u, -sn), sc(top.v, cs)), k);
    path(quad(sc(top.n, 1 + plate.h), u, v).map(proj));
    ctx.fillStyle = rgba(plate.fill);
    ctx.fill();
    if (plate.edge > 0.01) {
      ctx.strokeStyle = rgba(0.5 * plate.edge);
      ctx.lineWidth = lw * 0.45;
      ctx.stroke();
    }
  }
};

interface LevitatingLogoProps {
  /** The size of the `OpenChamberLogo` this run stands in for, in pixels. */
  size: number;
  color: string;
  onDone: () => void;
}

/** Centred over the static logo's box, which keeps its place in the layout. */
export const LevitatingLogo: React.FC<LevitatingLogoProps> = ({ size, color, onDone }) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const box = size * CANVAS_SCALE;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box * dpr);
    canvas.height = Math.round(box * dpr);
    const rgb = toRgb(color);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = min(1, (now - start) / DURATION_MS);
      draw(ctx, levitate(progress), box, size * CUBE_SCALE, dpr, rgb);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else onDone();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [box, color, onDone, size]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width: box, height: box }}
    />
  );
};
