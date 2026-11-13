import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { StackParentState } from './useStackParentBase';

/** Fits the create form's reserved status line; selecting a base never grows the form. */
export function StackedPullBaseHint({ state, retry, stackedOn, touched, defaultBranch, onUseDefault }: {
  readonly state: StackParentState;
  readonly retry: () => void;
  readonly stackedOn: string | null;
  readonly touched: boolean;
  readonly defaultBranch: string | null;
  readonly onUseDefault: () => void;
}) {
  const { t } = useI18n();
  if (stackedOn) return <>
    <span className="min-w-0 truncate">{t('stacks.create.stacksOn', { reference: stackedOn })}</span>
    {defaultBranch ? <Button variant="link" size="xs" className="shrink-0" onClick={onUseDefault}>
      {t('prStacks.create.useDefault', { branch: defaultBranch })}
    </Button> : null}
  </>;
  if (touched) return null;
  switch (state.status) {
    case 'idle': return null;
    case 'loading': return <span className="min-w-0 truncate">{t('prStacks.create.checking')}</span>;
    case 'error': return <>
      <span className="min-w-0 truncate" title={t('prStacks.create.checkFailed')}>{t('prStacks.create.checkFailed')}</span>
      <Button variant="link" size="xs" className="shrink-0" onClick={retry}>{t('settings.sourceControl.transport.retry')}</Button>
    </>;
    case 'ready': return state.result.status === 'ambiguous'
      ? <span className="min-w-0 truncate" title={t('prStacks.create.ambiguous', { numbers: state.result.candidates.map((pull) => `#${pull.number}`).join(', ') })}>
        {t('prStacks.create.ambiguous', { numbers: state.result.candidates.map((pull) => `#${pull.number}`).join(', ') })}
      </span> : null;
    default: return state satisfies never;
  }
}
