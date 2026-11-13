import React from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import type { SurfaceConnectionState, SurfaceControlState } from '@/lib/guests/surface-client';
import type { ServerBrowserChromeStatus, ServerBrowserHelp } from '@/lib/browser/serverBrowser/types';

/**
 * The bars stacked above the page picture: who holds control right now, a
 * help request aimed at this chat, and the service's Chrome install status.
 * A help request replaces the control bar, except while this viewer holds
 * control: then both show, since "Hand back" is what answers the request.
 */

const ControlBar: React.FC<{
  control: SurfaceControlState;
  connection: SurfaceConnectionState;
  focused: boolean;
  onHandBack: () => void;
}> = ({ control, connection, focused, onHandBack }) => {
  const { t } = useI18n();

  if (control.controller === 'user' && control.mine) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
        <span className="typography-meta text-foreground">{t('contextPanel.browser.server.control.bar')}</span>
        <Button size="xs" variant="outline" className="ms-auto" onClick={onHandBack}>
          {t('contextPanel.surface.handBack')}
        </Button>
      </div>
    );
  }

  if (control.controller === 'user' && !control.mine) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
        <span className="typography-meta text-muted-foreground">{t('contextPanel.surface.status.otherControls')}</span>
      </div>
    );
  }

  if (control.controller === 'agent') {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
        <Spinner className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="typography-meta text-muted-foreground">{t('contextPanel.browser.server.control.agentWorking')}</span>
      </div>
    );
  }

  if (connection.status === 'ended' || connection.status === 'reconnecting' || connection.status === 'connecting') return null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5">
      <span className="typography-meta text-muted-foreground" aria-live="polite">
        {focused ? t('contextPanel.surface.status.readyFocused') : t('contextPanel.browser.server.control.hint')}
      </span>
    </div>
  );
};

const ProfileRequestBanner: React.FC<{
  help: ServerBrowserHelp;
  profile: { readonly name: string; readonly exists: boolean };
  onAnswer: (approve: boolean) => Promise<void>;
}> = ({ help, profile, onAnswer }) => {
  const { t } = useI18n();
  const [answering, setAnswering] = React.useState(false);
  const answer = (approve: boolean) => {
    setAnswering(true);
    void onAnswer(approve).finally(() => setAnswering(false));
  };
  return (
    <div className="flex flex-col gap-1.5 border-b border-border bg-[color-mix(in_srgb,var(--status-warning)_12%,var(--surface-elevated))] px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon name="user" className="size-3.5 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
        <span className="typography-meta min-w-0 flex-1 text-foreground">
          {profile.exists
            ? t('contextPanel.browser.server.help.profileUseExisting', { profile: profile.name })
            : t('contextPanel.browser.server.help.profileCreate', { profile: profile.name })}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 ps-5.5">
        <span className="typography-micro min-w-0 flex-1 text-muted-foreground">
          {t('contextPanel.browser.server.help.profileReason', { reason: help.reason })}
        </span>
        <div className="flex items-center gap-1.5">
          <Button size="xs" variant="ghost" disabled={answering} onClick={() => answer(false)}>
            {t('contextPanel.browser.server.help.profileDecline')}
          </Button>
          <Button size="xs" variant="outline" disabled={answering} onClick={() => answer(true)}>
            <Icon name="save-3" className="size-3.5" aria-hidden="true" />
            {t('contextPanel.browser.server.help.profileApprove')}
          </Button>
        </div>
      </div>
    </div>
  );
};

// A login request shows on the sign-in browser, whose bar above already offers Save sign-in.
const HelpBanner: React.FC<{ help: ServerBrowserHelp }> = ({ help }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--status-warning)_12%,var(--surface-elevated))] px-3 py-2">
      <Icon name="user" className="size-3.5 shrink-0 text-[var(--status-warning)]" aria-hidden="true" />
      <span className="typography-meta min-w-0 flex-1 text-foreground">
        {t('contextPanel.browser.server.help.banner', { reason: help.reason })}
      </span>
    </div>
  );
};

const ChromeStatusBanner: React.FC<{ chrome: ServerBrowserChromeStatus }> = ({ chrome }) => {
  const { t } = useI18n();

  const copyCommand = async () => {
    const result = await copyTextToClipboard(chrome.message);
    toast[result.ok ? 'success' : 'error'](result.ok
      ? t('contextPanel.browser.server.chrome.copied')
      : t('contextPanel.browser.clearFailed'));
  };

  if (chrome.status === 'ready' || chrome.status === 'system') return null;

  const title = chrome.status === 'installing'
    ? t('contextPanel.browser.server.chrome.installing')
    : chrome.status === 'missing-libraries'
      ? t('contextPanel.browser.server.chrome.missingLibraries')
      : t('contextPanel.browser.server.chrome.failed');

  return (
    <div className="flex flex-col gap-1 border-b border-border bg-[color-mix(in_srgb,var(--status-error)_10%,var(--surface-elevated))] px-3 py-2">
      <div className="flex items-center gap-2">
        {chrome.status === 'installing' ? (
          <Spinner className="size-3.5 text-muted-foreground" aria-hidden="true" />
        ) : (
          <Icon name="error-warning" className="size-3.5 shrink-0 text-[var(--status-error)]" aria-hidden="true" />
        )}
        <span className="typography-meta text-foreground">{title}</span>
      </div>
      {chrome.message ? (
        <div className="flex items-center justify-between gap-2 ps-5.5">
          <span className="typography-micro whitespace-pre-wrap text-muted-foreground">{chrome.message}</span>
          {chrome.status === 'missing-libraries' ? (
            <Button size="xs" variant="outline" onClick={() => void copyCommand()}>
              <Icon name="file-copy" className="size-3.5" aria-hidden="true" />
              {t('contextPanel.browser.server.chrome.copyCommand')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

export const ServerBrowserBanners: React.FC<{
  control: SurfaceControlState;
  connection: SurfaceConnectionState;
  focused: boolean;
  onHandBack: () => void;
  help: ServerBrowserHelp | null;
  helpTargetsThisScope: boolean;
  onAnswerProfileRequest: (approve: boolean) => Promise<void>;
  chrome: ServerBrowserChromeStatus | null;
}> = ({ control, connection, focused, onHandBack, help, helpTargetsThisScope, onAnswerProfileRequest, chrome }) => (
  <>
    {chrome ? <ChromeStatusBanner chrome={chrome} /> : null}
    {help && helpTargetsThisScope ? (
      <>
        {help.kind === 'profile' && help.profile
          ? <ProfileRequestBanner help={help} profile={help.profile} onAnswer={onAnswerProfileRequest} />
          : <HelpBanner help={help} />}
        {/* Handing back is how the user answers the request, so the bar with
            that button has to stay while they hold control. */}
        {control.controller === 'user' && control.mine ? (
          <ControlBar control={control} connection={connection} focused={focused} onHandBack={onHandBack} />
        ) : null}
      </>
    ) : (
      <ControlBar control={control} connection={connection} focused={focused} onHandBack={onHandBack} />
    )}
  </>
);
