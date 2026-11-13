import { Fragment, useId } from 'react';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { MCP_SCOPES, type McpScope } from '@/stores/mcpConfigResponse';
import { getLocalMcpUnavailableReason, MCP_SCOPE_INFO_KEYS, MCP_SCOPE_LABEL_KEYS } from './mcpScope';

type McpScopeSelectProps = {
  readonly value: McpScope;
  readonly onChange: (value: McpScope) => void;
  readonly projectLocal: boolean | null;
  readonly directory: string | null;
  /** A protected server never goes into repository config, so Shared project is off. */
  readonly protectedCredentials?: boolean;
};

/** Scope is chosen only while creating a server. */
export function McpScopeSelect({ value, onChange, projectLocal, directory, protectedCredentials = false }: McpScopeSelectProps) {
  const { t } = useI18n();
  const reasonId = useId();
  const unavailableReasons = {
    user: null,
    project: protectedCredentials ? 'settings.mcp.page.scope.projectUnavailableProtected' : null,
    local: getLocalMcpUnavailableReason(projectLocal, directory),
  } satisfies Record<McpScope, I18nKey | null>;
  return (
    <>
      <Select value={value} onValueChange={(candidate) => {
        const scope = MCP_SCOPES.find((option) => option === candidate);
        if (!scope || unavailableReasons[scope]) return;
        onChange(scope);
      }}>
        <SelectTrigger className="min-w-0 max-w-full" aria-label={t('settings.mcp.page.scope.label')}>
          <Icon name={value === 'user' ? 'user-3' : 'folder'} className="size-3.5 shrink-0" />
          <span className="truncate">{t(MCP_SCOPE_LABEL_KEYS[value])}</span>
        </SelectTrigger>
        <SelectContent align="end">
          {MCP_SCOPES.map((scope) => {
            const reason = unavailableReasons[scope];
            return <Fragment key={scope}>
              <SelectItem value={scope} disabled={reason !== null} aria-describedby={reason ? `${reasonId}-${scope}` : undefined}>
                {/* The item text renders as a block, so the icon needs its own row container to sit beside the label. */}
                <span className="flex items-center gap-2">
                  <Icon name={scope === 'user' ? 'user-3' : 'folder'} className="size-3.5" />
                  <span>{t(MCP_SCOPE_LABEL_KEYS[scope])}</span>
                </span>
              </SelectItem>
              {reason ? <p id={`${reasonId}-${scope}`} className="max-w-64 px-2 py-1.5 typography-meta text-muted-foreground">{t(reason)}</p> : null}
            </Fragment>;
          })}
        </SelectContent>
      </Select>
      <SettingsInfoHint>
        {MCP_SCOPES.map((scope) => <p key={scope}>{t(MCP_SCOPE_LABEL_KEYS[scope])}. {t(MCP_SCOPE_INFO_KEYS[scope])}</p>)}
      </SettingsInfoHint>
    </>
  );
}
