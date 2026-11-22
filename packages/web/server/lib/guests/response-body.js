// The bounded response readers live in lib/shared (design #802 phase 1,
// issue #803); this module re-exports them so existing importers
// (opencode/proxy.js, opencode/mcpx-daemon.js, routing/jev.js) are untouched.
export { discardResponseBody, readBoundedResponseBytes, readBoundedResponseText } from '../shared/response-body.js';
