import React from 'react';

interface ScrollToEndProps {
  children: React.ReactNode;
  className?: string;
  dep?: unknown;
}

export function ScrollToEnd({ children, className, dep }: ScrollToEndProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [dep]);
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
