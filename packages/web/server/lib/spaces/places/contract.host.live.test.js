import { runPlaceContractSuite } from './contract-suite.js';
import { createLiveHostPlace, LIVE_HOSTD_ENABLED, liveHostUid } from './host-live-support.js';

runPlaceContractSuite('hostd isolated user', { enabled: LIVE_HOSTD_ENABLED, setup: createLiveHostPlace, spaceUid: liveHostUid });
