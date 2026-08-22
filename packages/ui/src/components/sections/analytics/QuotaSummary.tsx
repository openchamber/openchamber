import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { UsageCard } from '@/components/sections/usage/UsageCard';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import type { UsageWindow } from '@/types';

interface QuotaSummaryLabels {
  empty: string;
  manage: string;
}

interface QuotaSummaryProps {
  labels: QuotaSummaryLabels;
}

export function QuotaSummary({ labels }: QuotaSummaryProps) {
  const results = useQuotaStore((state) => state.results);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);

  const providers = results
    .filter((result) => result.configured && result.ok && result.usage?.windows)
    .map((result) => ({
      providerId: result.providerId,
      providerName: result.providerName,
      windows: Object.entries(result.usage!.windows) as Array<[string, UsageWindow]>,
    }))
    .filter((provider) => provider.windows.length > 0);

  if (providers.length === 0) {
    return <p className="typography-meta text-muted-foreground">{labels.empty}</p>;
  }

  return (
    <div className="space-y-4">
      {providers.map((provider) => (
        <div key={provider.providerId}>
          <div className="mb-1 flex items-center gap-2">
            <ProviderLogo providerId={provider.providerId} className="h-4 w-4 shrink-0" />
            <span className="typography-ui-label text-foreground">{provider.providerName}</span>
          </div>
          <div className="divide-y divide-[var(--surface-subtle)]">
            {provider.windows.map(([label, window]) => (
              <UsageCard key={label} title={label} window={window} />
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setSettingsPage('usage')}
        className="typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
      >
        {labels.manage}
      </button>
    </div>
  );
}
