export type ServerTagged<T> = T & { readonly serverId: string };

export function tagServerEvent<T>(event: T, serverId: string): ServerTagged<T> {
  return { ...(event as object), serverId } as unknown as ServerTagged<T>;
}

export function unwrapServerEvent<T>(tagged: ServerTagged<T>): { serverId: string; event: T } {
  if (!tagged || typeof tagged !== "object") {
    throw new Error("SSE event is null or not an object");
  }
  if (typeof tagged.serverId !== 'string' || !tagged.serverId) {
    throw new Error("SSE event missing required serverId field");
  }
  const { serverId, ...event } = tagged as ServerTagged<T> & { serverId: string };
  return { serverId, event: event as unknown as T };
}
