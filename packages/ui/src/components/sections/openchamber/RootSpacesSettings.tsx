import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { RootSpaceWarning } from '@/components/session/spaces/RootSpaceNotice';
import { failureOfError, spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { approveRootPasskey, type RootPasskeyDependencies } from '@/lib/spaces/root-activation';
import type { RootApprovalResult, RootPasskeys } from '@/lib/spaces/root-passkey-schemas';
import { readRootPasskeys, type SpacePlace } from '@/lib/spaces/spaces-api';
import { SettingsControlGroup, SettingsStackedField } from '../shared/SettingsSection';

type ReadState = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly value: RootPasskeys } | { readonly kind: 'failed'; readonly error: Error };
type ApprovalState = { readonly kind: 'idle' } | { readonly kind: 'confirming' } | { readonly kind: 'awaiting'; readonly result: RootApprovalResult } | { readonly kind: 'failed'; readonly error: Error };

function CopyRootCommand({ command }: { readonly command: string }) {
  const { t } = useI18n();
  const [result, setResult] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  return <div className="min-w-0">
    <Button variant="ghost" size="sm" className="max-w-full justify-start gap-1.5 font-mono" title={command}
      aria-label={t('updateDialog.actions.copyCommand')} onClick={async () => {
        const copied = await copyTextToClipboard(command);
        setResult(copied.ok ? 'copied' : 'failed');
      }}>
      <span dir="ltr" className="truncate">{command}</span>
      <Icon name={result === 'copied' ? 'check' : 'file-copy'} className="size-3.5 shrink-0" />
    </Button>
    {result === 'failed' ? <p role="alert" className="typography-meta text-status-error">{t('aboutDialog.toast.copyFailed')}</p> : null}
  </div>;
}

const approvedDate = (value: string | number): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(getCurrentIntlLocale(), { dateStyle: 'medium' }).format(date);
};

export function RootSpacesSettings({ place, onRecheck, children, rootPasskey }: { readonly place: SpacePlace | null; readonly onRecheck: () => void; readonly children?: React.ReactNode; readonly rootPasskey?: RootPasskeyDependencies }) {
  const { t } = useI18n();
  const [read, setRead] = React.useState<ReadState>({ kind: 'loading' });
  const [approval, setApproval] = React.useState<ApprovalState>({ kind: 'idle' });
  const [code, setCode] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (!place) return;
    const controller = new AbortController();
    setRead({ kind: 'loading' });
    readRootPasskeys(controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      setRead({ kind: 'ready', value });
      setApproval((current) => current.kind === 'awaiting' && value.passkeys.some((key) => key.fingerprint === current.result.fingerprint && key.origin === current.result.origin) ? { kind: 'idle' } : current);
    }, (error: Error) => { if (!controller.signal.aborted) setRead({ kind: 'failed', error }); });
    return () => controller.abort();
  }, [place, revision]);

  const submit = async () => {
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) || approval.kind === 'confirming' || approval.kind === 'awaiting') return;
    setApproval({ kind: 'confirming' });
    try {
      const result = await approveRootPasskey(code, label, rootPasskey);
      setApproval({ kind: 'awaiting', result });
      setCode('');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setApproval({ kind: 'failed', error });
    }
  };
  const busy = approval.kind === 'confirming';
  const reason = read.kind === 'ready' ? read.value.reason : place?.rootActivation?.reason;
  const available = read.kind === 'ready' && read.value.available;
  const canApprove = place !== null && read.kind === 'ready';

  return <SettingsControlGroup title={t('settings.openchamber.spaces.root.title')} settingsItem="general.isolated-spaces-root-passkeys" contentClassName="space-y-4">
    <p className="typography-meta text-muted-foreground" role="status">
      {available ? t('settings.openchamber.spaces.root.available') : spaceFailureText(t, { code: reason ?? 'root_activation_unavailable', message: '' })}
    </p>
    {place ? <RootSpaceWarning /> : null}
    {children}
    {place && read.kind === 'loading' ? <p className="flex items-center gap-1.5 typography-meta text-muted-foreground" role="status"><Spinner className="size-3.5" />{t('spaces.access.loading')}</p> : null}
    {read.kind === 'failed' ? <p className="typography-meta text-status-error" role="alert">{spaceFailureText(t, failureOfError(read.error))}</p> : null}
    {read.kind === 'ready' ? <div className="space-y-4">
      {read.value.passkeys.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.root.empty')}</p> : null}
      {read.value.passkeys.map((key) => <div key={key.id} className="min-w-0 space-y-1">
        <p className="typography-ui-label text-foreground" dir="auto">{key.label}</p>
        <p className="break-all font-mono typography-meta text-muted-foreground" dir="ltr">{key.origin}</p>
        <p className="break-all font-mono typography-meta text-foreground" dir="ltr">{key.fingerprint}</p>
        <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.root.approvedAt', { date: approvedDate(key.approvedAt) })}</p>
        <SettingsStackedField label={t('settings.openchamber.spaces.root.revoke')}>
          <CopyRootCommand command={`sudo openchamber-host revoke-root-passkey '${key.id.replaceAll("'", "'\\''")}'`} />
        </SettingsStackedField>
      </div>)}
    </div> : null}
    {canApprove ? <SettingsControlGroup title={t('settings.openchamber.spaces.root.approve')} contentClassName="space-y-4">
      <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.root.commandInfo')}</p>
      <CopyRootCommand command="sudo openchamber-host approve-root-passkey" />
      {approval.kind === 'awaiting' ? <div className="oc-tile space-y-2 rounded-md p-3" role="status">
        <p className="typography-ui-label text-foreground">{t('settings.openchamber.spaces.root.confirm')}</p>
        <p dir="ltr" className="break-all font-mono typography-ui-header text-foreground">{approval.result.fingerprint}</p>
        <p className="break-all font-mono typography-meta text-muted-foreground" dir="ltr">{approval.result.origin}</p>
        <p className="typography-meta text-muted-foreground">{t('settings.openchamber.spaces.root.confirmInfo')}</p>
        <Button size="sm" variant="outline" onClick={() => setApproval({ kind: 'idle' })}>{t('settings.openchamber.spaces.root.approve')}</Button>
      </div> : <>
        <SettingsStackedField label={t('settings.openchamber.spaces.root.code')}>
          <Input dir="ltr" className="font-mono" value={code} disabled={busy} maxLength={9} placeholder="XXXX-XXXX"
            aria-label={t('settings.openchamber.spaces.root.code')} onChange={(event) => setCode(event.target.value.toUpperCase())} />
        </SettingsStackedField>
        <SettingsStackedField label={t('settings.openchamber.spaces.root.label')}>
          <Input value={label} disabled={busy} aria-label={t('settings.openchamber.spaces.root.label')} onChange={(event) => setLabel(event.target.value)} />
        </SettingsStackedField>
        <Button size="sm" variant="outline" disabled={busy || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)} aria-busy={busy} onClick={() => void submit()}>
          {busy ? <Spinner className="size-3.5" /> : null}{t('settings.openchamber.spaces.root.approve')}
        </Button>
      </>}
      <p className="min-h-4 typography-meta text-status-error" role={approval.kind === 'failed' ? 'alert' : undefined}>
        {approval.kind === 'failed' ? spaceFailureText(t, failureOfError(approval.error)) : null}
      </p>
    </SettingsControlGroup> : null}
    <Button size="sm" variant="ghost" disabled={busy || place !== null && read.kind === 'loading'} onClick={() => {
      if (place) setRevision((value) => value + 1);
      else onRecheck();
    }}>{t('settings.openchamber.spaces.places.retry')}</Button>
  </SettingsControlGroup>;
}
