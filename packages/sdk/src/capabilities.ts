import type { GuestActionContribution, GuestServiceProvides, OpenChamberContributes, ServiceContribution } from './manifest.ts';

export const GUEST_CAPABILITIES = ['prompt', 'sessions', 'files', 'model', 'shells', 'microphone', 'conversation', 'service', 'network', 'filesystem', 'origins', 'transcript', 'sessionControl', 'sessionAnswers', 'instructions', 'skills', 'opencodePlugin', 'opencode', 'links', 'wake', 'marks', 'providerAccounts'] as const;
export type GuestCapability = (typeof GUEST_CAPABILITIES)[number];

export const DECLARED_GUEST_CAPABILITIES = ['prompt', 'sessions', 'files', 'model', 'shells', 'microphone'] as const;
export type DeclaredGuestCapability = (typeof DECLARED_GUEST_CAPABILITIES)[number];

export const serviceProvides = (
  service: Pick<ServiceContribution, 'provides'> | undefined,
  role: GuestServiceProvides,
): boolean => Boolean(service?.provides?.includes(role));

export const guestActionsNeedConversation = (
  actions: readonly GuestActionContribution[] | undefined,
): boolean => Boolean(actions?.some((action) => action.payload?.includes('messages')));

export type PublicGuestCapabilities = {
  requested: GuestCapability[];
  granted: GuestCapability[];
};

export const requestedGuestCapabilities = (
  contributes: Pick<OpenChamberContributes, 'capabilities' | 'integration' | 'service' | 'filesystem' | 'actions' | 'origins' | 'sessionEvents' | 'sessionControl' | 'instructions' | 'skills' | 'opencodePlugin' | 'links' | 'waits' | 'marks' | 'providerAccounts'>,
): GuestCapability[] => {
  const declared = new Set<GuestCapability>(contributes.capabilities ?? []);
  if (guestActionsNeedConversation(contributes.actions)) declared.add('conversation');
  if (contributes.service) declared.add('service');
  if (serviceProvides(contributes.service, 'opencode')) declared.add('opencode');
  if (contributes.integration) declared.add('network');
  if (contributes.filesystem && contributes.filesystem.length > 0) declared.add('filesystem');
  if (contributes.origins && contributes.origins.length > 0) declared.add('origins');
  if (contributes.sessionEvents?.content || contributes.sessionControl?.content) declared.add('transcript');
  if (contributes.sessionControl) declared.add('sessionControl');
  if (contributes.sessionControl?.answers) declared.add('sessionAnswers');
  if (contributes.instructions) declared.add('instructions');
  if (contributes.skills) declared.add('skills');
  if (contributes.opencodePlugin) declared.add('opencodePlugin');
  if (contributes.links) declared.add('links');
  if (contributes.waits && contributes.waits.length > 0) declared.add('wake');
  if (contributes.marks) declared.add('marks');
  if (contributes.providerAccounts) declared.add('providerAccounts');
  return GUEST_CAPABILITIES.filter((capability) => declared.has(capability));
};

export const isGuestApproved = (capabilities: PublicGuestCapabilities): boolean => (
  capabilities.requested.every((capability) => capabilities.granted.includes(capability))
);

export const hasGuestCapability = (
  capabilities: PublicGuestCapabilities,
  capability: GuestCapability,
): boolean => capabilities.granted.includes(capability);
