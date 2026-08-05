import type { SVGProps } from 'react';

import { Icon } from '@/components/icon/Icon';

interface DiffIconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number | string;
}

export function DiffViewIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative inline-block overflow-hidden rounded-[2px] ${className}`}>
      <span className="absolute left-[20%] top-[20%] h-[60%] w-[25%] bg-[var(--status-error)]/25" />
      <span className="absolute right-[20%] top-[20%] h-[60%] w-[25%] bg-[var(--status-success)]/25" />
      <Icon name="layout-column" className="absolute inset-0 h-full w-full" />
    </span>
  );
}

/**
 * Git merge/branch icon for the Diff tab.
 */
export function DiffIcon({ size, className, style, ...props }: DiffIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      fill="currentColor"
      className={className}
      style={{
        width: typeof size === 'number' ? `${size}px` : size,
        height: typeof size === 'number' ? `${size}px` : size,
        ...style,
      }}
      {...props}
    >
      <path d="M112,148a12,12,0,0,0-12,12v19L69.17,148.2A4,4,0,0,1,68,145.37V97.94a36,36,0,1,0-24,0v47.43a27.81,27.81,0,0,0,8.2,19.8L83,196H64a12,12,0,0,0,0,24h48a12,12,0,0,0,12-12V160A12,12,0,0,0,112,148ZM56,52A12,12,0,1,1,44,64,12,12,0,0,1,56,52ZM212,158.06V110.63a27.81,27.81,0,0,0-8.2-19.8L173,60h19a12,12,0,0,0,0-24H144a12,12,0,0,0-12,12V96a12,12,0,0,0,24,0V77l30.83,30.83a4,4,0,0,1,1.17,2.83v47.43a36,36,0,1,0,24,0ZM200,204a12,12,0,1,1,12-12A12,12,0,0,1,200,204Z" />
    </svg>
  );
}
