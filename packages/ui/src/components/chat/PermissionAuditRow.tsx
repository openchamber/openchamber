import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getToolMetadata } from '@/lib/toolHelpers';
import type { PermissionAuditEntry } from '@/types/permissionAudit';

type PermissionAuditRowProps = {
  entry: PermissionAuditEntry;
  collapsePreviousSpacing?: boolean;
};

const getStatusKey = (entry: PermissionAuditEntry) => {
  if (entry.status === 'requested') return 'chat.permissionAudit.status.requested' as const;
  if (entry.status === 'denied') return 'chat.permissionAudit.status.denied' as const;
  if (entry.autoApproved) return 'chat.permissionAudit.status.autoApproved' as const;
  if (entry.response === 'always') return 'chat.permissionAudit.status.approvedAlways' as const;
  if (entry.response === 'once') return 'chat.permissionAudit.status.approvedOnce' as const;
  return 'chat.permissionAudit.status.approvedOnce' as const;
};

const getStatusIcon = (entry: PermissionAuditEntry) => {
  if (entry.status === 'requested') return 'question' as const;
  if (entry.status === 'denied') return 'close-circle' as const;
  return entry.autoApproved ? 'flashlight' as const : 'checkbox-circle' as const;
};

const normalizeToolName = (toolName: string) => {
  const trimmed = toolName.trim().toLowerCase();
  if (!trimmed) return '';

  if (trimmed.includes('.')) {
    const parts = trimmed.split('.').filter(Boolean);
    return parts[parts.length - 1] ?? trimmed;
  }

  return trimmed;
};

const hasMetadata = (entry: PermissionAuditEntry) => {
  return Object.keys(entry.metadata).length > 0;
};

export const PermissionAuditRow = React.memo(({ entry, collapsePreviousSpacing = false }: PermissionAuditRowProps) => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = React.useState(false);
  const rawToolName = entry.permission?.trim() || t('chat.permissionAudit.toolFallback');
  const normalizedToolName = normalizeToolName(rawToolName);
  const toolName = normalizedToolName || rawToolName;
  const displayToolName = getToolMetadata(toolName).displayName;
  const statusKey = getStatusKey(entry);
  const hasDetails = entry.patterns.length > 0 || hasMetadata(entry);
  const detailText = `${t(statusKey)} • ${displayToolName}`;

  return (
    <div className={cn('chat-column py-1.5', collapsePreviousSpacing && '-mt-8')} data-permission-audit-row="true">
      <div
        className="group/tool flex cursor-pointer items-center gap-1.5 rounded-xl py-1.5 pl-px pr-2"
        onClick={() => setIsExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return;
          }

          event.preventDefault();
          setIsExpanded((value) => !value);
        }}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
      >
        <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--tools-icon)' }} />
        <Icon name={getStatusIcon(entry)} className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--tools-icon)' }} />
        <span className="typography-meta flex-shrink-0 font-medium" style={{ color: 'var(--tools-title)' }}>
          {t('chat.permissionAudit.title')}
        </span>
        <span className="typography-meta min-w-0 truncate" style={{ color: 'var(--tools-description)' }} title={detailText}>
          {detailText}
        </span>
      </div>
      <div
        aria-hidden={!isExpanded}
        style={{
          height: isExpanded ? 'auto' : '0px',
          overflow: isExpanded ? 'visible' : 'hidden',
          overflowAnchor: 'none',
        }}
      >
        {isExpanded ? (
          <div className="relative ml-2 pl-3" style={{ opacity: 1, transform: 'translateY(0)' }}>
            <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 top-px w-px" style={{ backgroundColor: 'var(--tools-border)' }} />
            <div className="relative space-y-2 pb-2 pl-4 pr-2 pt-2">
              <div className="tool-output-surface max-h-[60vh] w-full min-w-0 overflow-auto rounded-xl p-2">
                <div className="w-full min-w-0 space-y-3">
                  <div className="flex flex-wrap gap-4 border-b border-[var(--interactive-border)] pb-2 typography-meta">
                    <span className="font-medium" style={{ color: 'var(--surface-muted-foreground)' }}>{displayToolName}</span>
                    <span style={{ color: 'var(--tools-description)' }}>{t(statusKey)}</span>
                  </div>
                  {entry.patterns.length > 0 ? (
                    <div className="space-y-1">
                      <div className="typography-meta font-semibold uppercase tracking-wide" style={{ color: 'var(--surface-muted-foreground)' }}>
                        {t('chat.permissionCard.patterns')}
                      </div>
                      <div className="space-y-1.5 pl-4">
                        {entry.patterns.map((pattern) => (
                          <div key={pattern} className="flex items-start gap-2">
                            <Icon name="check" className="mt-0.5 h-3 w-3 flex-shrink-0" style={{ color: 'var(--status-success)', opacity: 0.7 }} />
                            <span className="typography-code flex-1 break-words leading-relaxed" style={{ color: 'var(--surface-foreground)' }}>{pattern}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {hasMetadata(entry) ? (
                    <div className={cn('space-y-1', entry.patterns.length > 0 && 'pt-1')}>
                      <div className="typography-meta font-semibold uppercase tracking-wide" style={{ color: 'var(--surface-muted-foreground)' }}>
                        {t('chat.permissionCard.details')}
                      </div>
                      <pre className="typography-code m-0 whitespace-pre-wrap break-words rounded-lg border border-[var(--interactive-border)] p-2" style={{ color: 'var(--surface-foreground)', backgroundColor: 'var(--surface-elevated)' }}>
                        {JSON.stringify(entry.metadata, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                  {!hasDetails ? (
                    <div className="typography-meta" style={{ color: 'var(--surface-muted-foreground)' }}>{t('chat.toolPart.noOutputProduced')}</div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

PermissionAuditRow.displayName = 'PermissionAuditRow';
