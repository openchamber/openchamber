import { runEscapeSuite } from './escape-suite.js';
import { createLiveHostPlace, LIVE_HOSTD_ENABLED, liveHostUid } from './host-live-support.js';

runEscapeSuite('hostd isolated user', { enabled: LIVE_HOSTD_ENABLED, setup: createLiveHostPlace, spaceUid: liveHostUid, hostBackend: true });
