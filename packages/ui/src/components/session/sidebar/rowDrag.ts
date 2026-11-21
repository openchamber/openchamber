import type React from 'react';
import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type AutoScrollOptions,
  type MouseSensorOptions,
  type Modifier,
  type TouchSensorOptions,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { fillStuckZoneHeaders } from './projects/zoneHeaderHosts';

const ROW_CONTROLS = 'button, a[href], input, textarea, select, [role="switch"], [role="checkbox"], [role="menuitem"], [contenteditable="true"], [contenteditable="plaintext-only"]';

const pressLiftsRow = (event: React.SyntheticEvent): boolean => {
  if (!(event.target instanceof Element)) return true;
  const control = event.target.closest(ROW_CONTROLS);
  return control === null
    || control.hasAttribute('data-row-drag')
    || control === event.currentTarget
    || (event.currentTarget instanceof Element && control.contains(event.currentTarget));
};

class RowMouseSensor extends MouseSensor {
  static activators = [{
    eventName: 'onMouseDown' as const,
    handler: (event: React.MouseEvent, { onActivation }: MouseSensorOptions): boolean => {
      if (event.nativeEvent.button !== 0 || !pressLiftsRow(event)) return false;
      onActivation?.({ event: event.nativeEvent });
      return true;
    },
  }];
}

class RowTouchSensor extends TouchSensor {
  static activators = [{
    eventName: 'onTouchStart' as const,
    handler: (event: React.TouchEvent, { onActivation }: TouchSensorOptions): boolean => {
      if (event.nativeEvent.touches.length > 1 || !pressLiftsRow(event)) return false;
      onActivation?.({ event: event.nativeEvent });
      return true;
    },
  }];
}

export const useRowDragSensors = ({ keyboard = false }: { keyboard?: boolean } = {}) => {
  const mouse = useSensor(RowMouseSensor, { activationConstraint: { distance: 4 } });
  const touch = useSensor(RowTouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } });
  const keys = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  return useSensors(mouse, touch, keyboard ? keys : null);
};

export const keepRowInList: Modifier = ({ transform, active, scrollableAncestorRects }) => {
  const list = scrollableAncestorRects[0];
  const picked = active?.rect.current.initial;
  if (!picked || !list) return { ...transform, x: 0 };
  const y = Math.min(Math.max(transform.y, list.top - picked.top), list.bottom - picked.bottom);
  return { ...transform, x: 0, y };
};

export const ROW_DRAG_AUTO_SCROLL: AutoScrollOptions = { threshold: { x: 0, y: 0.08 }, acceleration: 8 };

export const ROW_SORT_TRANSITION = { duration: 160, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' };

export const copyDragSource = (data: { element?: () => HTMLElement | null } | undefined): Element | null => {
  const source = data?.element?.();
  const copy = source?.cloneNode(true);
  if (!source || !(copy instanceof Element)) return null;
  fillStuckZoneHeaders(source, copy);
  for (const element of [copy, ...copy.querySelectorAll('[id]')]) element.removeAttribute('id');
  return copy;
};
