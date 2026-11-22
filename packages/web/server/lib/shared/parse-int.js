// Strict plain-decimal integer parsing, consolidated from the eight
// private copies that used to spell this judgement per module
// (fs/routes.js, fs/search.js, guests/upload.js, opencode/lifecycle.js,
// opencode/self-handoff.js, opencode/draining-opencode.js,
// relay/host-client.js, ui-auth/ui-auth.js — design #802 phase 1, #803).
//
// Only a plain decimal spelling counts: optional surrounding whitespace,
// then ASCII digits only. A bare Number(...) or parseInt would silently
// honour '' and ' ' as 0, '1e3' as 1000, '0x10' as 16, '5000junk' as 5000,
// and '5.9' as a fractional value; every one of those yields the caller's
// fallback here instead. The spelling is unsigned: a leading '-' never
// parses, so a bounded range with a negative minimum is out of scope for
// this parser and stays a local variant.

// A positive whole number, else the fallback ('0' is not positive).
export const parsePositiveIntWithDefault = (raw, fallback) => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return fallback;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

// A whole number inside [min, max] (both inclusive), else the fallback.
// Zero is a real value here when min allows it: several callers use an
// explicit '0' to disable a timeout or window.
export const parseBoundedIntWithDefault = (raw, fallback, min, max) => {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return fallback;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
};
