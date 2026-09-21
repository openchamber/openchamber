import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';

/**
 * Non-blocking notice that the OpenChamber session expired mid-work. It never
 * takes the screen on its own: work stays visible and interactive, and only
 * the explicit "Log in" click hands control to the session gate's full login
 * flow (password, passkey, desktop shell — all already there).
 */
export const AuthExpiredBanner: React.FC = () => {
  const { t } = useI18n();
  const authState = useAuthSessionStore((store) => store.state);
  const markReauthenticating = useAuthSessionStore((store) => store.markReauthenticating);

  if (authState !== 'expired') {
    return null;
  }

  return (
    // Below the header on purpose: the header row can be a window-drag region
    // on desktop, where nothing under the cursor is clickable.
    <div
      className="pointer-events-none fixed inset-x-0 z-[200] flex justify-center px-4"
      style={{ top: 'calc(var(--oc-header-height, 56px) + 8px)' }}
    >
      <div
        role="alert"
        className="oc-glass-popover oc-glass-floating pointer-events-auto flex items-center gap-3 rounded-lg px-3 py-2"
      >
        <Icon name="lock" className="size-4 flex-shrink-0" style={{ color: 'var(--status-error)' }} />
        <span className="typography-ui-label text-foreground">{t('sessionAuth.expired.banner')}</span>
        <Button size="xs" variant="outline" onClick={markReauthenticating} className="normal-case">
          {t('sessionAuth.expired.loginAction')}
        </Button>
      </div>
    </div>
  );
};
