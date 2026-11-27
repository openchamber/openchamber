import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CognitiveMapCanvas } from '@/components/chat/a2ui/cogmap/CognitiveMapCanvas';
import type {
  CogMapLadderingIntent,
  CogMapMutationPayload,
  CogMapNode,
  CogMapPacing,
} from '@/components/chat/a2ui/cogmap/types';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { dispatchCogMapLaddering, useCogMapStore } from '@/stores/useCogMapStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

interface CognitiveMapViewProps {
  visible?: boolean;
}

export const CognitiveMapView: React.FC<CognitiveMapViewProps> = ({ visible = true }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const effectiveDirectory = useEffectiveDirectory() ?? '';

  const sessionState = useCogMapStore((state) => (currentSessionId ? state.sessions[currentSessionId] : undefined));
  const selectedMapId = useCogMapStore((state) => (currentSessionId ? state.selectedMapIdBySession[currentSessionId] : null));
  const lastSyncedByKey = useCogMapStore((state) => state.lastSyncedByKey);
  const draftModeActive = useCogMapStore((state) => state.draftModeActive);
  const draftPacing = useCogMapStore((state) => state.draftPacing);
  const fetchSessionMaps = useCogMapStore((state) => state.fetchSessionMaps);
  const mutateMap = useCogMapStore((state) => state.mutateMap);
  const setSessionMode = useCogMapStore((state) => state.setSessionMode);
  const setDraftMode = useCogMapStore((state) => state.setDraftMode);
  const setSelectedMapId = useCogMapStore((state) => state.setSelectedMapId);

  const [creating, setCreating] = React.useState(false);
  const [newMapTitle, setNewMapTitle] = React.useState('');

  React.useEffect(() => {
    if (!visible || !currentSessionId) return;
    void fetchSessionMaps(currentSessionId);
  }, [currentSessionId, fetchSessionMaps, visible]);

  const maps = React.useMemo(() => {
    const record = sessionState?.maps ?? {};
    return Object.values(record).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessionState?.maps]);

  const activeMap = React.useMemo(() => {
    if (maps.length === 0) return null;
    if (selectedMapId && sessionState?.maps[selectedMapId]) return sessionState.maps[selectedMapId];
    if (sessionState?.activeMapId && sessionState.maps[sessionState.activeMapId]) {
      return sessionState.maps[sessionState.activeMapId];
    }
    return maps[0] ?? null;
  }, [maps, selectedMapId, sessionState?.activeMapId, sessionState?.maps]);

  const hasUnsyncedEdits = React.useMemo(() => {
    if (!currentSessionId || !activeMap) return false;
    const synced = lastSyncedByKey[`${currentSessionId}\u0000${activeMap.id}`];
    if (!synced) return activeMap.nodes.length > 0;
    return synced.rev !== activeMap.rev;
  }, [activeMap, currentSessionId, lastSyncedByKey]);

  const modeActive = currentSessionId ? Boolean(sessionState?.modeActive) : draftModeActive;
  const pacing: CogMapPacing = currentSessionId ? (sessionState?.pacing ?? 'collab') : draftPacing;

  const handleCreateMap = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentSessionId) return;
    const title = newMapTitle.trim() || 'Cognitive Map';
    const created = await mutateMap(
      currentSessionId,
      {
        title,
        pacing,
        addNodes: [{ label: title, role: 'goal' }],
      },
      effectiveDirectory || null,
    );
    if (created) {
      setSelectedMapId(currentSessionId, created.id);
      setNewMapTitle('');
      setCreating(false);
    }
  };

  const handleMutate = React.useCallback(
    async (payload: CogMapMutationPayload) => {
      if (!currentSessionId || !activeMap) return;
      await mutateMap(
        currentSessionId,
        { ...payload, mapId: activeMap.id },
        effectiveDirectory || null,
      );
    },
    [activeMap, currentSessionId, effectiveDirectory, mutateMap],
  );

  const handleLadder = React.useCallback(
    async (intent: CogMapLadderingIntent, node: CogMapNode) => {
      if (!currentSessionId || !effectiveDirectory || !activeMap) return;
      await dispatchCogMapLaddering({
        sessionId: currentSessionId,
        directory: effectiveDirectory,
        mapId: activeMap.id,
        node,
        intent,
      });
    },
    [activeMap, currentSessionId, effectiveDirectory],
  );

  const handlePacingChange = React.useCallback(
    (nextPacing: CogMapPacing) => {
      if (!currentSessionId) {
        setDraftMode(true, nextPacing);
        return;
      }
      void setSessionMode(currentSessionId, {
        active: true,
        pacing: nextPacing,
        activeMapId: activeMap?.id ?? null,
        directory: effectiveDirectory || null,
      });
    },
    [activeMap?.id, currentSessionId, effectiveDirectory, setDraftMode, setSessionMode],
  );

  const handleEnableMode = React.useCallback(() => {
    if (!currentSessionId) {
      setDraftMode(true, draftPacing);
      return;
    }
    void setSessionMode(currentSessionId, {
      active: true,
      pacing,
      directory: effectiveDirectory || null,
    });
  }, [currentSessionId, draftPacing, effectiveDirectory, pacing, setDraftMode, setSessionMode]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Top strip: map switcher, mode indicator, and zero-token "+ New map" trigger */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
          {maps.map((map) => {
            const isSelected = activeMap?.id === map.id;
            return (
              <button
                key={map.id}
                type="button"
                onClick={() => {
                  if (currentSessionId) setSelectedMapId(currentSessionId, map.id);
                }}
                className={cn(
                  'shrink-0 rounded-md border px-2 py-1 typography-micro font-medium transition-colors',
                  isSelected
                    ? 'border-[var(--primary-base)] bg-[var(--primary-base)]/10 text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {map.title}
                <span className="ms-1.5 opacity-60 tabular-nums">{map.nodes.length}</span>
              </button>
            );
          })}
          {currentSessionId && !creating && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="shrink-0"
              onClick={() => setCreating(true)}
            >
              <Icon name="add" className="size-3.5" />
              {t('chat.cogmap.view.newMap')}
            </Button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {hasUnsyncedEdits && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-[var(--status-info-background)] px-2 py-0.5 typography-micro text-[var(--status-info)]"
              title={t('chat.cogmap.view.unsyncedEdits')}
            >
              <span className="size-1.5 rounded-full bg-current" />
              Delta
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              if (!currentSessionId) {
                setDraftMode(!draftModeActive);
                return;
              }
              void setSessionMode(currentSessionId, {
                active: !modeActive,
                pacing,
                directory: effectiveDirectory || null,
              });
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 typography-micro font-medium transition-colors',
              modeActive
                ? 'border-[var(--status-info)]/40 bg-[var(--status-info-background)] text-[var(--status-info)]'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon name="brain" className="size-3.5" />
            {modeActive ? (pacing === 'auto' ? t('chat.cogmap.pacing.auto') : t('chat.cogmap.pacing.collab')) : 'Mode off'}
          </button>
        </div>
      </div>

      {creating && currentSessionId && (
        <form onSubmit={handleCreateMap} className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
          <Input
            value={newMapTitle}
            onChange={(event) => setNewMapTitle(event.target.value)}
            placeholder={t('chat.cogmap.view.titlePlaceholder')}
            className="h-7 flex-1 text-xs"
            autoFocus
          />
          <Button type="submit" size="xs">
            Create
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        </form>
      )}

      {activeMap ? (
        <div className="min-h-0 flex-1 overflow-hidden p-2">
          <CognitiveMapCanvas
            title={activeMap.title}
            mapId={activeMap.id}
            rev={activeMap.rev}
            pacing={pacing}
            nodes={activeMap.nodes}
            edges={activeMap.edges}
            focusNodeId={activeMap.focusNodeId ?? null}
            compact={false}
            editable
            onMutate={handleMutate}
            onLadder={handleLadder}
            onPacingChange={handlePacingChange}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="brain" className="size-10 text-muted-foreground/50" />
          <div className="typography-ui-header text-foreground">{t('chat.cogmap.view.emptyTitle')}</div>
          <p className="max-w-sm typography-micro text-muted-foreground">
            {t('chat.cogmap.view.emptyDescription')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {!modeActive && (
              <Button type="button" size="sm" onClick={handleEnableMode}>
                <Icon name="brain" className="size-3.5" />
                {t('chat.cogmap.view.enableMode')}
              </Button>
            )}
            {currentSessionId && (
              <Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>
                <Icon name="add" className="size-3.5" />
                {t('chat.cogmap.view.createBlank')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
