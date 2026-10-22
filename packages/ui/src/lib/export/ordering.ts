/**
 * The order the export's events are written in.
 *
 * The export never invents a chronology. An event is placed by the time the
 * source recorded for it, and an event without a time keeps the place the
 * source gave it: it sits where its own record put it, between the timed
 * events around it.
 *
 * Both the readable view and the JSON export read this one rule, so the two
 * cannot disagree about when something happened.
 */

/** An item the export places in a sequence. */
type OrderedItem = {
  /** The time the source recorded, when it recorded one. */
  timestamp?: number;
  /** The place the source gave the item, inside its own session. */
  sourceOrder: number;
  /** The session the item belongs to. */
  sessionID: string;
};

/**
 * The time each item is placed by.
 *
 * An item without a recorded time is placed by the timed item that follows
 * it in its own session, so it lands right before that item — the place the
 * source gave it. An item that has no timed item after it is placed by the
 * timed item before it, so it lands right after that one.
 *
 * The item's own time is not changed: only the place it is written at. An
 * item whose whole session carries no time at all has nothing to be placed
 * by, and keeps its source order.
 */
const placeByRecordedTime = <T extends OrderedItem>(
  items: readonly T[],
): Map<T, number | undefined> => {
  const bySession = new Map<string, T[]>();
  for (const item of items) {
    const list = bySession.get(item.sessionID) ?? [];
    list.push(item);
    bySession.set(item.sessionID, list);
  }

  const places = new Map<T, number | undefined>();
  for (const list of bySession.values()) {
    const inSourceOrder = [...list].sort((left, right) => left.sourceOrder - right.sourceOrder);
    let previousTime: number | undefined;
    for (const [index, item] of inSourceOrder.entries()) {
      if (item.timestamp !== undefined) {
        places.set(item, item.timestamp);
        previousTime = item.timestamp;
        continue;
      }
      // The next timed item of the same session is the one this item sits
      // in front of; without one, it sits behind the last timed item.
      const next = inSourceOrder.slice(index + 1).find((candidate) => candidate.timestamp !== undefined);
      places.set(item, next?.timestamp ?? previousTime);
    }
  }
  return places;
};

/**
 * The items in the order the export writes them.
 *
 * The source order comes first: it is the order the source recorded, and it
 * says where an item without a time belongs. The times then decide between
 * the items that carry one, and the source order breaks ties.
 */
export const orderByRecordedTime = <T extends OrderedItem>(items: readonly T[]): T[] => {
  const bySource = [...items].sort((left, right) => (
    left.sourceOrder - right.sourceOrder || left.sessionID.localeCompare(right.sessionID)
  ));
  const places = placeByRecordedTime(bySource);

  return [...bySource].sort((left, right) => {
    const leftTime = places.get(left);
    const rightTime = places.get(right);
    if (leftTime !== rightTime) {
      // A session whose records carry no time at all has nothing to be
      // placed by. It keeps its own order, after the events that do.
      if (leftTime === undefined) return 1;
      if (rightTime === undefined) return -1;
      return leftTime - rightTime;
    }
    if (left.sourceOrder !== right.sourceOrder) return left.sourceOrder - right.sourceOrder;
    return left.sessionID.localeCompare(right.sessionID);
  });
};
