import React from 'react';

export function useStableHandler<Args extends readonly unknown[], Result>(
    handler: (...args: Args) => Result,
): (...args: Args) => Result {
    const handlerRef = React.useRef(handler);
    React.useLayoutEffect(() => {
        handlerRef.current = handler;
    });
    return React.useCallback((...args: Args) => handlerRef.current(...args), []);
}
