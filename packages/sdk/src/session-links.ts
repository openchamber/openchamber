import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { GUEST_ATTACH_URL_MAX, clampAttachRequest, type AttachIssueRequest, type GuestCall, type HostRequestErrorCode } from './contract.ts';

export type SessionLinkRequest = AttachIssueRequest & { sessionId?: string };
export type SessionUnlinkRequest = { url: string; sessionId?: string };

export type GuestSessionLinkMessage = GuestCall<'session-link', SessionLinkRequest>;
export type GuestSessionUnlinkMessage = GuestCall<'session-unlink', SessionUnlinkRequest>;
export type GuestSessionLinkMessages = GuestSessionLinkMessage | GuestSessionUnlinkMessage;
export type GuestSessionLinkFeatures = { sessionLinks?: true };

export type GuestSessionLinkClient = {
  sessionLink: (request: SessionLinkRequest) => Promise<void>;
  sessionUnlink: (request: SessionUnlinkRequest) => Promise<void>;
};

export const guestSessionLinkCalls = (
  request: (message: GuestSessionLinkMessages) => Promise<void>,
  nextId: () => string,
  refuse: (code: HostRequestErrorCode, message: string) => Promise<never>,
  hostSupportsTargets: () => boolean,
): GuestSessionLinkClient => {
  const envelope = { channel: OPENCHAMBER_SDK_CHANNEL, v: OPENCHAMBER_SDK_API_VERSION } as const;
  const badTarget = (sessionId: string | undefined) => sessionId !== undefined && (!sessionId.trim() || sessionId.length > 1024);
  const unsupported = () => refuse('UNSUPPORTED', 'This OpenChamber cannot target a session or remove a link.');
  return {
    sessionLink: (payload) => {
      if (badTarget(payload.sessionId)) return refuse('HOST_REJECTED', 'Identity must contain 1 to 1024 characters.');
      if (payload.sessionId !== undefined && !hostSupportsTargets()) return unsupported();
      return request({ ...envelope, type: 'session-link', id: nextId(), payload: { ...clampAttachRequest(payload), sessionId: payload.sessionId } });
    },
    sessionUnlink: ({ url, sessionId }) => {
      if (badTarget(sessionId)) return refuse('HOST_REJECTED', 'Identity must contain 1 to 1024 characters.');
      if (!hostSupportsTargets()) return unsupported();
      const address = url.trim().slice(0, GUEST_ATTACH_URL_MAX);
      if (!address) return refuse('BAD_PATH', 'A link URL is required.');
      return request({ ...envelope, type: 'session-unlink', id: nextId(), payload: { url: address, sessionId } });
    },
  };
};
