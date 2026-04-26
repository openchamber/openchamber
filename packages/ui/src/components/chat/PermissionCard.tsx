import React from 'react';
import { RiCheckLine, RiCloseLine, RiFileEditLine, RiGlobalLine, RiPencilAiLine, RiQuestionLine, RiTerminalBoxLine, RiTimeLine, RiToolsLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { PermissionRequest, PermissionResponse } from '@/types/permission';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { DiffPreview, WritePreview } from './DiffPreview';
import { useI18n } from '@/lib/i18n';

const PERMISSION_BASH_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
  background: 'rgb(var(--muted) / 0.3)',
  borderRadius: '0.25rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  overflow: 'visible',
};

const PERMISSION_BASH_CODE_TAG_PROPS = {
  style: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'break-word',
  } as React.CSSProperties,
};

const PERMISSION_JSON_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '0.5rem',
  fontSize: 'var(--text-meta)',
  lineHeight: '1.25rem',
  background: 'rgb(var(--muted) / 0.3)',
  borderRadius: '0.25rem',
};

interface PermissionCardProps {
  permission: PermissionRequest;
  onResponse?: (response: 'once' | 'always' | 'reject') => void;
}

const getToolIcon = (toolName: string) => {
  const iconClass = "h-3 w-3";
  const tool = toolName.toLowerCase();

  if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
    return <RiPencilAiLine className={iconClass} />;
  }

  if (tool === 'write' || tool === 'create' || tool === 'file_write') {
    return <RiFileEditLine className={iconClass} />;
  }

  if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal' || tool === 'shell_command') {
    return <RiTerminalBoxLine className={iconClass} />;
  }

  if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
    return <RiGlobalLine className={iconClass} />;
  }

  return <RiToolsLine className={iconClass} />;
};

const getToolDisplayName = (toolName: string): string => {
  const tool = toolName.toLowerCase();

  if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
    return 'edit';
  }
  if (tool === 'write' || tool === 'create' || tool === 'file_write') {
    return 'write';
  }
  if (tool === 'bash' || tool === 'shell' || tool === 'cmd' || tool === 'terminal' || tool === 'shell_command') {
    return 'bash';
  }
  if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
    return 'webfetch';
  }

  return toolName;
};

