import * as path from 'path';

import { createOpenCodeTrust } from '../../web/server/lib/opencode-trust/index.js';
import { getOpenChamberDataDir } from './openchamberSessionState';

/**
 * The folder trust check the bridge runs before forwarding to OpenCode
 * (`web/server/lib/opencode-trust`). The answers file is the desktop app's,
 * so a folder trusted in one is trusted in the other. The global event
 * watcher reports folders OpenCode closes, so a trusted answer holds until
 * then.
 */
export const openCodeTrust = createOpenCodeTrust({ storePath: path.join(getOpenChamberDataDir(), 'opencode-trust.json') });
