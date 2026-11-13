type MermaidViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MermaidViewport = {
  width: number;
  height: number;
};

type MermaidPoint = {
  x: number;
  y: number;
};

type MermaidViewerController = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  cleanup: () => void;
};

type InternalMermaidViewerController = MermaidViewerController & {
  viewport: HTMLElement;
  fitToViewport: (viewport: MermaidViewport) => void;
};

type MermaidSvgBoundsSource = {
  viewBox?: string | null;
  width?: string | number | null;
  height?: string | number | null;
};

const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

const parseSvgNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const match = String(value).trim().match(/^([+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?)(?:px)?$/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return isPositiveFinite(parsed) ? parsed : null;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const VIEW_BOX_PRECISION = 6;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_BASE = 1.0015;
const MIN_SCALE = 0.5;
const MAX_SCALE = 12;
const DRAG_CLICK_SUPPRESSION_THRESHOLD_PX = 3;
const DRAG_CLICK_SUPPRESSION_CLEAR_MS = 400;
export const MERMAID_BLOCK_SELECTOR = '[data-streamdown="mermaid-block"]';

export const formatMermaidViewBox = (box: MermaidViewBox): string => (
  [box.x, box.y, box.width, box.height]
    .map((value) => {
      const rounded = Number(value.toFixed(VIEW_BOX_PRECISION));
      return Object.is(rounded, -0) ? '0' : String(rounded);
    })
    .join(' ')
);

export const getMermaidSvgContentBox = (source: MermaidSvgBoundsSource): MermaidViewBox | null => {
  const viewBoxParts = source.viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map((part) => Number.parseFloat(part));
  if (viewBoxParts?.length === 4) {
    const [x, y, width, height] = viewBoxParts;
    if (
      Number.isFinite(x)
      && Number.isFinite(y)
      && isPositiveFinite(width)
      && isPositiveFinite(height)
    ) {
      return { x, y, width, height };
    }
  }

  const width = parseSvgNumber(source.width);
  const height = parseSvgNumber(source.height);
  if (width === null || height === null) {
    return null;
  }

  return { x: 0, y: 0, width, height };
};

export const fitMermaidViewBox = (contentBox: MermaidViewBox, viewport: MermaidViewport): MermaidViewBox => {
  if (!isPositiveFinite(viewport.width) || !isPositiveFinite(viewport.height)) {
    return contentBox;
  }

  const contentAspect = contentBox.width / contentBox.height;
  const viewportAspect = viewport.width / viewport.height;
  if (contentAspect > viewportAspect) {
    const height = contentBox.width / viewportAspect;
    return {
      x: contentBox.x,
      y: contentBox.y - (height - contentBox.height) / 2,
      width: contentBox.width,
      height,
    };
  }

  const width = contentBox.height * viewportAspect;
  return {
    x: contentBox.x - (width - contentBox.width) / 2,
    y: contentBox.y,
    width,
    height: contentBox.height,
  };
};

export const panMermaidViewBox = ({
  currentBox,
  viewport,
  delta,
}: {
  currentBox: MermaidViewBox;
  viewport: MermaidViewport;
  delta: MermaidPoint;
}): MermaidViewBox => {
  if (
    !isPositiveFinite(viewport.width)
    || !isPositiveFinite(viewport.height)
    || !isPositiveFinite(currentBox.width)
    || !isPositiveFinite(currentBox.height)
  ) {
    return currentBox;
  }

  return {
    x: currentBox.x - (delta.x / viewport.width) * currentBox.width,
    y: currentBox.y - (delta.y / viewport.height) * currentBox.height,
    width: currentBox.width,
    height: currentBox.height,
  };
};

export const hasMermaidPointerDragMoved = (start: MermaidPoint, current: MermaidPoint): boolean => {
  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  return (deltaX * deltaX) + (deltaY * deltaY) > (DRAG_CLICK_SUPPRESSION_THRESHOLD_PX * DRAG_CLICK_SUPPRESSION_THRESHOLD_PX);
};

export const getMermaidPinch = (points: readonly MermaidPoint[]): { distance: number; center: MermaidPoint } | null => {
  const [first, second] = points;
  if (!first || !second) return null;
  return {
    distance: Math.hypot(second.x - first.x, second.y - first.y),
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
  };
};

export const zoomMermaidViewBoxAtPoint = ({
  currentBox,
  contentBox,
  viewport,
  pointer,
  zoomFactor,
  minScale,
  maxScale,
}: {
  currentBox: MermaidViewBox;
  contentBox: MermaidViewBox;
  viewport: MermaidViewport;
  pointer: MermaidPoint;
  zoomFactor: number;
  minScale: number;
  maxScale: number;
}): MermaidViewBox => {
  if (
    !isPositiveFinite(viewport.width)
    || !isPositiveFinite(viewport.height)
    || !isPositiveFinite(zoomFactor)
    || !isPositiveFinite(currentBox.width)
    || !isPositiveFinite(currentBox.height)
    || !isPositiveFinite(contentBox.width)
    || !isPositiveFinite(contentBox.height)
    || !isPositiveFinite(minScale)
    || !isPositiveFinite(maxScale)
  ) {
    return currentBox;
  }

  const min = Math.min(minScale, maxScale);
  const max = Math.max(minScale, maxScale);
  const fittedBox = fitMermaidViewBox(contentBox, viewport);
  const currentScale = fittedBox.width / currentBox.width;
  const nextScale = clamp(currentScale * zoomFactor, min, max);
  const nextWidth = fittedBox.width / nextScale;
  const nextHeight = nextWidth / (currentBox.width / currentBox.height);
  const pointerRatioX = clamp(pointer.x / viewport.width, 0, 1);
  const pointerRatioY = clamp(pointer.y / viewport.height, 0, 1);
  const svgPointX = currentBox.x + pointerRatioX * currentBox.width;
  const svgPointY = currentBox.y + pointerRatioY * currentBox.height;

  return {
    x: svgPointX - pointerRatioX * nextWidth,
    y: svgPointY - pointerRatioY * nextHeight,
    width: nextWidth,
    height: nextHeight,
  };
};

const controllerByViewport = new WeakMap<HTMLElement, InternalMermaidViewerController>();
const activeControllers = new Set<InternalMermaidViewerController>();
let sharedResizeObserver: ResizeObserver | null = null;
let pendingResizeFrame: number | null = null;
const pendingInitialFit = new Set<InternalMermaidViewerController>();
let initialFitFrame: number | null = null;

const scheduleInitialFit = (controller: InternalMermaidViewerController): void => {
  pendingInitialFit.add(controller);
  if (initialFitFrame !== null) return;
  // Match the original viewer's two-frame settle, then read all sizes before
  // writing any viewBox. React supplies the controllers without a DOM scan.
  initialFitFrame = window.requestAnimationFrame(() => {
    initialFitFrame = window.requestAnimationFrame(() => {
      initialFitFrame = null;
      const controllers = Array.from(pendingInitialFit);
      pendingInitialFit.clear();
      fitControllers(controllers);
      for (const entry of controllers) registerController(entry);
    });
  });
};

const cancelInitialFit = (controller: InternalMermaidViewerController): void => {
  pendingInitialFit.delete(controller);
  if (pendingInitialFit.size === 0 && initialFitFrame !== null) {
    window.cancelAnimationFrame(initialFitFrame);
    initialFitFrame = null;
  }
};

const getSvgViewport = (block: HTMLElement): HTMLElement | null => (
  block.querySelector<HTMLElement>('[data-streamdown="mermaid-viewport"]')
    ?? block.querySelector<HTMLElement>('[data-streamdown="mermaid"]')
);

const getViewportSize = (viewport: HTMLElement): MermaidViewport => {
  const rect = viewport.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
};

const getPointerInViewport = (event: Pick<PointerEvent | WheelEvent, 'clientX' | 'clientY'>, viewport: HTMLElement): MermaidPoint => {
  const rect = viewport.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
};

const isPanExcludedTarget = (target: EventTarget | null): boolean => (
  target instanceof Element && Boolean(target.closest('button, a, [role="button"]'))
);

const fitControllers = (controllers: readonly InternalMermaidViewerController[]): void => {
  const viewportSizes = controllers.map((controller) => getViewportSize(controller.viewport));
  controllers.forEach((controller, index) => {
    const viewport = viewportSizes[index];
    if (viewport) controller.fitToViewport(viewport);
  });
};

const scheduleActiveControllerFit = (): void => {
  if (pendingResizeFrame !== null || activeControllers.size === 0) return;
  pendingResizeFrame = window.requestAnimationFrame(() => {
    pendingResizeFrame = null;
    fitControllers(Array.from(activeControllers));
  });
};

const ensureSharedResizeObserver = (): ResizeObserver | null => {
  if (sharedResizeObserver) return sharedResizeObserver;
  const ResizeObserverConstructor = globalThis.ResizeObserver;
  if (!ResizeObserverConstructor) return null;
  sharedResizeObserver = new ResizeObserverConstructor((entries) => {
    for (const entry of entries) {
      if (!(entry.target instanceof HTMLElement)) continue;
      controllerByViewport.get(entry.target)?.fitToViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    }
  });
  return sharedResizeObserver;
};

const registerController = (controller: InternalMermaidViewerController): void => {
  if (activeControllers.has(controller)) return;
  const wasEmpty = activeControllers.size === 0;
  activeControllers.add(controller);
  controllerByViewport.set(controller.viewport, controller);
  ensureSharedResizeObserver()?.observe(controller.viewport);
  if (wasEmpty) window.addEventListener('resize', scheduleActiveControllerFit);
};

const unregisterController = (controller: InternalMermaidViewerController): void => {
  if (!activeControllers.delete(controller)) return;
  sharedResizeObserver?.unobserve(controller.viewport);
  controllerByViewport.delete(controller.viewport);
  if (activeControllers.size > 0) return;
  sharedResizeObserver?.disconnect();
  sharedResizeObserver = null;
  window.removeEventListener('resize', scheduleActiveControllerFit);
  if (pendingResizeFrame !== null) {
    window.cancelAnimationFrame(pendingResizeFrame);
    pendingResizeFrame = null;
  }
};

export const createMermaidViewerController = (block: HTMLElement): MermaidViewerController | null => {
  const viewport = getSvgViewport(block);
  const svg = block.querySelector<SVGSVGElement>('[data-streamdown="mermaid"] svg');
  if (!viewport || !svg) {
    return null;
  }

  const contentBox = getMermaidSvgContentBox({
    viewBox: svg.getAttribute('data-oc-mermaid-original-viewbox') ?? svg.getAttribute('viewBox'),
    width: svg.getAttribute('width'),
    height: svg.getAttribute('height'),
  });
  if (!contentBox) {
    // Unrecognized bounds leave the renderer's native SVG visible.
    svg.setAttribute('data-oc-mermaid-fitted', '');
    return null;
  }
  // Preview sizing must not read the user-controlled viewBox as content bounds.
  svg.setAttribute('data-oc-mermaid-original-viewbox', formatMermaidViewBox(contentBox));

  let currentBox = contentBox;
  let activePointerId: number | null = null;
  let dragStartPointer: MermaidPoint | null = null;
  let lastPointer: MermaidPoint | null = null;
  let clearClickSuppressionTimer: number | null = null;
  // Every pointer pressed on the diagram; a second one turns the pan into a pinch.
  const pressedPointers = new Map<number, MermaidPoint>();
  let lastPinchDistance: number | null = null;

  const applyViewBox = (box: MermaidViewBox): void => {
    currentBox = box;
    svg.setAttribute('viewBox', formatMermaidViewBox(box));
    svg.removeAttribute('width');
    svg.removeAttribute('height');
  };

  const fitToViewport = (size: MermaidViewport): void => {
    // Hidden/zero-size containers are not ready. ResizeObserver retries when
    // the viewport acquires geometry; never reveal the unfitted first frame.
    if (!isPositiveFinite(size.width) || !isPositiveFinite(size.height)) return;
    applyViewBox(fitMermaidViewBox(contentBox, size));
    svg.setAttribute('data-oc-mermaid-fitted', '');
  };

  const fit = (): void => {
    cancelInitialFit(controller);
    fitToViewport(getViewportSize(viewport));
    registerController(controller);
  };

  const activate = (): void => {
    if (pendingInitialFit.has(controller)) fit();
  };

  const zoomAt = (pointer: MermaidPoint, zoomFactor: number): void => {
    activate();
    applyViewBox(zoomMermaidViewBoxAtPoint({
      currentBox,
      contentBox,
      viewport: getViewportSize(viewport),
      pointer,
      zoomFactor,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
    }));
  };

  const zoomIn = (): void => {
    const size = getViewportSize(viewport);
    zoomAt({ x: size.width / 2, y: size.height / 2 }, ZOOM_STEP);
  };

  const zoomOut = (): void => {
    const size = getViewportSize(viewport);
    zoomAt({ x: size.width / 2, y: size.height / 2 }, 1 / ZOOM_STEP);
  };

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    zoomAt(getPointerInViewport(event, viewport), Math.pow(WHEEL_ZOOM_BASE, -event.deltaY));
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || isPanExcludedTarget(event.target)) {
      return;
    }
    activate();
    // A primary pointer starts a new gesture, so a lost pointerup cannot leave
    // a stale finger behind that would turn the next pan into a pinch.
    if (event.isPrimary) {
      pressedPointers.clear();
      lastPinchDistance = null;
    }
    pressedPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pressedPointers.size > 1) {
      activePointerId = null;
      lastPinchDistance = getMermaidPinch(Array.from(pressedPointers.values()))?.distance ?? null;
      viewport.setPointerCapture?.(event.pointerId);
      block.setAttribute('data-mermaid-suppress-click', 'true');
      event.preventDefault();
      return;
    }
    activePointerId = event.pointerId;
    dragStartPointer = { x: event.clientX, y: event.clientY };
    lastPointer = dragStartPointer;
    if (clearClickSuppressionTimer !== null) {
      window.clearTimeout(clearClickSuppressionTimer);
      clearClickSuppressionTimer = null;
    }
    block.removeAttribute('data-mermaid-suppress-click');
    viewport.setPointerCapture?.(event.pointerId);
    block.setAttribute('data-mermaid-panning', 'true');
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent): void => {
    const nextPointer = { x: event.clientX, y: event.clientY };
    if (lastPinchDistance !== null && pressedPointers.has(event.pointerId)) {
      pressedPointers.set(event.pointerId, nextPointer);
      const pinch = getMermaidPinch(Array.from(pressedPointers.values()));
      if (pinch) {
        const center = getPointerInViewport({ clientX: pinch.center.x, clientY: pinch.center.y }, viewport);
        zoomAt(center, pinch.distance / lastPinchDistance);
        lastPinchDistance = pinch.distance;
      }
      event.preventDefault();
      return;
    }
    if (activePointerId !== event.pointerId || !lastPointer) {
      return;
    }
    applyViewBox(panMermaidViewBox({
      currentBox,
      viewport: getViewportSize(viewport),
      delta: {
        x: nextPointer.x - lastPointer.x,
        y: nextPointer.y - lastPointer.y,
      },
    }));
    lastPointer = nextPointer;
    if (dragStartPointer && hasMermaidPointerDragMoved(dragStartPointer, nextPointer)) {
      block.setAttribute('data-mermaid-suppress-click', 'true');
    }
    event.preventDefault();
  };

  const stopPan = (event: PointerEvent): void => {
    if (!pressedPointers.delete(event.pointerId)) {
      return;
    }
    viewport.releasePointerCapture?.(event.pointerId);
    if (pressedPointers.size > 0) {
      // A finger left after a pinch does not pan, so the view does not jump
      // when the other one lifts.
      activePointerId = null;
      lastPinchDistance = pressedPointers.size > 1
        ? getMermaidPinch(Array.from(pressedPointers.values()))?.distance ?? null
        : null;
      return;
    }
    lastPinchDistance = null;
    activePointerId = null;
    dragStartPointer = null;
    lastPointer = null;
    block.removeAttribute('data-mermaid-panning');
    if (block.hasAttribute('data-mermaid-suppress-click')) {
      clearClickSuppressionTimer = window.setTimeout(() => {
        block.removeAttribute('data-mermaid-suppress-click');
        clearClickSuppressionTimer = null;
      }, DRAG_CLICK_SUPPRESSION_CLEAR_MS);
    }
  };

  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', stopPan);
  viewport.addEventListener('pointercancel', stopPan);
  const controller: InternalMermaidViewerController = {
    viewport,
    zoomIn,
    zoomOut,
    fit,
    fitToViewport,
    cleanup: () => {
      cancelInitialFit(controller);
      unregisterController(controller);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', stopPan);
      viewport.removeEventListener('pointercancel', stopPan);
      if (clearClickSuppressionTimer !== null) {
        window.clearTimeout(clearClickSuppressionTimer);
      }
      pressedPointers.clear();
      block.removeAttribute('data-mermaid-panning');
      block.removeAttribute('data-mermaid-suppress-click');
    },
  };
  scheduleInitialFit(controller);
  return controller;
};
