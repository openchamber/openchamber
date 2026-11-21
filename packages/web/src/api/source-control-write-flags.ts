type WriteFlags = {
  writeAccess?: boolean;
  locked?: boolean;
  subscribed?: boolean;
};

const LABELS = { writeAccess: 'write access', locked: 'lock', subscribed: 'subscription' } as const;

export const writeFlags = (payload: WriteFlags, subject = ''): WriteFlags => {
  const flags: WriteFlags = {};
  for (const key of ['writeAccess', 'locked', 'subscribed'] as const) {
    const value = payload[key];
    if (value === undefined) continue;
    if (Object.prototype.toString.call(value) !== '[object Boolean]') {
      throw new Error(`Source control response contained an invalid ${subject}${LABELS[key]}`);
    }
    flags[key] = value;
  }
  return flags;
};
