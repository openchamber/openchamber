const MS_PER_HOUR = 3_600_000;
const MIN_SAMPLE_SPAN_MS = 60_000;

export const computeBurn = (samples) => {
  const empty = { burnPerHour: null, runwaySeconds: null };
  if (!Array.isArray(samples) || samples.length < 2) return empty;

  const last = samples.length - 1;
  let segStart = last;
  for (let i = last - 1; i >= 0; i -= 1) {
    // Walk back only while balance is non-increasing forward in time; a rise
    // means a top-up, so anchor on the post-top-up segment to avoid negative burn.
    if (samples[i].balanceUsd >= samples[i + 1].balanceUsd) {
      segStart = i;
    } else {
      break;
    }
  }

  const start = samples[segStart];
  const end = samples[last];
  const dtMs = end.at - start.at;
  if (segStart === last || dtMs < MIN_SAMPLE_SPAN_MS) return empty;

  const delta = start.balanceUsd - end.balanceUsd;
  if (delta <= 0) return empty;

  const burnPerHour = delta / (dtMs / MS_PER_HOUR);
  const runwaySeconds = burnPerHour > 0 ? (end.balanceUsd / burnPerHour) * 3600 : null;
  return { burnPerHour, runwaySeconds };
};
