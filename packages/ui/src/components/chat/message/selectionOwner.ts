const QUOTE_ROOT_SELECTOR = '[data-chat-quote-root]';

const elementOf = (node: Node): Element | null => (node instanceof Element ? node : node.parentElement);

const messageIdOf = (node: Node): string | null => (
  elementOf(node)?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null
);

export const ownsSelection = (container: HTMLElement, range: Range): boolean => {
  const start = elementOf(range.startContainer);
  if (container.matches(QUOTE_ROOT_SELECTOR) && container.contains(start) && start?.closest(QUOTE_ROOT_SELECTOR) !== container) return false;
  if (container.contains(range.commonAncestorContainer)) return true;
  if (!container.contains(range.startContainer)) return false;
  const messageId = messageIdOf(container);
  return messageId !== null && messageId === messageIdOf(range.endContainer);
};
