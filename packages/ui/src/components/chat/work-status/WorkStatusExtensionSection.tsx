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
import { GuestStatusViewBody } from './WorkStatusGuestView';
import { useReportWorkStatusPresence } from './presenceContext';
import { extensionSectionId } from './sections';

const PluginPane = React.lazy(() => import('@/components/layout/PluginPane').then((module) => ({ default: module.PluginPane })));

const rememberedHeights = new Map<string, number>();

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
      iconNode={<GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={iconSrc} className="size-[13px] shrink-0 text-muted-foreground" />}
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
      {guest.statusSource ? (
        <div data-guest-status-body={guest.id}>
          <ErrorBoundary fallback={<div className="px-1 text-xs text-muted-foreground">{t('contextPanel.plugin.loadFailed')}</div>}>
            <GuestStatusViewBody
              key={`${guest.id}:${directory ?? ''}`}
              guestId={guest.id}
              source={guest.statusSource}
              directory={directory}
              onStatusControls={setStatusControls}
            />
          </ErrorBoundary>
        </div>
      ) : (
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
      )}
    </WorkStatusCollapsibleSection>
  );
};
