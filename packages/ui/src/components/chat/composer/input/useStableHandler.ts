import React from 'react';

export /**
 * An event handler with one identity for the composer's lifetime that runs the
 * latest render's closure. Handlers that read the draft text would otherwise
 * be new on every keystroke and re-render every memoized child they reach.
 * Event handlers only: calling the result during render runs a stale closure.
 */
function useStableHandler<Args extends readonly unknown[], Result>(
    handler: (...args: Args) => Result,
): (...args: Args) => Result {
    const handlerRef = React.useRef(handler);
    React.useLayoutEffect(() => {
        handlerRef.current = handler;
    });
    return React.useCallback((...args: Args) => handlerRef.current(...args), []);
}