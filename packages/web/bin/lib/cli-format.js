/**
 * Small presentation helpers shared by resource CLI commands. These are pure
 * formatting utilities — they must not contain validation or policy.
 */

function truncate(value, max = 60) {
  const str = typeof value === 'string' ? value : (value == null ? '' : String(value));
  if (str.length <= max) return str;
  if (max <= 1) return str.slice(0, max);
  return `${str.slice(0, max - 1)}…`;
}

function formatRelativeTime(epochMs, now = Date.now()) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'unknown';
  const deltaMs = now - epochMs;
  if (deltaMs < 0) return 'just now';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Format an epoch (ms) as `YYYY-MM-DD HH:mm` in the given IANA timezone (or
 * local time when none is provided). Returns null for non-positive values.
 */
function formatInstant(epochMs, timezone) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  try {
    const date = new Date(epochMs);
    const zoneOpts = timezone ? { timeZone: timezone } : {};
    const datePart = date.toLocaleDateString('en-CA', zoneOpts);
    const timePart = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...zoneOpts });
    return `${datePart} ${timePart}`;
  } catch {
    return new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Human-readable one-line summary of a scheduled task's schedule object.
 */
function formatSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'unknown schedule';
  const tz = typeof schedule.timezone === 'string' && schedule.timezone.trim() ? ` (${schedule.timezone.trim()})` : '';
  const times = Array.isArray(schedule.times) && schedule.times.length > 0
    ? schedule.times.join(', ')
    : (typeof schedule.time === 'string' ? schedule.time : '');

  switch (schedule.kind) {
    case 'daily':
      return `daily at ${times || '??:??'}${tz}`;
    case 'weekly': {
      const days = Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
        ? schedule.weekdays.slice().sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d] || d).join(', ')
        : '??';
      return `weekly on ${days} at ${times || '??:??'}${tz}`;
    }
    case 'once':
      return `once on ${schedule.date || '????-??-??'} ${schedule.time || '??:??'}${tz}`;
    case 'cron':
      return `cron "${schedule.cron || ''}"${tz}`;
    default:
      return `${schedule.kind || 'unknown'}${tz}`;
  }
}

function formatModel(model) {
  if (!model || typeof model !== 'object') return '';
  const provider = typeof model.providerID === 'string' ? model.providerID : '';
  const id = typeof model.id === 'string' ? model.id : (typeof model.modelID === 'string' ? model.modelID : '');
  if (provider && id) return `${provider}/${id}`;
  return id || provider || '';
}

export {
  truncate,
  formatRelativeTime,
  formatModel,
  formatInstant,
  formatSchedule,
};
