import React, { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { toast } from '@/components/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import type { QuotaProviderId } from '@/types/quota';
import {
  MANUAL_AUTH_PROVIDERS,
  getManualAuthProvider,
  type ManualCredentialField,
} from '@/lib/quota/credentialSchemas';

interface AddCredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  defaultProviderId?: string;
  lockProvider?: boolean;
}

const firstProviderId = MANUAL_AUTH_PROVIDERS[0].id;

export const AddCredentialDialog: React.FC<AddCredentialDialogProps> = ({ open, onOpenChange, onSuccess, defaultProviderId, lockProvider }) => {
  const { t } = useI18n();
  const [providerId, setProviderId] = useState<QuotaProviderId>(
    (defaultProviderId as QuotaProviderId) || firstProviderId,
  );
  const [label, setLabel] = useState('');
  const [accountHint, setAccountHint] = useState('');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTestLoading, setIsTestLoading] = useState(false);

  const providerSpec = getManualAuthProvider(providerId) ?? MANUAL_AUTH_PROVIDERS[0];
  const fields = providerSpec.fields;
  const requiresCookie = fields.some((f) => f.key === 'cookie' || f.key === 'authCookie');

  React.useEffect(() => {
    if (open) {
      const initialProvider = (defaultProviderId as QuotaProviderId) || firstProviderId;
      setProviderId(getManualAuthProvider(initialProvider) ? initialProvider : firstProviderId);
      setLabel('');
      setAccountHint('');
      setFieldValues({});
    }
  }, [open, defaultProviderId]);

  const setField = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const buildCredential = (): Record<string, string> => {
    const credential: Record<string, string> = {};
    for (const field of fields) {
      const value = (fieldValues[field.key] ?? '').trim();
      if (value) credential[field.key] = value;
    }
    return credential;
  };

  const missingRequired = (): ManualCredentialField | null => {
    // A provider may define groups where ANY one of several fields satisfies the requirement.
    const requiredGroups = providerSpec.requiredGroups ?? fields.filter((f) => f.required).map((f) => [f.key]);
    for (const group of requiredGroups) {
      const satisfied = group.some((key) => (fieldValues[key] ?? '').trim().length > 0);
      if (!satisfied) {
        return fields.find((f) => f.key === group[0]) ?? null;
      }
    }
    return null;
  };

  const handleSubmit = async (testFirst?: boolean) => {
    if (!label.trim()) {
      toast.error(t('settings.credentials.validation.required'));
      return;
    }
    if (missingRequired()) {
      toast.error(t('settings.credentials.validation.required'));
      return;
    }

    try {
      if (testFirst) setIsTestLoading(true);
      else setIsSubmitting(true);

      const payload = {
        providerId,
        label: label.trim(),
        accountHint: accountHint.trim() || undefined,
        credential: buildCredential(),
      };

      const res = await runtimeFetch('/api/quota/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('settings.credentials.toast.addFailed'));
      }

      const created = await res.json();

      if (testFirst && created?.id) {
        const validateRes = await runtimeFetch(`/api/quota/credentials/${encodeURIComponent(created.id)}/validate`, { method: 'POST' });
        if (validateRes.ok) {
          const valData = await validateRes.json();
          if (valData.valid) {
            toast.success(t('settings.credentials.toast.validateSuccess'));
          } else {
            toast.error(valData.error || t('settings.credentials.toast.validateFailed'));
          }
        }
      }

      toast.success(t('settings.credentials.toast.addSuccess'));
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.credentials.toast.addFailed'));
    } finally {
      setIsTestLoading(false);
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.credentials.dialog.add.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
          {lockProvider && defaultProviderId ? (
            <div className="space-y-1.5">
              <label className="typography-ui-label text-foreground">{t('settings.credentials.dialog.field.provider')}</label>
              <div className="flex h-9 w-full items-center gap-2 rounded-md border border-[var(--interactive-border)] px-3 py-2 typography-ui-label text-foreground">
                <ProviderLogo providerId={providerId} className="h-4 w-4" />
                <span>{providerSpec.name}</span>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="typography-ui-label text-foreground">{t('settings.credentials.dialog.field.provider')}</label>
              <Select value={providerId} onValueChange={(v) => { setProviderId(v as QuotaProviderId); setFieldValues({}); }}>
                <SelectTrigger>
                  <div className="flex items-center gap-2">
                    <ProviderLogo providerId={providerId} className="h-4 w-4" />
                    <SelectValue />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_AUTH_PROVIDERS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      <div className="flex items-center gap-2">
                        <ProviderLogo providerId={p.id} className="h-4 w-4" />
                        <span>{p.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="typography-ui-label text-foreground">{t('settings.credentials.dialog.field.label')}</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('settings.credentials.dialog.field.labelPlaceholder')}
            />
          </div>

          <div className="space-y-1.5">
            <label className="typography-ui-label text-foreground">{t('settings.credentials.dialog.field.accountHint')}</label>
            <Input
              value={accountHint}
              onChange={(e) => setAccountHint(e.target.value)}
              placeholder={t('settings.credentials.dialog.field.accountHintPlaceholder')}
            />
            <p className="typography-meta text-muted-foreground">{t('settings.credentials.dialog.field.accountHintHelp')}</p>
          </div>

          {fields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <label className="typography-ui-label text-foreground">
                {t(field.labelKey)}
              </label>
              <Input
                type={field.secret ? 'password' : 'text'}
                value={fieldValues[field.key] ?? ''}
                onChange={(e) => setField(field.key, e.target.value)}
                placeholder={t('settings.credentials.dialog.field.secretPlaceholder')}
              />
            </div>
          ))}

          {requiresCookie && (
            <p className="typography-meta text-muted-foreground/80 flex items-start gap-1.5">
              <Icon name="information" className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{t('settings.credentials.dialog.cookieHelp')}</span>
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('settings.credentials.actions.cancel')}</Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => handleSubmit(true)} disabled={isSubmitting || isTestLoading}>
              {isTestLoading && <Icon name="loader-4" className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.credentials.actions.testAndSave')}
            </Button>
            <Button onClick={() => handleSubmit(false)} disabled={isSubmitting || isTestLoading}>
              {isSubmitting && <Icon name="loader-4" className="mr-2 h-4 w-4 animate-spin" />}
              {t('settings.credentials.actions.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
