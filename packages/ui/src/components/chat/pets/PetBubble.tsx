/**
 * The ambient pet companion, styled to match the Codex terminal pet: the
 * sprite sits above the composer on the right, 96px tall, with no background
 * or border of its own. Status and the last assistant reply preview are shown
 * as speech bubbles above it.
 *
 * Runtime split: on the Electron desktop the pet lives in its own
 * always-on-top overlay window (PetOverlayBridge + PetOverlay), so this
 * component renders nothing there. On web/VS Code/mobile it renders inside
 * the chat column. Long-pressing the pet drags it around; the position is
 * persisted locally per runtime.
 *
 * The pet renders whenever the `showPet` setting is on. Asset failures are
 * explicit: a failed download shows an offline placeholder (never a fake
 * "loaded" pet) and retries on the next session.
 */

import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { isElectronShell } from '@/lib/desktop';
import { cn } from '@/lib/utils';
import {
    FRAME_HEIGHT,
    FRAME_WIDTH,
    SPRITESHEET_COLUMNS,
    animationForState,
    frameIndexAtElapsed,
} from './animations';
import { getPetAssetImage, usePetAsset } from './petAssetStore';
import { usePetPreference } from './petPreference';
import { usePetState } from './usePetState';
import { loadCustomPetSprite, resolvePet, useAllPets, type CustomPetCatalogEntry } from './customPets';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { usePetDrag } from './usePetDrag';
import { usePetAssistantPreview } from './usePetAssistantPreview';
import { BUBBLE_FLIP_DEAD_ZONE_PX, PetStatusBubble, type BubbleAlign } from './PetStatusBubble';

/** Codex PET_TARGET_HEIGHT_PX, scaled up; width keeps the 192:208 frame aspect. */
const DISPLAY_HEIGHT = 96;

const INLINE_POSITION_KEY = 'openchamber.petInlinePosition';

interface InlinePosition {
    x: number;
    y: number;
}

function readInlinePosition(): InlinePosition {
    try {
        const raw = window.localStorage.getItem(INLINE_POSITION_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as Partial<InlinePosition>;
            if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
                return { x: parsed.x as number, y: parsed.y as number };
            }
        }
    } catch {
        // Storage unavailable (privacy mode etc.): fall back to the default.
    }
    return { x: 0, y: 0 };
}

function persistInlinePosition(position: InlinePosition) {
    try {
        window.localStorage.setItem(INLINE_POSITION_KEY, JSON.stringify(position));
    } catch {
        // Non-fatal: the position just does not persist this time.
    }
}

/**
 * Which side of the pet the bubble hangs from. The container is anchored
 * `right-3` (12px from the viewport's right edge) and translated by the drag
 * offset; the sprite sits flush to the container's right edge, so its
 * horizontal center is independent of the bubble width. Once that center
 * crosses the viewport midline (beyond the dead zone), the bubble flips to
 * the opposite side so it never overflows the screen edge the pet is dragged
 * toward.
 */
function resolveInlineBubbleAlign(offsetX: number, viewportWidth: number, petWidth: number, previous: BubbleAlign): BubbleAlign {
    const petCenterX = viewportWidth - 12 + offsetX - petWidth / 2;
    const midline = viewportWidth / 2;
    if (petCenterX > midline + BUBBLE_FLIP_DEAD_ZONE_PX) return 'right';
    if (petCenterX < midline - BUBBLE_FLIP_DEAD_ZONE_PX) return 'left';
    return previous;
}

