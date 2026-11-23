import React from 'react';

export function useScrollToSection() {
  const nodesRef = React.useRef(new Map<string, HTMLElement>());
  const pendingRef = React.useRef<string | null>(null);
  const [target, setTarget] = React.useState<string | null>(null);

  React.useLayoutEffect(() => {
    if (!target) return;
    const node = nodesRef.current.get(target);
    if (node) {
      pendingRef.current = null;
      node.scrollIntoView({ block: 'start' });
    } else {
      pendingRef.current = target;
    }
    setTarget(null);
  }, [target]);

  const registerSectionRef = React.useCallback((key: string, node: HTMLElement | null) => {
    if (!node) {
      nodesRef.current.delete(key);
      return;
    }
    nodesRef.current.set(key, node);
    if (pendingRef.current === key) {
      pendingRef.current = null;
      node.scrollIntoView({ block: 'start' });
    }
  }, []);

  return { registerSectionRef, scrollTo: setTarget };
}
