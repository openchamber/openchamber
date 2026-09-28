import * as React from 'react';
import { toast } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { CURRENT_TELEMETRY_CONSENT_VERSION, isTelemetryDisabledByEnv } from '@/lib/telemetry';
import { useUIStore } from '@/stores/useUIStore';

const TOAST_ID = 'telemetry-consent';

export const TelemetryConsentBanner: React.FC = () => {
  const { t } = useI18n();
  const telemetryConsentVersion = useUIStore((s) => s.telemetryConsentVersion);

  React.useEffect(() => {
    if (isTelemetryDisabledByEnv() || telemetryConsentVersion >= CURRENT_TELEMETRY_CONSENT_VERSION) {
      toast.dismiss(TOAST_ID);
      return;
    }

    const accept = () => {
      useUIStore.getState().setReportUsage(true);
      useUIStore.getState().setTelemetryConsentVersion(CURRENT_TELEMETRY_CONSENT_VERSION);
      toast.dismiss(TOAST_ID);
    };
    const decline = () => {
      useUIStore.getState().setReportUsage(false);
      useUIStore.getState().setTelemetryConsentVersion(CURRENT_TELEMETRY_CONSENT_VERSION);
      toast.dismiss(TOAST_ID);
    };

    toast.custom(() => (
      <div className="flex w-full flex-col gap-2.5">
        <div className="min-w-0">
          <div className="typography-ui-label font-medium text-foreground">{t('telemetry.banner.title')}</div>
          <p className="typography-meta mt-0.5 text-muted-foreground">{t('telemetry.banner.description')}</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={decline}
            className="rounded-[var(--radius-md)] bg-[var(--interactive-hover)] px-2 py-1 typography-meta font-medium text-foreground transition-colors hover:bg-[var(--interactive-active)]"
          >
            {t('telemetry.banner.decline')}
          </button>
          <button
            type="button"
            onClick={accept}
            className="rounded-[var(--radius-md)] bg-[var(--primary-base)] px-2 py-1 typography-meta font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-85"
          >
            {t('telemetry.banner.accept')}
          </button>
        </div>
      </div>
    ), {
      id: TOAST_ID,
      duration: Infinity,
      className: '!w-[16.5rem]',
      style: { width: '16.5rem' },
    });
  }, [t, telemetryConsentVersion]);

  return null;
};
