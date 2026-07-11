import type { SVGProps } from 'react';

export function FusionIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      {...props}
    >
      <path
        d="M12 4.5v6.25M12 10.75v3.5M12 10.75H7.25A3.25 3.25 0 0 0 4 14v1.25M12 10.75h4.75A3.25 3.25 0 0 1 20 14v1.25"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.25 7.25 12 4.5l2.75 2.75"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="4" cy="17.25" r="1.55" stroke="currentColor" strokeWidth="1.65" />
      <circle cx="12" cy="17.25" r="1.55" stroke="currentColor" strokeWidth="1.65" />
      <circle cx="20" cy="17.25" r="1.55" stroke="currentColor" strokeWidth="1.65" />
    </svg>
  );
}
