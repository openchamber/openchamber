const CORE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
/** `1.22.0` or `>=1.22.0`. Ranges beyond a floor are not accepted. */
export const OPENCHAMBER_ENGINE_PATTERN = /^(>=)?\d+\.\d+\.\d+$/;

export type OpenChamberVersionParts = {
  major: number;
  minor: number;
  patch: number;
};

export const parseOpenChamberVersion = (value: string): OpenChamberVersionParts | null => {
  const core = String(value || '').trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '';
  const match = CORE_VERSION.exec(core);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
};

export const compareOpenChamberVersions = (left: string, right: string): number => {
  const a = parseOpenChamberVersion(left);
  const b = parseOpenChamberVersion(right);
  if (!a || !b) {
    return 0;
  }
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
};

/** Normalize `>=1.22.0` / `1.22.0` to the floor version string. */
export const openChamberEngineMinimum = (engine: string): string | null => {
  const trimmed = engine.trim();
  if (!OPENCHAMBER_ENGINE_PATTERN.test(trimmed)) {
    return null;
  }
  const floor = trimmed.startsWith('>=') ? trimmed.slice(2) : trimmed;
  return parseOpenChamberVersion(floor) ? floor : null;
};

/**
 * True when this OpenChamber build is new enough for the guest's `engines.openchamber`.
 * Unknown host versions fail closed when an engine is declared.
 */
export const hostMeetsOpenChamberEngine = (
  hostVersion: string,
  engine: string,
): boolean => {
  const minimum = openChamberEngineMinimum(engine);
  if (!minimum) {
    return false;
  }
  if (!parseOpenChamberVersion(hostVersion)) {
    return false;
  }
  return compareOpenChamberVersions(hostVersion, minimum) >= 0;
};
