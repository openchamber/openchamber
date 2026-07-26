const ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;
const ID_COUNTER_LIMIT = 0x1000;
const HTTP_DATE_PATTERN = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

type ClockSample = {
  serverTimestamp: number;
  monotonicTimestamp: number;
};

type IdState = {
  timestamp: number;
  counter: number;
};

const clockSamples = new Map<string, ClockSample>();
const idStates = new Map<string, IdState>();

const readMonotonicNow = (wallClockFallback: number): number => {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return wallClockFallback;
};

const randomBase62 = (length: number): string => {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += ID_RANDOM_CHARS[bytes[index] % ID_RANDOM_CHARS.length];
  }
  return result;
};

export const observeRuntimeResponseDate = (
  runtimeKey: string,
  response: Response,
  receivedAt = Date.now(),
  monotonicReceivedAt = readMonotonicNow(receivedAt),
): void => {
  const dateHeader = response.headers.get('date') ?? '';
  if (!HTTP_DATE_PATTERN.test(dateHeader)) return;
  const serverTimestamp = Date.parse(dateHeader);
  if (!Number.isFinite(serverTimestamp)) return;
  clockSamples.set(runtimeKey, { serverTimestamp, monotonicTimestamp: monotonicReceivedAt });
};

export const getRuntimeTimestamp = (
  runtimeKey: string,
  clientTimestamp = Date.now(),
  monotonicTimestamp = readMonotonicNow(clientTimestamp),
): number => {
  const sample = clockSamples.get(runtimeKey);
  if (!sample) return clientTimestamp;
  return sample.serverTimestamp + Math.max(0, monotonicTimestamp - sample.monotonicTimestamp);
};

export const ascendingRuntimeId = (
  prefix: 'msg' | 'prt',
  runtimeKey: string,
  clientTimestamp = Date.now(),
  monotonicTimestamp = readMonotonicNow(clientTimestamp),
): string => {
  let timestamp = Math.floor(getRuntimeTimestamp(runtimeKey, clientTimestamp, monotonicTimestamp));
  const state = idStates.get(runtimeKey) ?? { timestamp: 0, counter: 0 };

  if (timestamp > state.timestamp) {
    state.timestamp = timestamp;
    state.counter = 0;
  } else {
    timestamp = state.timestamp;
  }

  state.counter += 1;
  if (state.counter >= ID_COUNTER_LIMIT) {
    state.timestamp += 1;
    state.counter = 1;
    timestamp = state.timestamp;
  }
  idStates.set(runtimeKey, state);

  const sortable = BigInt(timestamp) * BigInt(ID_COUNTER_LIMIT) + BigInt(state.counter);
  const timeBytes = new Uint8Array(6);
  for (let index = 0; index < timeBytes.length; index += 1) {
    timeBytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  const hex = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}${randomBase62(ID_RANDOM_LENGTH)}`;
};

export const resetRuntimeIdStateForTests = (): void => {
  clockSamples.clear();
  idStates.clear();
};
