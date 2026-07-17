import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

type ProviderId = 'opencode-go' | 'ollama-cloud' | 'cursor';
type Status = { configured: boolean; workspaceId?: string; secretMasked?: string };

export const QuotaCredentials: React.FC<{ providerId: ProviderId; providerName: string }> = ({ providerId, providerName }) => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<Status | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const route = `/api/quota/credentials/${providerId}`;
  React.useEffect(() => { void runtimeFetch(route).then(async (response) => {
    if (!response.ok) throw new Error();
    const next = await response.json() as Status;
    setStatus(next); setValues(next.workspaceId ? { workspaceId: next.workspaceId } : {});
  }).catch(() => setStatus({ configured: false })); }, [route]);
  const request = async (path: string, method: string, body?: object) => {
    setBusy(true);
    try {
      const response = await runtimeFetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error);
      if (payload?.configured !== undefined) setStatus(payload);
      setValues((current) => current.workspaceId ? { workspaceId: current.workspaceId } : {} as Record<string, string>);
      toast.success(t('settings.providers.page.quotaCredentials.saved', { provider: providerName }));
    } catch (error) { toast.error(error instanceof Error && error.message ? error.message : t('settings.providers.page.openCodeGo.saveFailed')); }
    finally { setBusy(false); }
  };
  const field = (name: string, label: string, placeholder: string) => <label className="block typography-ui-label text-foreground">{label}<Input className="mt-1 h-7 font-mono text-xs" type={name === 'workspaceId' ? 'text' : 'password'} autoComplete="off" value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} placeholder={status?.secretMasked ?? placeholder} /></label>;
  return <div data-settings-item={`usage.${providerId}-credentials`} className="mb-8">
    <div className="mb-1 px-1"><h3 className="typography-ui-header font-medium text-foreground">{providerName}</h3></div>
    <section className="space-y-3 px-2 pb-2 pt-0">
      {providerId === 'opencode-go' && field('workspaceId', t('settings.providers.page.openCodeGo.workspaceId'), 'wrk_...')}
      {providerId === 'opencode-go' && field('authCookie', t('settings.providers.page.openCodeGo.authCookie'), 'auth=...')}
      {providerId === 'ollama-cloud' && field('cookie', t('settings.providers.page.openCodeGo.authCookie'), 'session=...')}
      {providerId === 'cursor' && field('accessToken', t('settings.providers.page.auth.apiKeyLabel'), t('settings.providers.page.auth.apiKeyPlaceholder'))}
      {providerId === 'cursor' && field('refreshToken', t('settings.providers.page.auth.apiKeyLabel'), t('settings.providers.page.auth.apiKeyPlaceholder'))}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" disabled={busy} onClick={() => request(route, 'PUT', values)}>{status?.configured ? t('settings.providers.page.openCodeGo.replace') : t('settings.providers.page.openCodeGo.save')}</Button>
        {status?.configured && <Button variant="outline" size="xs" disabled={busy} onClick={() => request(`${route}/validate`, 'POST')}>{t('settings.providers.page.openCodeGo.validate')}</Button>}
        {providerId === 'cursor' && <Button variant="outline" size="xs" disabled={busy} onClick={() => request(`${route}/import`, 'POST')}>{t('settings.providers.page.actions.connect')}</Button>}
        {status?.configured && <Button variant="destructive" size="xs" disabled={busy} onClick={() => request(route, 'DELETE')}>{t('settings.providers.page.openCodeGo.delete')}</Button>}
      </div>
    </section>
  </div>;
};
