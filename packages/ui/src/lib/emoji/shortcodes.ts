import * as React from 'react';

export type EmojiShortcodes = ReadonlyMap<string, string>;

export type EmojiEntry = { emoji: string; names: readonly string[]; tags: readonly string[] };

export type EmojiTable = { entries: readonly EmojiEntry[]; shortcodes: EmojiShortcodes };

const SHORTCODE = /:([a-z0-9_+-]+):/g;

export const mayHoldEmojiShortcode = (text: string): boolean => /:[a-z0-9_+-]+:/.test(text);

let table: Promise<EmojiTable> | null = null;

export const loadEmojiTable = (): Promise<EmojiTable> => {
  table ??= import('gemoji')
    .then(({ gemoji }) => ({
      entries: gemoji,
      shortcodes: new Map(gemoji.flatMap((entry) => entry.names.map((name) => [name, entry.emoji] as const))),
    }))
    .catch((error: Error) => {
      table = null;
      throw error;
    });
  return table;
};

export const loadEmojiShortcodes = (): Promise<EmojiShortcodes> => loadEmojiTable().then(({ shortcodes }) => shortcodes);

export const replaceEmojiShortcodes = (text: string, shortcodes: EmojiShortcodes): string => (
  text.replace(SHORTCODE, (whole, name: string) => shortcodes.get(name) ?? whole)
);

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

export function useEmojiShortcodes(text: string): EmojiShortcodes | null {
  return useEmojiTable(mayHoldEmojiShortcode(text)).table?.shortcodes ?? null;
}

export function matchEmojiTrigger(value: string, caret: number): string | null {
  const match = /(?:^|\s):([a-z0-9_+-]{2,})$/i.exec(value.slice(0, caret));
  return match ? match[1].toLowerCase() : null;
}
