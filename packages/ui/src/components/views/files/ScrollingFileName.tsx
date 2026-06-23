import React from 'react';

export const ScrollingFileName: React.FC<{ name: string }> = ({ name }) => {
  const containerRef = React.useRef<HTMLSpanElement | null>(null);
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) {
      return;
    }

    const updateOverflow = () => {
      setOverflowing(text.scrollWidth > container.clientWidth + 1);
    };

    updateOverflow();
    const resizeObserver = new ResizeObserver(updateOverflow);
    resizeObserver.observe(container);
    resizeObserver.observe(text);

    return () => {
      resizeObserver.disconnect();
    };
  }, [name]);

  return (
    <span ref={containerRef} className="relative block min-w-0 flex-1 overflow-hidden whitespace-nowrap">
      <span ref={textRef} aria-hidden="true" className="invisible absolute whitespace-nowrap">{name}</span>
      {overflowing ? (
        <span className="open-file-name-marquee-track">
          <span className="open-file-name-marquee-item">{name}</span>
          <span className="open-file-name-marquee-item" aria-hidden="true">{name}</span>
        </span>
      ) : (
        <span className="block min-w-0 truncate">{name}</span>
      )}
    </span>
  );
};
