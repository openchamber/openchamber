import React from 'react';

export const useToolbarStep = (ref: React.RefObject<HTMLElement | null> | undefined, step: string, watching: boolean): boolean => {
  const [taken, setTaken] = React.useState(false);
  React.useLayoutEffect(() => {
    const toolbar = ref?.current;
    if (!watching || !toolbar) return;
    const read = () => setTaken(toolbar.hasAttribute(step));
    read();
    const observer = new MutationObserver(read);
    observer.observe(toolbar, { attributes: true, attributeFilter: [step] });
    return () => observer.disconnect();
  }, [ref, step, watching]);
  return taken;
};
