// Version order for update checks and release notes: semver precedence,
// so a Canary build (2.5.4-canary.20261030.6) sorts after 2.5.3, before
// 2.5.4, and Canary builds of one release by day and run.

function parseVersionForComparison(value) {
  const normalized = String(value || '').replace(/^v/, '').split('+')[0];
  const prereleaseIndex = normalized.indexOf('-');
  const core = prereleaseIndex >= 0 ? normalized.slice(0, prereleaseIndex) : normalized;
  const parts = core.split('.').map((part) => {
    const parsed = Number.parseInt(part || '0', 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });

  return {
    parts,
    prerelease: prereleaseIndex >= 0 ? normalized.slice(prereleaseIndex + 1).split('.') : null,
  };
}

// Semver precedence of two pre-release tags: numeric identifiers compare as
// numbers and before text, so 2.5.4-canary.20261031.7 follows
// 2.5.4-canary.20261030.6.
function comparePrerelease(a, b) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNumeric = /^\d+$/.test(a[index]);
    const bNumeric = /^\d+$/.test(b[index]);
    if (aNumeric && bNumeric) {
      const diff = Number(a[index]) - Number(b[index]);
      if (diff !== 0) return diff;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(left, right) {
  const a = parseVersionForComparison(left);
  const b = parseVersionForComparison(right);
  const length = Math.max(a.parts.length, b.parts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (diff !== 0) return diff;
  }

  if (!a.prerelease || !b.prerelease) {
    if (a.prerelease) return -1;
    return b.prerelease ? 1 : 0;
  }

  return comparePrerelease(a.prerelease, b.prerelease);
}
