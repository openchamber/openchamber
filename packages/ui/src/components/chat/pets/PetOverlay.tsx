/**
 * The pet rendered inside the desktop always-on-top overlay window
 * (`pet-overlay.html`). It receives its display inputs — pet id, status
 * state, size, and the assistant-reply preview — from the main window via the
 * `pet-overlay-update` native event, because the authoritative state lives in
 * the main app's stores. Pressing drags the window by reporting absolute
 * screen coordinates to the main process (`pet_overlay_move_to`), which moves
 * and persists the window position.
 *
 * The window is transparent and frameless, so this component owns the whole
 * page: the bubble column above the sprite, nothing else. Hovering the pet in
 * an idle session plays a happy reaction animation; dragging plays the running
 * animation.
 */

import React from 'react';
import { useI18n } from '@/lib/i18n';
import { invokeDesktop } from '@/lib/desktop';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { cn } from '@/lib/utils';
import {
    FRAME_HEIGHT,
    FRAME_WIDTH,
    SPRITESHEET_COLUMNS,
    animationForState,
    frameIndexAtElapsed,
    trackDuration,
    type PetAnimationState,
    type PetDisplayState,
} from './animations';
import { DEFAULT_PET_ID } from './catalog';
import { getPetAssetImage, usePetAsset } from './petAssetStore';
import {
    loadCustomPetSprite,
    resolvePet,
    scanCustomPets,
    type CustomPetCatalogEntry,
} from './customPets';
import { usePetDrag } from './usePetDrag';
import { BUBBLE_FLIP_DEAD_ZONE_PX, PetStatusBubble, type BubbleAlign } from './PetStatusBubble';

/** Codex PET_TARGET_HEIGHT_PX, scaled up; width keeps the 192:208 frame aspect. */
const DISPLAY_HEIGHT = 96;