export function PetBubble() {
    const { t } = useI18n();
    const showPet = useUIStore((state) => state.showPet);
    const petSize = useUIStore((state) => state.petSize);
    const petId = usePetPreference();
    const state = usePetState();
    const preview = usePetAssistantPreview();
    const { custom: customPets } = useAllPets();
    const runtimeApis = useRuntimeAPIs();
    const pet = React.useMemo(() => resolvePet(petId, customPets), [petId, customPets]);
    const makeLoader = React.useCallback(
        (target: typeof pet) => {
            if (target && 'isCustom' in target && runtimeApis?.files?.readFileBinary) {
                return () => loadCustomPetSprite(runtimeApis.files, target as CustomPetCatalogEntry);
            }
            return undefined;
        },
        [runtimeApis],
    );
    const loadSprite = React.useMemo(() => makeLoader(pet), [makeLoader, pet]);
    const assetStatus = usePetAsset(pet, loadSprite);
    const petRef = React.useRef<HTMLDivElement>(null);

    const displayHeight = Math.round(DISPLAY_HEIGHT * petSize);
    const displayWidth = Math.round(displayHeight * FRAME_WIDTH / FRAME_HEIGHT);

    // Long-press drag: move the pet within the chat column and remember the
    // offset locally so it stays where the user put it.
    const [offset, setOffset] = React.useState<InlinePosition>(readInlinePosition);
    const offsetRef = React.useRef(offset);
    offsetRef.current = offset;
    const drag = usePetDrag({
        onDragMove: (dx, dy) => setOffset((prev) => {
            const next = { x: prev.x + dx, y: prev.y + dy };
            offsetRef.current = next;
            return next;
        }),
        onDragEnd: () => persistInlinePosition(offsetRef.current),
    });

    // Start on the correct side for the persisted position instead of flashing
    // the default side for a frame after a reload.
    const [bubbleAlign, setBubbleAlign] = React.useState<BubbleAlign>(() =>
        resolveInlineBubbleAlign(readInlinePosition().x, window.innerWidth, displayWidth, 'right'),
    );

    // Re-resolve on drag movement (offset.x) and on viewport resize, keeping
    // the last side inside the dead zone (hysteresis).
    const refreshBubbleAlign = React.useCallback(() => {
        setBubbleAlign((previous) =>
            resolveInlineBubbleAlign(offsetRef.current.x, window.innerWidth, displayWidth, previous),
        );
    }, [displayWidth]);

    React.useEffect(() => {
        refreshBubbleAlign();
    }, [refreshBubbleAlign, offset.x]);

    React.useEffect(() => {
        window.addEventListener('resize', refreshBubbleAlign);
        return () => window.removeEventListener('resize', refreshBubbleAlign);
    }, [refreshBubbleAlign]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const image = React.useMemo(() => (pet ? getPetAssetImage(pet.id) : null), [assetStatus, pet]);

    React.useEffect(() => {
        if (!image || !petRef.current) return;
        const el = petRef.current;

        const track = animationForState(state);
        let raf = 0;
        let start = performance.now();

        const draw = (now: number) => {
            const frameIndex = frameIndexAtElapsed(track, now - start);
            const sprite = track.frames[frameIndex];
            const sx = (sprite % SPRITESHEET_COLUMNS) * displayWidth;
            const sy = Math.floor(sprite / SPRITESHEET_COLUMNS) * displayHeight;
            el.style.backgroundPosition = `-${sx}px -${sy}px`;
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
    }, [image, state, displayHeight, displayWidth]);

    // On the desktop the pet is rendered by the always-on-top overlay window;
    // rendering here too would show a second copy inside the app.
    if (isElectronShell() || runtimeApis?.runtime?.platform === 'desktop' || !showPet) {
        return null;
    }

    return (
        <div
            {...drag.pointerProps}
            className={cn(
                'absolute right-3 bottom-full mb-2.5 z-30 flex touch-none select-none flex-col gap-1.5 bg-transparent outline-none',
                bubbleAlign === 'left' ? 'items-start' : 'items-end',
                drag.isDragging ? 'cursor-grabbing' : 'cursor-grab',
            )}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
        >
            <PetStatusBubble
                key={bubbleAlign}
                align={bubbleAlign}
                state={state}
                preview={preview}
                petSize={petSize}
                capToViewportHalf
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
    );
}
