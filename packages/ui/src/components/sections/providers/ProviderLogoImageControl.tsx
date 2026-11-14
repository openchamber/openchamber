import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { providerLogoFileProblem } from '@/lib/customProviderLogos';

const ACCEPTED_FILES = 'image/png,image/jpeg,image/webp,image/svg+xml,.png,.jpg,.jpeg,.webp,.svg';

type ProviderLogoImageControlProps = {
  /** The logo as it stands: the stored upload or a file picked but not saved yet. */
  preview: React.ReactNode | null;
  busy?: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
};

/**
 * Upload and remove for a provider's logo image. A file the server would
 * refuse never leaves the browser; what happens to an accepted one is up to
 * the caller (saved at once on the provider page, on Save in the form).
 */
export const ProviderLogoImageControl: React.FC<ProviderLogoImageControlProps> = ({ preview, busy = false, onPick, onRemove }) => {
  const { t } = useI18n();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The same file picked again after a remove must fire another change.
    event.target.value = '';
    if (!file) return;
    const problem = providerLogoFileProblem(file);
    if (problem) {
      toast.error(problem === 'type' ? t('settings.providers.page.logo.error.type') : t('settings.providers.page.logo.error.size'));
      return;
    }
    onPick(file);
  };

  return (
    <div className="flex items-center gap-2">
      {preview ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-muted)]">{preview}</span>
      ) : null}
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>
        {t('settings.providers.page.logo.upload')}
      </Button>
      {preview ? (
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>
          {t('settings.providers.page.logo.remove')}
        </Button>
      ) : null}
      <input ref={inputRef} type="file" accept={ACCEPTED_FILES} className="hidden" onChange={handleChange} />
    </div>
  );
};
