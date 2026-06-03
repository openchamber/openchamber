import type { SVGProps } from 'react';

export function ListStartIcon(props: SVGProps<SVGSVGElement>) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            {...props}
        >
            <path d="M3 5h6" />
            <path d="M3 12h13" />
            <path d="M3 19h13" />
            <path d="m16 8-3-3 3-3" />
            <path d="M21 19V7a2 2 0 0 0-2-2h-6" />
        </svg>
    );
}
