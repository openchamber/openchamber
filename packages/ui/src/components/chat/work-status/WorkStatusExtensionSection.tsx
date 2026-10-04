import React from 'react';
import { GUEST_STATUS_SECTION_HEIGHT_DEFAULT, clampStatusSectionHeight } from '@openchamber/sdk';

import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { useI18n } from '@/lib/i18n';
import type { InstalledGuest } from '@/lib/guests/types';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { pluginModeFromId } from '@/lib/surfaces/modes';
import type { GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSection } from './WorkStatusPrimitives';
import { StatusHeaderControls } from './StatusHeaderControls';
import { useReportWorkStatusPresence } from './presenceContext';
import { extensionSectionId } from './sections';

// Loaded only when an extension section is expanded; most panels never need it.
const PluginPane = React.lazy(() => import('@/components/layout/PluginPane').then((module) => ({ default: module.PluginPane })));

/**
 * Last height each extension's page asked for, for this app session. Folding a
 * section unmounts its frame; reopening starts at the height the page last had
 * instead of jumping from the manifest default. One number per installed
 * extension (keyed by id and version), so it stays tiny; not persisted.
 */
const rememberedHeights = new Map<string, number>();

/**
 * An extension's own section (`contributes.statusSection`): the host draws the
 * header from the extension's title and icon, the body is its sandboxed page.
 *
 * The frame exists only while the section is expanded — the collapsible drops
 * its children when folded, and the panel drops the section when it is hidden
 * or the panel itself is — so a folded section costs nothing. Its height is
 * what the guest last asked for through `setHeight`, clamped by the SDK range
 * and remembered for the session; taller content scrolls inside the frame.
 */
export const WorkStatusExtensionSection: React.FC<{
  guest: InstalledGuest;
  directory: string | null;
}> = ({ guest, directory }) => {
  const { t } = useI18n();
  const sectionId = extensionSectionId(guest.id);
  const expanded = useUIStore(React.useCallback(
    (state) => state.workStatusExpandedSections[sectionId] ?? (guest.statusDefaultExpanded ?? true),
    [guest.statusDefaultExpanded, sectionId],
  ));
  const visible = !guest.statusRequiresProject || Boolean(directory);
  useReportWorkStatusPresence(sectionId, visible);
  const heightKey = `${guest.id}@${guest.version ?? ''}`;
  const [height, setHeight] = React.useState(() => (
    rememberedHeights.get(heightKey) ?? clampStatusSectionHeight(guest.statusHeight ?? GUEST_STATUS_SECTION_HEIGHT_DEFAULT)
  ));
  const handleResize = React.useCallback((next: number) => {
    const clamped = clampStatusSectionHeight(next);
    rememberedHeights.set(heightKey, clamped);
    setHeight((current) => (current === clamped ? current : clamped));
  }, [heightKey]);
  const iconSrc = guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset);
  const [statusControls, setStatusControls] = React.useState<GuestStatusControlBinding | null>(null);
  const actionLayout = statusControls && statusControls.controls.length >= 3 ? 'below' : 'inline';

  if (!visible) return null;

  return (
    <WorkStatusCollapsibleSection
      id={sectionId}
      title={guest.statusTitle ?? guest.name}
      iconNode={<GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={iconSrc} className="size-4 shrink-0 text-muted-foreground" />}
      defaultExpanded={guest.statusDefaultExpanded ?? true}
      actionLayout={actionLayout}
      action={expanded && statusControls ? (
        <StatusHeaderControls
          controls={statusControls.controls}
          layout={actionLayout}
          onActivate={(id, value) => statusControls.dispatch(value === undefined ? { id } : { id, value })}
        />
      ) : undefined}
    >
      <div data-guest-status-body={guest.id} className="mx-1 overflow-hidden rounded-md" style={{ height }}>
        <ErrorBoundary fallback={<div className="px-1 text-xs text-muted-foreground">{t('contextPanel.plugin.loadFailed')}</div>}>
          <React.Suspense fallback={null}>
            <PluginPane
              mode={pluginModeFromId(guest.id)}
              surface="status"
              item={null}
              onResize={handleResize}
              statusDirectory={directory}
              onStatusControls={setStatusControls}
            />
          </React.Suspense>
        </ErrorBoundary>
      </div>
    </WorkStatusCollapsibleSection>
  );
};
