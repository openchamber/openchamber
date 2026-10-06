import React from 'react';
import { Button } from '@/components/ui/button';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { testClassifier, type ClassifierTestResult, type CustomEndpointInput } from '@/lib/routing/routingApi';
import { useClassifierSourceName } from './classifierSources';

type TestState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: ClassifierTestResult }
  | { kind: 'failed'; error: string };

/**
 * Sends one Jev request and says what happened, so a wrong URL, model or key
 * shows up here instead of as a feature that quietly falls back. `draft`
 * tests endpoint fields before they are saved; without it the provider
 * answering now is tested. Nothing is saved.
 */
export const ClassifierTestButton: React.FC<{
  disabled?: boolean;
  draft?: () => CustomEndpointInput | null;
}> = ({ disabled = false, draft }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<TestState>({ kind: 'idle' });
  const result = state.kind === 'done' ? state.result : null;
  const providerName = useClassifierSourceName(result && 'source' in result ? result.source : null) ?? '';

  const run = async () => {
    const custom = draft ? draft() : undefined;
    if (custom === null) return;
    setState({ kind: 'running' });
    try {
      setState({ kind: 'done', result: await testClassifier(custom) });
    } catch (error) {
      setState({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  };

  const describe = (): { text: string; ok: boolean } | null => {
    if (state.kind === 'failed') return { text: t('settings.classification.test.failed', { error: state.error }), ok: false };
    if (!result) return null;
    if (result.ok) {
      return { text: t('settings.classification.test.ok', { provider: providerName, model: result.model, ms: result.ms }), ok: true };
    }
    if (result.reason === 'unavailable') return { text: t('settings.classification.test.unavailable'), ok: false };
    if (result.reason === 'timeout') return { text: t('settings.classification.test.timeout', { provider: providerName }), ok: false };
    if (result.reason === 'unparsable') return { text: t('settings.classification.test.unparsable', { provider: providerName }), ok: false };
    if (result.reason === 'network') {
      return { text: t('settings.classification.test.network', { provider: providerName, error: result.message ?? '' }), ok: false };
    }
    const status = result.status ?? 0;
    if (status === 401 || status === 403) return { text: t('settings.classification.test.keyRejected', { provider: providerName, status }), ok: false };
    if (status === 404) return { text: t('settings.classification.test.notFound', { provider: providerName }), ok: false };
    return { text: t('settings.classification.test.http', { provider: providerName, status }), ok: false };
  };
  const report = describe();

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => void run()}
        disabled={disabled || state.kind === 'running'}
      >
        {state.kind === 'running' ? t('settings.classification.test.running') : t('settings.classification.test.button')}
      </Button>
      <p
        role="status"
        aria-live="polite"
        className={cn(SETTINGS_HELPER_CLASS, report && !report.ok && 'text-[var(--status-error)]')}
      >
        {report?.text ?? ''}
      </p>
    </div>
  );
};
