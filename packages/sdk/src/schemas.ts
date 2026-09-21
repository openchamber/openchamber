// Host-side parsing. OpenChamber (browser host and server) imports this to
// validate an untrusted guest's manifest and messages with zod. Guests import
// `@openchamber/sdk`, which carries no schema library.
export {
  openChamberManifestSchema,
  PACKAGE_VERSION_PATTERN,
  packageManifestSchema,
  parseManifest,
  parseManifestJson,
} from './parse.ts';
export type { ManifestDocument } from './parse.ts';
export { guestStorageRequestSchema, guestStorageResultSchema, guestWorkspaceSnapshotSchema } from './workspace-schemas.ts';
export {
  guestMessageSchema,
  hostMessageSchema,
  parseGuestMessage,
  parseHostMessage,
} from './protocol.ts';
export { browserControlActionSchema, browserProviderResultSchema } from './service-provider-schemas.ts';
export {
  surfaceClipboardAnswerSchema,
  surfaceControllerSchema,
  surfaceHostMessageSchema,
  surfaceInputEventSchema,
  surfaceResizeAnswerSchema,
  surfaceViewerMessageSchema,
} from './service-surface-schemas.ts';
export type { SurfaceHostMessage, SurfaceViewerMessage } from './service-surface-schemas.ts';