/** A display work area (in screen coordinates), pushed by the main process. */
interface WorkArea {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Which side of the pet the bubble hangs from: once the window's center
 * crosses the midline of the display work area it is clamped to (beyond the
 * dead zone), the bubble flips to the opposite side so it never overflows the
 * screen edge the window is dragged toward.
 */
function resolveOverlayBubbleAlign(windowCenterX: number, workAreaCenterX: number, previous: BubbleAlign): BubbleAlign {
    if (windowCenterX > workAreaCenterX + BUBBLE_FLIP_DEAD_ZONE_PX) return 'right';
    if (windowCenterX < workAreaCenterX - BUBBLE_FLIP_DEAD_ZONE_PX) return 'left';
    return previous;
}

/**
 * Vertical space reserved above the sprite for the status bubble column.
 * The main process sizes the overlay window with this same constant (see
 * main.mjs) so the bubble never gets clipped. Fits the tallest bubble:
 * 3 preview lines at the clamped 1rem body font (3 * 16 * 1.625 = 78px)
 * plus py-1.5 padding (24px), borders (2px), and the gap to the sprite (6px).
 */
export const PET_OVERLAY_BUBBLE_SPACE_HEIGHT = 112;

const VALID_STATES: readonly PetDisplayState[] = ['running', 'needs-input', 'ready', 'blocked'];

interface OverlayPetState {
    petId: string;
    state: PetDisplayState;
    petSize: number;
    preview: string | null;
}

function sanitizeOverlayState(payload: unknown): OverlayPetState | null {
    if (!payload || typeof payload !== 'object') return null;
    const candidate = payload as Record<string, unknown>;
    const petId = typeof candidate.petId === 'string' && candidate.petId ? candidate.petId : DEFAULT_PET_ID;
    const state = VALID_STATES.includes(candidate.state as PetDisplayState)
        ? (candidate.state as PetDisplayState)
        : 'ready';
    const rawSize = typeof candidate.petSize === 'number' ? candidate.petSize : 1;
    const petSize = Math.max(0.5, Math.min(1.5, rawSize));
    const preview = typeof candidate.preview === 'string' ? candidate.preview : null;
    return { petId, state, petSize, preview };
}

function readHomeDirectory(): string {
    if (typeof window === 'undefined') return '';
    const home = (window as unknown as { __OPENCHAMBER_HOME__?: string }).__OPENCHAMBER_HOME__;
    return typeof home === 'string' ? home : '';
}

export function PetOverlay() {
    const { t } = useI18n();
    const runtimeApis = useRuntimeAPIs();
    const [display, setDisplay] = React.useState<OverlayPetState>(() => ({
        petId: DEFAULT_PET_ID,
        state: 'ready',
        petSize: 1,
        preview: null,
    }));
    const [customPets, setCustomPets] = React.useState<CustomPetCatalogEntry[]>([]);
    const [isHovered, setIsHovered] = React.useState(false);
    const [hoverPlayedOnce, setHoverPlayedOnce] = React.useState(false);
    const petRef = React.useRef<HTMLDivElement>(null);

    // The display work area the window is currently clamped to, pushed by the
    // main process whenever the window is created or moved
    // (`pet-overlay-work-area`). Falls back to the primary display until the
    // first push arrives.
    const workAreaRef = React.useRef<WorkArea | null>(null);

    React.useEffect(() => {
        const onWorkArea = (event: Event) => {
            const detail = (event as CustomEvent).detail as Record<string, unknown> | null;
            if (
                detail &&
                typeof detail.x === 'number' &&
                typeof detail.y === 'number' &&
                typeof detail.width === 'number' &&
                typeof detail.height === 'number'
            ) {
                workAreaRef.current = { x: detail.x, y: detail.y, width: detail.width, height: detail.height };
            }
        };
        window.addEventListener('pet-overlay-work-area', onWorkArea);
        return () => window.removeEventListener('pet-overlay-work-area', onWorkArea);
    }, []);

    // Flip the bubble side in lockstep with the window position. The window
    // moves only on drag or on startup restore (both driven by the main
    // process), so a rAF loop reading window.screenX is cheap and always in
    // sync; the ref keeps the flip from re-rendering every frame.
    const [bubbleAlign, setBubbleAlign] = React.useState<BubbleAlign>('right');
    const bubbleAlignRef = React.useRef<BubbleAlign>('right');

    React.useEffect(() => {
        let raf = 0;
        const tick = () => {
            raf = requestAnimationFrame(tick);
            const area = workAreaRef.current;
            const windowCenterX = window.screenX + window.outerWidth / 2;
            // Primary-display fallback only until the main process pushes the
            // real work area (the primary display's work area starts at x=0).
            const workAreaCenterX = area
                ? area.x + area.width / 2
                : window.screen.availWidth / 2;
            const next = resolveOverlayBubbleAlign(windowCenterX, workAreaCenterX, bubbleAlignRef.current);
            if (next !== bubbleAlignRef.current) {
                bubbleAlignRef.current = next;
                setBubbleAlign(next);
            }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, []);

    // The main window pushes the authoritative display state over the native
    // bridge; the initial snapshot is replayed by the main process when the
    // window is created/shown, so defaults here are only a placeholder.
    React.useEffect(() => {
        const onUpdate = (payload: unknown) => {
            const next = sanitizeOverlayState(payload);
            if (next) setDisplay(next);
        };
        const onEvent = (event: Event) => onUpdate((event as CustomEvent).detail);
        window.addEventListener('pet-overlay-update', onEvent);
        return () => window.removeEventListener('pet-overlay-update', onEvent);
    }, []);

    // Scan the user's custom pets directory; the overlay shares the main
    // window's origin so the IndexedDB sprite cache is shared as well.
    const homeDirectory = React.useMemo(readHomeDirectory, []);
    React.useEffect(() => {
        if (!homeDirectory || !runtimeApis?.files?.listDirectory) {
            setCustomPets([]);
            return;
        }
        let cancelled = false;
        scanCustomPets(runtimeApis.files, homeDirectory)
            .then((pets) => {
                if (!cancelled) setCustomPets(pets);
            })
            .catch(() => {
                if (!cancelled) setCustomPets([]);
            });
        return () => {
            cancelled = true;
        };
    }, [homeDirectory, runtimeApis?.files]);

    const pet = React.useMemo(
        () => resolvePet(display.petId, customPets),
        [display.petId, customPets],
    );
    const makeLoader = React.useCallback(
        (target: ReturnType<typeof resolvePet>) => {
            if (target && 'isCustom' in target && runtimeApis?.files?.readFileBinary) {
                return () => loadCustomPetSprite(runtimeApis.files, target as CustomPetCatalogEntry);
            }
            return undefined;
        },
        [runtimeApis],
    );
    const loadSprite = React.useMemo(() => makeLoader(pet), [makeLoader, pet]);
    const assetStatus = usePetAsset(pet, loadSprite);

    const displayHeight = Math.round(DISPLAY_HEIGHT * display.petSize);
    const displayWidth = Math.round(displayHeight * FRAME_WIDTH / FRAME_HEIGHT);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const image = React.useMemo(() => (pet ? getPetAssetImage(pet.id) : null), [assetStatus, pet]);

    // The overlay window is created with setIgnoreMouseEvents(true) so
    // transparent areas are click-through. Only the content wrapper (bubble
    // + sprite) is interactive: while the mouse is over it we disable
    // click-through so pointer events (drag) work, and restore it once the
    // mouse leaves. During an active drag we stay interactive even if the
    // pointer leaves the content wrapper.
    const interactiveRef = React.useRef<HTMLDivElement>(null);
    const interactiveStateRef = React.useRef(false);
    const isDraggingRef = React.useRef(false);

    const setInteractive = React.useCallback((next: boolean) => {
        if (interactiveStateRef.current === next) return;
        interactiveStateRef.current = next;
        void invokeDesktop(next ? 'pet_overlay_set_interactive' : 'pet_overlay_set_noninteractive');
    }, []);

    const handleMouseEnter = React.useCallback(() => {
        setInteractive(true);
        setIsHovered(true);
        setHoverPlayedOnce(false);
    }, [setInteractive]);

    const handleMouseLeave = React.useCallback(() => {
        if (!isDraggingRef.current) {
            setIsHovered(false);
            setHoverPlayedOnce(false);
            setInteractive(false);
        }
    }, [setInteractive]);

    // Drag moves the overlay window itself through the main process, which
    // also persists the resting position. Unlike the in-app pet, the desktop
    // pet starts dragging on press (no long-press) so it feels like grabbing
    // a floating window. Moves are coalesced to rAF frames to keep the drag
    // smooth and avoid IPC spam.
    const pendingMoveRef = React.useRef<{ x: number; y: number } | null>(null);
    const moveRafRef = React.useRef(0);

    const flushPendingMove = React.useCallback(() => {
        if (moveRafRef.current) {
            cancelAnimationFrame(moveRafRef.current);
            moveRafRef.current = 0;
        }
        const next = pendingMoveRef.current;
        pendingMoveRef.current = null;
        if (next) {
            void invokeDesktop('pet_overlay_move_to', next);
        }
    }, []);

    const drag = usePetDrag({
        longPressMs: 0,
        onDragStart: () => {
            isDraggingRef.current = true;
            setIsHovered(false);
            setInteractive(true);
        },
        onDragMoveTo: (x, y) => {
            pendingMoveRef.current = { x, y };
            if (moveRafRef.current) return;
            moveRafRef.current = requestAnimationFrame(() => {
                moveRafRef.current = 0;
                const next = pendingMoveRef.current;
                pendingMoveRef.current = null;
                if (next) {
                    void invokeDesktop('pet_overlay_move_to', next);
                }
            });
        },
        onDragEnd: () => {
            isDraggingRef.current = false;
            flushPendingMove();
        },
    });

    React.useEffect(() => {
        return () => {
            if (moveRafRef.current) {
                cancelAnimationFrame(moveRafRef.current);
            }
        };
    }, []);

    // After a drag ends, check whether the pointer is still inside the
    // content wrapper. If not, restore click-through immediately.
    const handlePointerUp = React.useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            drag.pointerProps.onPointerUp(event);
            const wrapper = interactiveRef.current;
            const stillOver = wrapper !== null && wrapper.contains(document.elementFromPoint(event.clientX, event.clientY));
            setIsHovered(stillOver);
            if (stillOver) {
                setHoverPlayedOnce(false);
            }
            if (!isDraggingRef.current) {
                setInteractive(stillOver);
            }
        },
        [drag.pointerProps, setInteractive],
    );

    // Fallback to forwarded mouse-move messages: even if mouseenter/leave
    // events are flaky over the transparent window, re-assert the interactive
    // state from the element under the cursor (rAF-throttled).
    React.useEffect(() => {
        if (typeof document === 'undefined') return;
        let raf = 0;
        let wasOver = false;
        const onMouseMove = (event: MouseEvent) => {
            if (raf) return;
            raf = window.requestAnimationFrame(() => {
                raf = 0;
                if (isDraggingRef.current) return;
                const wrapper = interactiveRef.current;
                const over = wrapper !== null && wrapper.contains(document.elementFromPoint(event.clientX, event.clientY));
                setIsHovered(over);
                if (over && !wasOver) {
                    setHoverPlayedOnce(false);
                }
                wasOver = over;
                setInteractive(over);
            });
        };
        document.addEventListener('mousemove', onMouseMove, true);
        return () => {
            if (raf) window.cancelAnimationFrame(raf);
            document.removeEventListener('mousemove', onMouseMove, true);
        };
    }, [setInteractive]);

    const animationState: PetAnimationState = React.useMemo(() => {
        if (drag.isDragging) return 'running';
        if (isHovered && display.state === 'ready' && !hoverPlayedOnce) return 'hover';
        return display.state;
    }, [drag.isDragging, isHovered, hoverPlayedOnce, display.state]);

    React.useEffect(() => {
        if (!image || !petRef.current) return;
        const el = petRef.current;

        const track = animationForState(animationState);
        let raf = 0;
        let start = performance.now();

        const draw = (now: number) => {
            const elapsed = now - start;
            const frameIndex = frameIndexAtElapsed(track, elapsed);
            const sprite = track.frames[frameIndex];
            const sx = (sprite % SPRITESHEET_COLUMNS) * displayWidth;
            const sy = Math.floor(sprite / SPRITESHEET_COLUMNS) * displayHeight;
            el.style.backgroundPosition = `-${sx}px -${sy}px`;

            // One-shot hover reaction: after the track completes, return to idle.
            if (animationState === 'hover' && track.loopStart === null && elapsed >= trackDuration(track)) {
                setHoverPlayedOnce(true);
                return;
            }
            raf = requestAnimationFrame(draw);
        };

        const onVisibility = () => {
            cancelAnimationFrame(raf);
            if (!document.hidden) {
                start = performance.now();
                raf = requestAnimationFrame(draw);
            }
        };

        raf = requestAnimationFrame(draw);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            cancelAnimationFrame(raf);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [image, animationState, displayHeight, displayWidth]);

    return (
        <div className="flex h-full w-full flex-col items-end justify-end overflow-visible select-none">
            <div
                ref={interactiveRef}
                {...drag.pointerProps}
                onPointerUp={handlePointerUp}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                className={cn(
                    'flex w-max touch-none select-none flex-col gap-1.5 bg-transparent outline-none',
                    bubbleAlign === 'left' ? 'items-start' : 'items-end',
                    drag.isDragging ? 'cursor-grabbing' : 'cursor-grab',
                )}
            >
                <PetStatusBubble
                    key={bubbleAlign}
                    align={bubbleAlign}
                    state={display.state}
                    preview={display.preview}
                    petSize={display.petSize}
                    translucent
                />
                {assetStatus === 'ok' && image ? (
                    <div
                        ref={petRef}
                        className="outline-none"
                        style={{
                            height: displayHeight,
                            width: displayWidth,
                            backgroundImage: `url(${image.src})`,
                            backgroundSize: `${SPRITESHEET_COLUMNS * displayWidth}px ${9 * displayHeight}px`,
                            backgroundPosition: '0 0',
                            backgroundRepeat: 'no-repeat',
                        }}
                        aria-hidden="true"
                    />
                ) : (
                    <div
                        className="flex items-center justify-center bg-transparent outline-none"
                        style={{ height: displayHeight, width: displayWidth }}
                    >
                        <span className="text-xs text-muted-foreground">
                            {assetStatus === 'failed' ? t('chat.pets.unavailable') : t('chat.pets.loading')}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
