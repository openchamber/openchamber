import React, { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { QuotaCredentialRecord, QuotaCredentialUpdate } from '@/types/quota';
import { getManualAuthProvider } from '@/lib/quota/credentialSchemas';

interface EditCredentialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  credential: QuotaCredentialRecord;
}

export const EditCredentialDialog: React.FC<EditCredentialDialogProps> = ({ open, onOpenChange, onSuccess, credential }) => {
  const { t } = useI18n();
  const [label, setLabel] = useState(credential.label || '');
  const [accountHint, setAccountHint] = useState(credential.accountHint || '');
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const providerSpec = getManualAuthProvider(credential.providerId);
  const fields = providerSpec?.fields ?? [];

  React.useEffect(() => {
    if (open) {
      setLabel(credential.label || '');
      setAccountHint(credential.accountHint || '');
      setFieldValues({});
    }
  }, [open, credential]);

  const setField = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    if (!label.trim()) {
      toast.error(t('settings.credentials.validation.required'));
      return;
    }

    try {
      setIsSubmitting(true);

      const payload: QuotaCredentialUpdate = {
        label: label.trim(),
        accountHint: accountHint.trim() || undefined,
      };

      // Only replace the credential if the user entered new values.
      const newCredential: Record<string, string> = {};
      for (const field of fields) {
        const value = (fieldValues[field.key] ?? '').trim();
        if (value) newCredential[field.key] = value;
      }
      if (Object.keys(newCredential).length > 0) {
        payload.credential = newCredential;
      }

      const res = await runtimeFetch(`/api/quota/credentials/${encodeURIComponent(credential.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('settings.credentials.toast.updateFailed'));
      }

      toast.success(t('settings.credentials.toast.updateSuccess'));
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.credentials.toast.updateFailed'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.credentials.dialog.edit.title')}</DialogTitle>
          <DialogDescription>{t('settings.credentials.dialog.edit.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
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
          </div>

          {fields.length > 0 && (
            <div className="space-y-4 pt-2 border-t border-[var(--surface-subtle)]">
              <p className="typography-meta text-muted-foreground">{t('settings.credentials.dialog.field.replaceSecretHelp')}</p>
              {fields.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <label className="typography-ui-label text-foreground">{t(field.labelKey)}</label>
                  <Input
                    type={field.secret ? 'password' : 'text'}
                    value={fieldValues[field.key] ?? ''}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={t('settings.credentials.dialog.field.replaceSecretPlaceholder')}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('settings.credentials.actions.cancel')}</Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting && <Icon name="loader-4" className="mr-2 h-4 w-4 animate-spin" />}
            {t('settings.credentials.actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
