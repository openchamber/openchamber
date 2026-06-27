import React, { useEffect, useState, useCallback } from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { toast } from '@/components/ui';
import type { QuotaCredentialRecord, QuotaProviderId } from '@/types/quota';
import { AddCredentialDialog } from '../credentials/AddCredentialDialog';
import { EditCredentialDialog } from '../credentials/EditCredentialDialog';
import { DeleteCredentialDialog } from '../credentials/DeleteCredentialDialog';

interface ProviderQuotaCredentialsProps {
  quotaProviderId: QuotaProviderId;
}

export const ProviderQuotaCredentials: React.FC<ProviderQuotaCredentialsProps> = ({ quotaProviderId }) => {
  const { t } = useI18n();
  const [credentials, setCredentials] = useState<QuotaCredentialRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editCred, setEditCred] = useState<QuotaCredentialRecord | null>(null);
  const [deleteCred, setDeleteCred] = useState<QuotaCredentialRecord | null>(null);

  const fetchCredentials = useCallback(async () => {
    try {
      setLoading(true);
      const res = await runtimeFetch('/api/quota/credentials');
      if (!res.ok) throw new Error('Failed to fetch credentials');
      const data = await res.json();
      const allCreds: QuotaCredentialRecord[] = data.credentials || data;
      setCredentials(allCreds.filter(c => c.providerId === quotaProviderId));
    } catch {
      toast.error(t('settings.credentials.toast.fetchFailed'));
    } finally {
      setLoading(false);
    }
  }, [quotaProviderId, t]);

  useEffect(() => {
    void fetchCredentials();
  }, [fetchCredentials]);

  const handleValidate = async (id: string) => {
    try {
      const res = await runtimeFetch(`/api/quota/credentials/${encodeURIComponent(id)}/validate`, { method: 'POST' });
      if (!res.ok) throw new Error('Validation failed');
      const data = await res.json();
      if (data.valid) {
        toast.success(t('settings.credentials.toast.validateSuccess'));
      } else {
        toast.error(data.error || t('settings.credentials.toast.validateFailed'));
      }
      void fetchCredentials();
    } catch {
      toast.error(t('settings.credentials.toast.validateFailed'));
    }
  };

  return (
    <div data-settings-item="providers.quota-credentials" className="mb-8">
      <div className="mb-1 px-1 flex items-center justify-between">
        <div>
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.quotaCredentials.title')}</h3>
          <p className="typography-meta text-muted-foreground mt-0.5">{t('settings.providers.quotaCredentials.description')}</p>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0">
        {loading ? (
          <div className="flex justify-center py-4">
            <Icon name="loader-4" className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : credentials.length === 0 ? (
          <div className="flex flex-row items-center justify-between rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)] p-3">
            <div className="flex items-center gap-3">
              <Icon name="key" className="h-5 w-5 text-muted-foreground/70" />
              <span className="typography-ui-label text-muted-foreground">{t('settings.providers.quotaCredentials.empty')}</span>
            </div>
            <Button size="xs" variant="outline" onClick={() => setIsAddOpen(true)}>
              <Icon name="add" className="mr-1 h-3.5 w-3.5" />
              {t('settings.providers.quotaCredentials.add')}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-[var(--surface-subtle)] bg-[var(--surface-elevated)] overflow-hidden">
            <div className="divide-y divide-[var(--surface-subtle)]">
              {credentials.map(cred => (
                <CredentialRow
                  key={cred.id}
                  cred={cred}
                  onEdit={() => setEditCred(cred)}
                  onDelete={() => setDeleteCred(cred)}
                  onValidate={() => handleValidate(cred.id)}
                />
              ))}
            </div>
            <div className="bg-[var(--surface-muted)]/50 px-4 py-2 border-t border-[var(--surface-subtle)] flex justify-end">
              <Button size="xs" variant="ghost" className="!font-normal text-muted-foreground hover:text-foreground" onClick={() => setIsAddOpen(true)}>
                <Icon name="add" className="mr-1 h-3.5 w-3.5" />
                {t('settings.providers.quotaCredentials.add')}
              </Button>
            </div>
          </div>
        )}
      </section>

      <AddCredentialDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        defaultProviderId={quotaProviderId}
        lockProvider={true}
        onSuccess={fetchCredentials}
      />
      {editCred && (
        <EditCredentialDialog
          open={!!editCred}
          onOpenChange={(open) => !open && setEditCred(null)}
          credential={editCred}
          onSuccess={fetchCredentials}
        />
      )}
      {deleteCred && (
        <DeleteCredentialDialog
          open={!!deleteCred}
          onOpenChange={(open) => !open && setDeleteCred(null)}
          credential={deleteCred}
          onSuccess={fetchCredentials}
        />
      )}
    </div>
  );
};

const CredentialRow: React.FC<{
  cred: QuotaCredentialRecord;
  onEdit: () => void;
  onDelete: () => void;
  onValidate: () => void;
}> = ({ cred, onEdit, onDelete, onValidate }) => {
  const { t } = useI18n();

  const getStatusDisplay = (status: string) => {
    switch (status) {
      case 'valid':
        return <span className="flex items-center gap-1 text-[var(--status-success)]"><Icon name="check" className="h-3.5 w-3.5"/> {t('settings.credentials.status.valid')}</span>;
      case 'invalid':
        return <span className="flex items-center gap-1 text-[var(--status-error)]"><Icon name="error-warning" className="h-3.5 w-3.5"/> {t('settings.credentials.status.invalid')}</span>;
      case 'expired':
        return <span className="flex items-center gap-1 text-[var(--status-warning)]"><Icon name="time" className="h-3.5 w-3.5"/> {t('settings.credentials.status.expired')}</span>;
      case 'untested':
      default:
        return <span className="flex items-center gap-1 text-muted-foreground"><Icon name="checkbox-circle" className="h-3.5 w-3.5 opacity-50"/> {t('settings.credentials.status.untested')}</span>;
    }
  };

  return (
    <div className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4 group">
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="typography-ui-label text-foreground truncate">{cred.label}</span>
          <span className="typography-micro px-1.5 py-0.5 rounded bg-[var(--surface-muted)] text-muted-foreground">{getStatusDisplay(cred.validationStatus)}</span>
        </div>
        {cred.accountHint && (
          <div className="typography-meta text-muted-foreground flex items-center gap-1 mt-0.5">
            <Icon name="shield-check" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{cred.accountHint}</span>
          </div>
        )}
        <div className="typography-meta text-muted-foreground mt-0.5 font-mono text-xs opacity-75">
          •••• •••• ••••
        </div>
      </div>
      <div className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity self-end sm:self-auto shrink-0 mt-2 sm:mt-0">
        <Button variant="ghost" size="xs" onClick={onValidate} title={t('settings.credentials.actions.validate')}>
          <Icon name="refresh" className="h-4 w-4 text-muted-foreground hover:text-foreground" />
        </Button>
        <Button variant="ghost" size="xs" onClick={onEdit} title={t('settings.credentials.actions.edit')}>
          <Icon name="edit" className="h-4 w-4 text-muted-foreground hover:text-foreground" />
        </Button>
        <Button variant="ghost" size="xs" onClick={onDelete} title={t('settings.credentials.actions.delete')}>
          <Icon name="delete-bin" className="h-4 w-4 text-[var(--status-error)]" />
        </Button>
      </div>
    </div>
  );
};