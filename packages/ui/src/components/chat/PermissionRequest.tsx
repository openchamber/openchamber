import React from 'react';
import { RiCheckLine, RiCloseLine, RiTimeLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import type { PermissionRequest as PermissionRequestPayload, PermissionResponse } from '@/types/permission';
import { useSessionStore } from '@/stores/useSessionStore';
import { useLanguage } from '@/hooks/useLanguage';

interface PermissionRequestProps {
  permission: PermissionRequestPayload;
  onResponse?: (response: 'once' | 'always' | 'reject') => void;
}

export const PermissionRequest: React.FC<PermissionRequestProps> = ({
  permission,
  onResponse
}) => {
  const { t } = useLanguage();
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);
  const { respondToPermission } = useSessionStore();

  const handleResponse = async (response: PermissionResponse) => {
    setIsResponding(true);

    try {
      await respondToPermission(permission.sessionID, permission.id, response);
      setHasResponded(true);
      onResponse?.(response);
    } catch { /* ignored */ } finally {
      setIsResponding(false);
    }
  };

  if (hasResponded) {
    return null;
  }

  const command = typeof permission.metadata.command === 'string'
    ? permission.metadata.command
    : (permission.patterns?.[0] ?? permission.permission);

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className="min-w-0">
          <span className="typography-ui-label font-medium text-muted-foreground">
            {t('permissionRequest.permissionRequired')}:
          </span>
          <code className="ml-2 typography-meta bg-amber-100/50 dark:bg-amber-800/30 px-1.5 py-0.5 rounded font-mono text-amber-800 dark:text-amber-200">
            {command}
          </code>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0 ml-4">
        <button
          onClick={() => handleResponse('once')}
          disabled={isResponding}
          className={cn(
            "flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded border h-6",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          style={{
            borderColor: 'var(--status-success)',
            color: 'var(--status-success)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--status-success-background)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <RiCheckLine className="h-3 w-3" />
          {t('permissionRequest.once')}
        </button>

        <button
          onClick={() => handleResponse('always')}
          disabled={isResponding}
          className={cn(
            "flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded border h-6",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          style={{
            borderColor: 'var(--status-info)',
            color: 'var(--status-info)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--status-info-background)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <RiTimeLine className="h-3 w-3" />
          {t('permissionRequest.always')}
        </button>

        <button
          onClick={() => handleResponse('reject')}
          disabled={isResponding}
          className={cn(
            "flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded border h-6",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
          style={{
            borderColor: 'var(--status-error)',
            color: 'var(--status-error)'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'var(--status-error-background)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <RiCloseLine className="h-3 w-3" />
          {t('permissionRequest.reject')}
        </button>

        {isResponding && (
          <div className="ml-2 flex items-center">
            <div className="animate-spin h-3 w-3 border-2 border-t-transparent rounded-full" style={{ borderColor: 'var(--loading-spinner)' }} />
          </div>
        )}
      </div>
    </div>
  );
};
