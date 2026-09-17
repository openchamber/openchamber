import type { SurfaceFrameGeometry } from './remoteSurface';

type DisplaySize = { readonly width: number; readonly height: number };
type WheelDelta = { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number };

/** Wheel units become displayed CSS pixels first, then remote page CSS pixels. */
export const viewerWheelToFrameCss = (wheel: WheelDelta, displayed: DisplaySize, frame: SurfaceFrameGeometry) => {
  if (displayed.width <= 0 || displayed.height <= 0) return null;
  const unitX = wheel.deltaMode === 2 ? displayed.width : wheel.deltaMode === 1 ? 16 : 1;
  const unitY = wheel.deltaMode === 2 ? displayed.height : wheel.deltaMode === 1 ? 16 : 1;
  return {
    deltaX: wheel.deltaX * unitX * frame.width / displayed.width,
    deltaY: wheel.deltaY * unitY * frame.height / displayed.height,
  };
};

export const surfaceModifiers = (event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): string[] => {
  const modifiers: string[] = [];
  if (event.altKey) modifiers.push('Alt');
  if (event.ctrlKey) modifiers.push('Control');
  if (event.metaKey) modifiers.push('Meta');
  if (event.shiftKey) modifiers.push('Shift');
  return modifiers;
};
