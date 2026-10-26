/**
 * Whether the overview page exists at all in this process.
 *
 * The page is still being designed against real work, so it ships dark: with
 * `OPENCHAMBER_OVERVIEW_ENABLED` unset there is no sidebar button, no command
 * palette item, no phone footer button and nothing mounted, so a release can
 * carry the code while users see nothing. The server reports the answer to the
 * client in the settings payload (`overviewFeatureAvailable`); the page itself
 * lives in `packages/ui/src/components/overview`.
 *
 * Read per call rather than captured at import, so a process started with the
 * variable set is the only thing that decides; no build step bakes it in.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isOverviewFeatureAvailable = () => {
  const raw = process.env.OPENCHAMBER_OVERVIEW_ENABLED;
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
};
