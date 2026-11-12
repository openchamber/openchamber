export const hasUnknownMutationOutcomeCode = (error: Error): boolean => (
  'code' in error && error.code === 'SOURCE_CONTROL_MUTATION_OUTCOME_UNKNOWN'
);

export async function reconcileUnknownMutationOutcome(options: {
  error: Error;
  isCurrent: () => boolean;
  refresh: () => Promise<void>;
  scheduleRefresh: () => void;
}): Promise<boolean> {
  if (!hasUnknownMutationOutcomeCode(options.error) || !options.isCurrent()) return false;

  try {
    await options.refresh();
  } catch {
    // The delayed reads still get a chance to resolve an interrupted mutation.
  }
  if (options.isCurrent()) options.scheduleRefresh();
  return true;
}
