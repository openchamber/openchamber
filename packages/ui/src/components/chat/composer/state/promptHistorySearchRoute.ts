type PromptHistorySearchHandler = (event: KeyboardEvent) => boolean;

const routeOwners = new WeakMap<Element, PromptHistorySearchHandler>();

export function registerPromptHistorySearchRoute(
    owner: Element,
    handler: PromptHistorySearchHandler,
): () => void {
    routeOwners.set(owner, handler);
    return () => routeOwners.delete(owner);
}

export function dispatchPromptHistorySearch(event: KeyboardEvent): boolean {
    const target = event.target;
    if (!(target instanceof Element)) return false;
    for (let element: Element | null = target; element; element = element.parentElement) {
        const handler = routeOwners.get(element);
        if (handler) return handler(event);
    }
    return false;
}
