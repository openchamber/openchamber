import React from 'react';

import { FormCard } from '@/components/chat/FormCard';
import { PermissionCard } from '@/components/chat/PermissionCard';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { formatCost } from '@/components/chat/work-status/subagentCost';
import { SubagentStatusRow } from '@/components/chat/work-status/SubagentStatusRow';
import { useOpenChildSession } from '@/components/chat/work-status/useOpenChildSession';
import { useSubagentRows, type SubagentRow } from '@/components/chat/work-status/useSubagentRows';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import type { FormRequest, PermissionRequest } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore, useDirectorySync } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { findSubagentTask } from './subagentTask';

const NO_PERMISSIONS: PermissionRequest[] = [];
const NO_FORMS: FormRequest[] = [];

const useSubagentTask = (parentId: string, childId: string, directory: string | null): string | null => {
  const store = useDirectoryStore(directory ?? undefined);
  return React.useMemo(() => {
    const state = store.getState();
    return findSubagentTask(state.message[parentId], state.message[childId], state.part, childId);
  }, [childId, parentId, store]);
};

const SubagentDetails: React.FC<{ row: SubagentRow; parentId: string; directory: string | null; onOpenSession: (() => void) | null }> = ({ row, parentId, directory, onOpenSession }) => {
  const { t } = useI18n();
  const childId = row.child.id;
  const permissions = useDirectorySync(React.useCallback((state: State) => state.permission[childId] ?? NO_PERMISSIONS, [childId]));
  const forms = useDirectorySync(React.useCallback((state: State) => state.form[childId] ?? NO_FORMS, [childId]));
  const task = useSubagentTask(parentId, childId, directory);
  const [taskOpen, setTaskOpen] = React.useState(false);

  return (
    <>
      {forms.length > 0 || permissions.length > 0 ? (
        <div className="mb-1.5 ms-[1.5625rem] flex flex-col gap-2">
          {forms.map((form) => <FormCard key={form.id} form={form} directory={directory ?? undefined} />)}
          {permissions.map((permission) => <PermissionCard key={permission.id} permission={permission} />)}
        </div>
      ) : null}
      <div className="oc-tile mb-1.5 ms-[1.5625rem] flex flex-col gap-2.5 rounded-lg px-3 py-2.5">
        <section>
          <h4 className="typography-micro font-medium text-muted-foreground">{t('subagents.panel.report')}</h4>
          <div className="mt-1">
            {row.run?.output.trim() ? (
              <div style={row.run.state === 'error' ? { color: 'var(--status-error)' } : undefined}>
                <SimpleMarkdownRenderer content={row.run.output} singleTilde={false} className="typography-markdown-body" enableFileReferences={false} />
              </div>
            ) : (
              <p className="typography-meta text-muted-foreground">{t('subagents.panel.noReport')}</p>
            )}
          </div>
        </section>
        {task ? (
          <section>
            <button
              type="button"
              onClick={() => setTaskOpen((open) => !open)}
              aria-expanded={taskOpen}
              className="flex items-center gap-1 typography-micro font-medium text-muted-foreground hover:text-foreground"
            >
              <Icon name="arrow-right-s" className={cn('size-3.5 transition-transform', taskOpen && 'rotate-90 rtl:-rotate-90')} />
              {t('subagents.panel.task')}
            </button>
            {taskOpen ? (
              <ScrollableOverlay as="pre" dir="auto" outerClassName="mt-1 max-h-72" className="whitespace-pre-wrap break-words font-mono typography-micro text-foreground" disableHorizontal>{task}</ScrollableOverlay>
            ) : null}
          </section>
        ) : null}
        {onOpenSession ? (
          <div>
            <Button type="button" size="xs" variant="ghost" onClick={onOpenSession}>
              <Icon name="chat-4" className="size-3.5" />
              {t('subagents.panel.openSession')}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
};

const SubagentEntry: React.FC<{
  row: SubagentRow;
  parentId: string;
  directory: string | null;
  open: boolean;
  onToggle: () => void;
  onOpenSession: (() => void) | null;
}> = ({ row, parentId, directory, open, onToggle, onOpenSession }) => {
  const { t } = useI18n();
  const label = row.child.title?.trim() || t('chat.workStatus.subagent.untitled');
  return (
    <>
      <SubagentStatusRow row={row} directory={directory} onClick={onToggle} ariaLabel={label} expanded={open} showActivity />
      {open ? <SubagentDetails row={row} parentId={parentId} directory={directory} onOpenSession={onOpenSession} /> : null}
    </>
  );
};

export const SubagentsPanel: React.FC<{ directory: string | null }> = ({ directory }) => {
  const { t } = useI18n();
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const rows = useSubagentRows(sessionId, directory);
  const openChildSession = useOpenChildSession(directory);
  const [toggled, setToggled] = React.useState<ReadonlySet<string>>(() => new Set());

  if (!sessionId || rows.length === 0) {
    return <p className="px-4 py-6 typography-meta text-muted-foreground">{t('subagents.panel.empty')}</p>;
  }

  const flip = (id: string) => setToggled((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const finished = rows.filter((row) => row.finished).length;
  const cost = rows.reduce((sum, row) => sum + row.cost, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-3 py-3" disableHorizontal>
        {rows.map((row) => {
          const { child } = row;
          const label = child.title?.trim() || t('chat.workStatus.subagent.untitled');
          const open = (row.blocked || row.asked) !== toggled.has(child.id);
          return (
            <SubagentEntry
              key={child.id}
              row={row}
              parentId={sessionId}
              directory={directory}
              open={open}
              onToggle={() => flip(child.id)}
              onOpenSession={directory ? () => openChildSession(child.id, label, child.directory) : null}
            />
          );
        })}
      </ScrollableOverlay>
      <div className="flex shrink-0 flex-wrap items-center gap-x-1.5 border-t border-edge px-3 py-2 typography-micro text-muted-foreground">
        <span className="tabular-nums" dir="auto">{t('subagents.panel.summary', { done: finished, total: rows.length })}</span>
        {cost > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums" dir="ltr">{formatCost(cost)}</span>
          </>
        ) : null}
      </div>
    </div>
  );
};
