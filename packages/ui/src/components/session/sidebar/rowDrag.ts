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

/**
 * How rows drag in the sidebar and the sections manager: the whole row lifts,
 * not a handle; a press on a control in the row (a button, a switch, a field)
 * works that control and never lifts the row. The row's own button, the one
 * that opens or selects it, is part of the row: it carries `data-row-drag`.
 */
const ROW_CONTROLS = 'button, a[href], input, textarea, select, [role="switch"], [role="checkbox"], [role="menuitem"], [contenteditable="true"], [contenteditable="plaintext-only"]';

const pressLiftsRow = (event: React.SyntheticEvent): boolean => {
  if (!(event.target instanceof Element)) return true;
  const control = event.target.closest(ROW_CONTROLS);
  // A control around the row is not the row's; one drawn in a portal (a stuck
  // header's buttons) is the row's although the row's element does not hold it.
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

/**
 * A row lifts after 4px of mouse travel, so a click still clicks; on touch
 * after a 200ms press, so a swipe still scrolls the list.
 */
export const useRowDragSensors = ({ keyboard = false }: { keyboard?: boolean } = {}) => {
  const mouse = useSensor(RowMouseSensor, { activationConstraint: { distance: 4 } });
  const touch = useSensor(RowTouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } });
  const keys = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates });
  return useSensors(mouse, touch, keyboard ? keys : null);
};

/**
 * A lifted row moves straight up and down, and no further than the list it
 * sorts in. Measured from where the row was picked up, which is where the
 * transform starts from, even after the list folds under it.
 */
export const keepRowInList: Modifier = ({ transform, active, scrollableAncestorRects }) => {
  const list = scrollableAncestorRects[0];
  const picked = active?.rect.current.initial;
  if (!picked || !list) return { ...transform, x: 0 };
  const y = Math.min(Math.max(transform.y, list.top - picked.top), list.bottom - picked.bottom);
  return { ...transform, x: 0, y };
};

/** The list scrolls only near its very edge while a row is held there, and gathers speed. */
export const ROW_DRAG_AUTO_SCROLL: AutoScrollOptions = { threshold: { x: 0, y: 0.08 }, acceleration: 8 };

/** Rows making room slide quickly and settle softly. */
export const ROW_SORT_TRANSITION = { duration: 160, easing: 'cubic-bezier(0.25, 1, 0.5, 1)' };

/**
 * A copy of the row a drag payload names, taken as the drag starts: the row
 * itself fades or empties its place a render later. The copy is inert and
 * carries no ids.
 */
export const copyDragSource = (data: { element?: () => HTMLElement | null } | undefined): Element | null => {
  const source = data?.element?.();
  const copy = source?.cloneNode(true);
  if (!source || !(copy instanceof Element)) return null;
  fillStuckZoneHeaders(source, copy);
  for (const element of [copy, ...copy.querySelectorAll('[id]')]) element.removeAttribute('id');
  return copy;
};