export const PermissionCard: React.FC<PermissionCardProps> = ({
  permission,
  onResponse
}) => {
  const { t } = useI18n();
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const respondToPermission = sessionActions.respondToPermission;
  const sessions = useSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isFromSubagent = React.useMemo(() => {
    if (!currentSessionId || permission.sessionID === currentSessionId) return false;
    const sourceSession = sessions.find((session) => session.id === permission.sessionID);
    return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
  }, [permission.sessionID, currentSessionId, sessions]);
  const { currentTheme } = useThemeSystem();
  const syntaxTheme = React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);

  const handleResponse = async (response: PermissionResponse) => {
    setIsResponding(true);

    try {
      await respondToPermission(permission.sessionID, permission.id, response);
      setHasResponded(true);
      onResponse?.(response);
    } catch (error) {
      console.error('[PermissionCard] Failed to respond to permission:', error);
    } finally {
      setIsResponding(false);
    }
  };

  if (hasResponded) {
    return null;
  }

  const toolName = permission.permission || 'unknown';
  const tool = toolName.toLowerCase();

  const getMeta = (key: string, fallback: string = ''): string => {
    const val = permission.metadata[key];
    return typeof val === 'string' ? val : (typeof val === 'number' ? String(val) : fallback);
  };
  const getMetaNum = (key: string): number | undefined => {
    const val = permission.metadata[key];
    return typeof val === 'number' ? val : undefined;
  };
  const getMetaBool = (key: string): boolean => {
    const val = permission.metadata[key];
    return Boolean(val);
  };
  const displayToolName = getToolDisplayName(toolName);

  const renderToolContent = () => {

    if (tool === 'bash' || tool === 'shell' || tool === 'shell_command') {
      const command = getMeta('command') || getMeta('cmd') || getMeta('script');
      const description = getMeta('description');
      const workingDir = getMeta('cwd') || getMeta('working_directory') || getMeta('directory') || getMeta('path');
      const timeout = getMetaNum('timeout');
 
      return (
        <>
          {description && (
            <div className="typography-meta text-muted-foreground mb-2">{description}</div>
          )}
          {workingDir && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">{t('chat.permissionCard.workingDirectory')}</span> <code className="px-1 py-0.5 bg-muted/30 rounded">{workingDir}</code>
            </div>
          )}
          {timeout && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">{t('chat.permissionCard.timeout')}</span> {timeout}ms
            </div>
          )}
          {}
          {command && (
            <div>
              <SyntaxHighlighter
                language="bash"
                style={syntaxTheme}
                PreTag="div"
                customStyle={PERMISSION_BASH_CUSTOM_STYLE}
                codeTagProps={PERMISSION_BASH_CODE_TAG_PROPS}
                wrapLongLines={true}
              >
                {command}
              </SyntaxHighlighter>
            </div>
          )}
        </>
      );
    }

    if (tool === 'edit' || tool === 'multiedit' || tool === 'str_replace' || tool === 'str_replace_based_edit_tool') {
      const filePath = getMeta('path') || getMeta('file_path') || getMeta('filename') || getMeta('filePath');
      const changes = getMeta('changes') || getMeta('diff');
      const replaceAll = getMetaBool('replace_all') || getMetaBool('replaceAll');

      return (
        <>
          {replaceAll && (
            <div className="typography-meta text-muted-foreground mb-2">
              <span className="font-semibold">⚠️ Replace All Occurrences</span>
            </div>
          )}
          {changes && (
            <ScrollableOverlay outerClassName="max-h-[60vh]" className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent">
              <DiffPreview diff={changes} syntaxTheme={syntaxTheme} filePath={filePath} />
            </ScrollableOverlay>
          )}
        </>
      );
    }

    if (tool === 'write' || tool === 'create' || tool === 'file_write') {
      const filePath = getMeta('path') || getMeta('file_path') || getMeta('filename') || getMeta('filePath');
      const content = getMeta('content') || getMeta('text') || getMeta('data');

      if (content) {
        return (
          <ScrollableOverlay outerClassName="max-h-[60vh]" className="tool-output-surface p-1 rounded-xl border border-border/20 bg-transparent">
            <WritePreview content={content} syntaxTheme={syntaxTheme} filePath={filePath} />
          </ScrollableOverlay>
        );
      }

      return null;
    }

    if (tool === 'webfetch' || tool === 'fetch' || tool === 'curl' || tool === 'wget') {
      const url = getMeta('url') || getMeta('uri') || getMeta('endpoint');
      const method = getMeta('method') || 'GET';
      const headers = permission.metadata.headers && typeof permission.metadata.headers === 'object' ? (permission.metadata.headers as Record<string, unknown>) : undefined;
      const body = getMeta('body') || getMeta('data') || getMeta('payload');
      const timeout = getMetaNum('timeout');
      const format = getMeta('format') || getMeta('responseType');

      return (
        <>
          {url && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.request')}</div>
              <div className="flex items-center gap-2">
                <span className="typography-meta font-semibold px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                  {method}
                </span>
                <code className="typography-meta px-2 py-1 bg-muted/30 rounded flex-1 break-all">
                  {url}
                </code>
              </div>
            </div>
          )}
          {headers && Object.keys(headers).length > 0 && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.headers')}</div>
              <ScrollableOverlay outerClassName="max-h-24" className="p-0">
                <SyntaxHighlighter
                  language="json"
                  style={syntaxTheme}
                  customStyle={PERMISSION_JSON_CUSTOM_STYLE}
                  wrapLongLines={true}
                >
                  {JSON.stringify(headers, null, 2)}
                </SyntaxHighlighter>
              </ScrollableOverlay>
            </div>
          )}
          {body && (
            <div className="mb-2">
              <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.body')}</div>
              <ScrollableOverlay outerClassName="max-h-32" className="p-0">
                <SyntaxHighlighter
                  language={typeof body === 'object' ? 'json' : 'text'}
                  style={syntaxTheme}
                  customStyle={PERMISSION_JSON_CUSTOM_STYLE}
                  wrapLongLines={true}
                >
                  {typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body)}
                </SyntaxHighlighter>
              </ScrollableOverlay>
            </div>
          )}
          {(timeout || format) && (
            <div className="typography-meta text-muted-foreground">
              {timeout && <span>Timeout: {timeout}ms</span>}
              {timeout && format && <span> • </span>}
              {format && <span>Response format: {format}</span>}
            </div>
          )}
        </>
      );
    }

    const genericContent = getMeta('command') || getMeta('content') || getMeta('action') || getMeta('operation');
    const description = getMeta('description');

    return (
      <>
        {description && (
          <div className="typography-meta text-muted-foreground mb-2">{description}</div>
        )}
        {genericContent && (
          <div className="mb-2">
            <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.action')}</div>
            <ScrollableOverlay outerClassName="max-h-32" className="p-0">
              <pre className="typography-meta font-mono px-2 py-1 bg-muted/30 rounded whitespace-pre-wrap break-all">
                {String(genericContent)}
              </pre>
            </ScrollableOverlay>
          </div>
        )}
        {}
        {Object.keys(permission.metadata).length > 0 && !genericContent && !description && (
          <div>
            <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.details')}</div>
            <ScrollableOverlay outerClassName="max-h-32" className="p-0">
              <pre className="typography-meta font-mono px-2 py-1 bg-muted/30 rounded whitespace-pre-wrap break-all">
                {JSON.stringify(permission.metadata, null, 2)}
              </pre>
            </ScrollableOverlay>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          {}
          <div className="px-2 py-1.5 border-b border-border/20 bg-muted/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RiQuestionLine className="h-3.5 w-3.5 text-[var(--status-warning)]" />
                <span className="typography-meta font-medium text-muted-foreground">
                  Permission Required
                </span>
                {isFromSubagent ? (
                  <span className="typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5">
                    From subagent
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5">
                {getToolIcon(toolName)}
                <span className="typography-meta text-muted-foreground font-medium">{displayToolName}</span>
              </div>
            </div>
          </div>

          {}
          <div className="px-2 py-2">
            {permission.patterns.length > 0 && (
              <div className="mb-2">
                <div className="typography-meta text-muted-foreground mb-1">{t('chat.permissionCard.patterns')}</div>
                <code className="typography-meta px-2 py-1 bg-muted/30 rounded block break-all">
                  {permission.patterns.join(", ")}
                </code>
              </div>
            )}

            {renderToolContent()}
          </div>

          {}
          <div className="px-2 pb-2 sm:pb-1.5 pt-1.5 sm:pt-1 flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-1.5 border-t border-border/20">
            <button
              onClick={() => handleResponse('once')}
              disabled={isResponding}
              className={cn(
                "flex items-center gap-1.5 sm:gap-1 px-3 sm:px-2 py-1.5 sm:py-1 typography-meta font-medium rounded transition-all min-h-[32px] sm:min-h-0 w-full sm:w-auto",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
              style={{
                backgroundColor: 'rgb(var(--status-success) / 0.1)',
                color: 'var(--status-success)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-success) / 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-success) / 0.1)';
              }}
            >
              <RiCheckLine className="h-3.5 w-3.5 sm:h-3 sm:w-3 flex-shrink-0" />
              Allow Once
            </button>

            {permission.always.length > 0 ? (
              <button
                onClick={() => handleResponse('always')}
                disabled={isResponding}
                className={cn(
                  "flex items-center gap-1.5 sm:gap-1 px-3 sm:px-2 py-1.5 sm:py-1 typography-meta font-medium rounded transition-all min-h-[32px] sm:min-h-0 w-full sm:w-auto",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
                style={{
                  backgroundColor: 'rgb(var(--muted) / 0.5)',
                  color: 'var(--muted-foreground)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.7)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.5)';
                }}
              >
                <RiTimeLine className="h-3.5 w-3.5 sm:h-3 sm:w-3 flex-shrink-0" />
                {(() => {
                  const always = (permission.always as string[]) || (permission.metadata.always as string[]) || [];
                  if (always.length === 0) return "Always Allow";
                  const displayPatterns = always.slice(0, 2);
                  const text = displayPatterns.join(", ");
                  const hasMore = always.length > 2;
                  return (
                    <span className="truncate max-w-[180px]">
                      {hasMore ? `Always: ${text}...` : `Always: ${text}`}
                    </span>
                  );
                })()}
              </button>
            ) : (
              <button
                onClick={() => handleResponse('always')}
                disabled={isResponding}
                className={cn(
                  "flex items-center gap-1.5 sm:gap-1 px-3 sm:px-2 py-1.5 sm:py-1 typography-meta font-medium rounded transition-all min-h-[32px] sm:min-h-0 w-full sm:w-auto",
                  "disabled:opacity-50 disabled:cursor-not-allowed"
                )}
                style={{
                  backgroundColor: 'rgb(var(--muted) / 0.5)',
                  color: 'var(--muted-foreground)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.7)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'rgb(var(--muted) / 0.5)';
                }}
              >
                <RiTimeLine className="h-3.5 w-3.5 sm:h-3 sm:w-3 flex-shrink-0" />
                Always Allow
              </button>
            )}

            <button
              onClick={() => handleResponse('reject')}
              disabled={isResponding}
              className={cn(
                "flex items-center gap-1.5 sm:gap-1 px-3 sm:px-2 py-1.5 sm:py-1 typography-meta font-medium rounded transition-all min-h-[32px] sm:min-h-0 w-full sm:w-auto",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
              style={{
                backgroundColor: 'rgb(var(--status-error) / 0.1)',
                color: 'var(--status-error)'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-error) / 0.2)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgb(var(--status-error) / 0.1)';
              }}
            >
              <RiCloseLine className="h-3.5 w-3.5 sm:h-3 sm:w-3 flex-shrink-0" />
              Deny
            </button>

            {isResponding && (
              <div className="flex justify-center w-full sm:w-auto sm:ml-auto py-1 sm:py-0 typography-meta text-muted-foreground">
                <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
