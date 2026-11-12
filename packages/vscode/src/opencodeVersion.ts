/**
 * OpenChamber requires OpenCode 2.x: the API it talks to (`/api/*`, `/api/event`,
 * the v2 event vocabulary) does not exist on 1.x. A 1.x binary starts and serves
 * happily, so without this gate the user only sees an app that loads and then
 * fails every request. Parsing the CLI's own `--version` output lets us say what
 * is wrong before anything is spawned.
 */

/** OpenCode 2.x prints `opencode v2.0.2`; 1.x printed a bare `1.18.30`. */
export const parseOpenCodeVersion = (output: string): string | null => {
  const match = /(\d+)\.(\d+)\.(\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
};

const openCodeMajorVersion = (version: string): number | null => {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) ? major : null;
};

const REQUIRED_OPENCODE_MAJOR = 2;

type OpenCodeVersionCheck =
  | { supported: true; version: string }
  | { supported: false; version: string | null; reason: string };

export const checkOpenCodeVersionOutput = (output: string): OpenCodeVersionCheck => {
  const version = parseOpenCodeVersion(output);
  if (!version) {
    return {
      supported: false,
      version: null,
      reason: `Could not read the OpenCode version from "${output.trim() || '(no output)'}". OpenChamber requires OpenCode ${REQUIRED_OPENCODE_MAJOR}.x.`,
    };
  }
  const major = openCodeMajorVersion(version);
  if (major !== REQUIRED_OPENCODE_MAJOR) {
    return {
      supported: false,
      version,
      reason: `OpenCode ${version} is not supported. OpenChamber requires OpenCode ${REQUIRED_OPENCODE_MAJOR}.x — upgrade OpenCode, or point openchamber.opencodeBinary at a ${REQUIRED_OPENCODE_MAJOR}.x build.`,
    };
  }
  return { supported: true, version };
};
