export type OmniCategory = 'all' | 'sessions' | 'messages' | 'commands' | 'files';
export type OmniLifecycle = 'active' | 'archived' | 'all';
export type OmniSearchIn = 'everything' | 'titles';
export type OmniAuthor = 'any' | 'user' | 'assistant' | 'reasoning';
export type OmniFilters = { category?: OmniCategory; lifecycle?: OmniLifecycle; project?: string; worktree?: string; author?: OmniAuthor; searchIn?: OmniSearchIn };
export type OmniQuery = { text: string; filters: OmniFilters };

export type OmniFlagKey = keyof OmniFilters;
const names = { category: 'type', lifecycle: 'in', project: 'project', worktree: 'worktree', author: 'author', searchIn: 'search' } satisfies Record<OmniFlagKey, string>;

export const tokenizeOmniQuery = (raw: string): string[] => {
  const tokens: string[] = [];
  let token = '';
  let quoted = false;
  for (const character of raw) {
    if (character === '"') quoted = !quoted;
    if (/\s/.test(character) && !quoted) {
      if (token) tokens.push(token);
      token = '';
    } else token += character;
  }
  if (token) tokens.push(token);
  return tokens;
};

const flag = (token: string): [string, string] | null => {
  const match = /^([a-z]+):(?:"([^"]+)"|([^\s"]+))$/i.exec(token);
  return match ? [match[1], match[2] ?? match[3]] : null;
};

type DecodedOmniFlag =
  | { key: 'category'; value: OmniCategory }
  | { key: 'lifecycle'; value: OmniLifecycle }
  | { key: 'project'; value: string }
  | { key: 'worktree'; value: string }
  | { key: 'author'; value: OmniAuthor }
  | { key: 'searchIn'; value: OmniSearchIn };

const decode = (name: string, raw: string): DecodedOmniFlag | null => {
  const value = raw.toLocaleLowerCase();
  if (name === 'type' && ['session', 'message', 'command', 'file', 'all'].includes(value)) return { key: 'category', value: value === 'session' ? 'sessions' : value === 'message' ? 'messages' : value === 'command' ? 'commands' : value === 'file' ? 'files' : 'all' };
  if (name === 'in' && (value === 'active' || value === 'archived' || value === 'all')) return { key: 'lifecycle', value };
  if (name === 'project') return { key: 'project', value: raw };
  if (name === 'worktree') return { key: 'worktree', value: raw };
  if (name === 'search' && (value === 'titles' || value === 'everything')) return { key: 'searchIn', value };
  const author = value === 'you' ? 'user' : value === 'agent' ? 'assistant' : value;
  if (name === 'author' && (author === 'any' || author === 'user' || author === 'assistant' || author === 'reasoning')) return { key: 'author', value: author };
  return null;
};

export const decodeOmniFlag = (token: string): DecodedOmniFlag | null => {
  const candidate = flag(token);
  return candidate ? decode(candidate[0].toLocaleLowerCase(), candidate[1]) : null;
};

export function parseOmniQuery(raw: string): OmniQuery {
  const filters: OmniFilters = {};
  const text = tokenizeOmniQuery(raw).filter((token) => {
    const decoded = decodeOmniFlag(token);
    if (!decoded) return true;
    switch (decoded.key) {
      case 'category': filters.category = decoded.value; break;
      case 'lifecycle': filters.lifecycle = decoded.value; break;
      case 'project': filters.project = decoded.value; break;
      case 'worktree': filters.worktree = decoded.value; break;
      case 'author': filters.author = decoded.value; break;
      case 'searchIn': filters.searchIn = decoded.value; break;
    }
    return false;
  }).join(' ');
  return { text, filters };
}

export function setOmniFlag<K extends OmniFlagKey>(raw: string, key: K, value: OmniFilters[K] | null): string {
  const rest = tokenizeOmniQuery(raw).filter((token) => {
    const candidate = flag(token);
    return !candidate || decode(candidate[0].toLocaleLowerCase(), candidate[1])?.key !== key;
  }).join(' ');
  if (value === null || value === undefined) return rest;
  const encoded = value === 'sessions' ? 'session' : value === 'messages' ? 'message' : value === 'commands' ? 'command' : value === 'files' ? 'file' : value;
  const encodedFlag = `${names[key]}:${/\s/.test(encoded) ? `"${encoded}"` : encoded}`;
  if (!rest) return encodedFlag;
  return (raw.match(/"/g)?.length ?? 0) % 2 === 1 ? `${encodedFlag} ${rest}` : `${rest} ${encodedFlag}`;
}
