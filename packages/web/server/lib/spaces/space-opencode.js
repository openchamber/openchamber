// The one place that writes OpenCode's own files inside a space, so an OpenCode format change is
// a one-file edit (DESIGN.md, "Parts"). Today: the provider configuration that sends a provider's
// model calls through the gatekeeper's window. The login record for the short OpenAI token and
// the move of a chat to the host's archive belong here too, in their stages.
//
// What is written here cooperates and enforces nothing. The agent can change or delete the file;
// the gatekeeper is what keeps the key out of the space and the space away from the internet.

import { SpaceError } from './errors.js';
import { tail } from './exec-http.js';
import { IMAGE_ONLY_PATH, IMAGE_SH, SPACE_OPENCODE_CONFIG_DIRECTORY, SPACE_OPENCODE_CONFIG_PATH, spaceWindowUrl } from './layout.js';

// OpenCode takes a key from this option and its auth plugins stay out of the way; the window
// throws it away and puts the real one in its place. It is not a secret and never was one.
export const WINDOW_PLACEHOLDER_KEY = 'space-window';

// Through a temporary name, so OpenCode never reads half a file. The configuration is JSON on
// stdin: nothing of it is an argument.
const WRITE_CONFIG_SCRIPT = [
  IMAGE_ONLY_PATH,
  `mkdir -p ${SPACE_OPENCODE_CONFIG_DIRECTORY}`,
  `&& cat > ${SPACE_OPENCODE_CONFIG_PATH}.new && mv ${SPACE_OPENCODE_CONFIG_PATH}.new ${SPACE_OPENCODE_CONFIG_PATH}`,
].join(' ');

/**
 * OpenCode's global configuration for a space with these model grants: each provider, under the
 * id the host's catalog gives it, with its base URL at the window and a placeholder key. The
 * composer offers the host's catalog, and the same provider id inside is what makes that choice
 * work in the space unchanged. Decided with the maintainer on 2026-09-26.
 */
export function buildProviderConfig(grants) {
  const provider = {};
  for (const grant of grants) {
    if (grant.kind !== 'model') continue;
    provider[grant.provider] = { options: { baseURL: spaceWindowUrl(grant.id), apiKey: WINDOW_PLACEHOLDER_KEY } };
  }
  return { $schema: 'https://opencode.ai/config.json', provider };
}

/** `exec` is the place operation, always for the space container. */
export function createSpaceOpenCode({ exec }) {
  /** Writes the whole global configuration from the model grants the record holds. */
  const writeProviderConfig = async (spaceId, grants) => {
    const text = `${JSON.stringify(buildProviderConfig(grants), null, 2)}\n`;
    const result = await exec(spaceId, [IMAGE_SH, '-c', WRITE_CONFIG_SCRIPT], { stdin: text });
    if (result.code !== 0) {
      throw new SpaceError('space_setup_failed', `Could not write the provider configuration inside the space: ${tail(result.stderr) || `exit code ${result.code}`}`);
    }
  };

  return { writeProviderConfig };
}
