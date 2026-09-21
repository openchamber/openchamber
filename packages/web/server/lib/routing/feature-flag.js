/**
 * Whether Jev model routing exists at all in this build.
 *
 * The feature ships dark, the same way agent memory does: with the flag unset
 * there is no Auto row in the model picker, no settings page, no routes and no
 * request rewriting. Read per call so only the process environment decides.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isRoutingFeatureAvailable = () => TRUTHY.has((process.env.OPENCHAMBER_ROUTING_ENABLE ?? '').trim().toLowerCase());
