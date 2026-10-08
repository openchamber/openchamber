import { Icon } from '@/components/icon/Icon';

export function DiffViewIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative inline-block overflow-hidden rounded-[2px] ${className}`}>
      <span className="absolute left-[20%] top-[20%] h-[60%] w-[25%] bg-[var(--status-error)]/25" />
      <span className="absolute right-[20%] top-[20%] h-[60%] w-[25%] bg-[var(--status-success)]/25" />
      <Icon name="layout-column" className="absolute inset-0 h-full w-full" />
    </span>
  );
}
