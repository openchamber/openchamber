import * as React from 'react';

/** Emoji by shortcode name (`tada` → 🎉), as GitHub names them. */
export type EmojiShortcodes = ReadonlyMap<string, string>;

/** One emoji as the picker lists it: its names (the first is the main one) and the words it is found by. */
export type EmojiEntry = { emoji: string; names: readonly string[]; tags: readonly string[] };

export type EmojiTable = { entries: readonly EmojiEntry[]; shortcodes: EmojiShortcodes };

const SHORTCODE = /:([a-z0-9_+-]+):/g;

/** Whether the text holds anything shaped like a shortcode, before the table is worth loading. */
export const mayHoldEmojiShortcode = (text: string): boolean => /:[a-z0-9_+-]+:/.test(text);

let table: Promise<EmojiTable> | null = null;

/** GitHub's emoji table, read once on first use: most text names no shortcode and most fields never ask for one. */
export const loadEmojiTable = (): Promise<EmojiTable> => {
  table ??= import('gemoji')
    .then(({ gemoji }) => ({
      entries: gemoji,
      shortcodes: new Map(gemoji.flatMap((entry) => entry.names.map((name) => [name, entry.emoji] as const))),
    }))
    .catch((error: Error) => {
      // A failed chunk load is retried by the next text that needs it.
      table = null;
      throw error;
    });
  return table;
};

export const loadEmojiShortcodes = (): Promise<EmojiShortcodes> => loadEmojiTable().then(({ shortcodes }) => shortcodes);

/** The text with every known `:name:` replaced by its emoji; unknown names stay as written. */
export const replaceEmojiShortcodes = (text: string, shortcodes: EmojiShortcodes): string => (
  text.replace(SHORTCODE, (whole, name: string) => shortcodes.get(name) ?? whole)
);

/**
 * The emoji a typed `:query` finds, best first: a name that starts with it,
 * then a name that holds it, then a tag that starts with it (`:party` → 🎉).
 */
export const searchEmoji = (entries: readonly EmojiEntry[], query: string, limit: number): EmojiEntry[] => {
  const needle = query.toLowerCase();
  const ranked: EmojiEntry[][] = [[], [], []];
  for (const entry of entries) {
    if (entry.names.some((name) => name.startsWith(needle))) ranked[0].push(entry);
    else if (entry.names.some((name) => name.includes(needle))) ranked[1].push(entry);
    else if (entry.tags.some((tag) => tag.startsWith(needle))) ranked[2].push(entry);
  }
  return ranked.flat().slice(0, limit);
};

export type EmojiTableState = { table: EmojiTable | null; failed: boolean };

/**
 * The table once `active` asks for it and it has loaded. `failed` says the
 * load did not succeed (offline, a chunk a newer deploy removed), so a picker
 * can step aside instead of waiting for it; the next activation tries again.
 */
export function useEmojiTable(active: boolean): EmojiTableState {
  const [loaded, setLoaded] = React.useState<EmojiTable | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!active || loaded) return;
    let live = true;
    setFailed(false);
    loadEmojiTable().then((value) => {
      if (live) setLoaded(value);
    }, () => {
      if (live) setFailed(true);
    });
    return () => { live = false; };
  }, [active, loaded]);
  return { table: active ? loaded : null, failed: active && failed };
}

/** The shortcodes once `text` needs them and they have loaded; null before then, and for text without shortcodes. */
export function useEmojiShortcodes(text: string): EmojiShortcodes | null {
  return useEmojiTable(mayHoldEmojiShortcode(text)).table?.shortcodes ?? null;
}

/**
 * The `:query` being typed at the caret, or null: a colon at the start of the
 * text or after whitespace, then at least two letters of a name. `12:30`,
 * `http://`, `key: value` and `:)` open nothing.
 */
export function matchEmojiTrigger(value: string, caret: number): string | null {
  const match = /(?:^|\s):([a-z0-9_+-]{2,})$/i.exec(value.slice(0, caret));
  return match ? match[1].toLowerCase() : null;
}
