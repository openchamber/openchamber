import React from 'react';

export const FileNameText: React.FC<{ name: string; folder?: string }> = ({ name, folder }) => (
  folder ? (
    <span dir="ltr"><span className="text-muted-foreground opacity-70">{folder}/</span>{name}</span>
  ) : <>{name}</>
);

export const ScrollingFileName: React.FC<{ name: string; folder?: string }> = ({ name, folder }) => {
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
  }, [name, folder]);

  const text = <FileNameText name={name} folder={folder} />;
  return (
    <span ref={containerRef} className="relative block min-w-0 flex-1 overflow-hidden whitespace-nowrap">
      <span ref={textRef} aria-hidden="true" className="invisible absolute whitespace-nowrap">{text}</span>
      {overflowing ? (
        <span key={`${folder}/${name}`} className="open-file-name-marquee-track">
          <span className="open-file-name-marquee-item">{text}</span>
          <span className="open-file-name-marquee-item" aria-hidden="true">{text}</span>
        </span>
      ) : (
        <span className="block min-w-0 truncate">{text}</span>
      )}
    </span>
  );
};
