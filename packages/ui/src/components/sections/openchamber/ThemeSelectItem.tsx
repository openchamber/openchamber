import React from 'react';
import { toast } from 'sonner';
import { SelectItem } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';

export function ThemeSelectItem({ id, label }: { id: string; label: string }) {
  const { deleteImportedTheme, customThemeIds } = useThemeSystem();
  const { t } = useI18n();
  const [deleting, setDeleting] = React.useState(false);
  const itemRef = React.useRef<HTMLDivElement>(null);
  const deleteRef = React.useRef<HTMLButtonElement>(null);
  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    const popup = deleteRef.current?.closest('[data-slot="select-content"]');
    try {
      await deleteImportedTheme(id);
      requestAnimationFrame(() => {
        if (popup?.isConnected && document.activeElement === document.body) {
          popup.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus();
        }
      });
    }
    catch { toast.error(t('settings.themeImport.deleteError')); }
    finally { setDeleting(false); }
  };
  if (!customThemeIds.includes(id)) return <SelectItem value={id}>{label}</SelectItem>;
  return (
    <div className="flex items-center gap-1">
      <SelectItem ref={itemRef} value={id} className="min-w-0 flex-1" aria-keyshortcuts="Delete ArrowRight" onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'Delete') return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'ArrowRight') deleteRef.current?.focus();
        else void remove();
      }}>{label}</SelectItem>
      <Button ref={deleteRef} variant="ghost" size="icon" disabled={deleting} aria-label={t('settings.themeImport.delete', { name: label })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
          if (event.key !== 'ArrowLeft') return;
          event.preventDefault(); event.stopPropagation(); itemRef.current?.focus();
        }}
        onClick={(event) => {
          event.stopPropagation();
          void remove();
        }}>
        <Icon name={deleting ? 'loader' : 'delete-bin'} className={deleting ? 'size-4 animate-spin' : 'size-4'} />
      </Button>
    </div>
  );
}
