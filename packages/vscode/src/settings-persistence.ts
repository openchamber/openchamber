export const mergeSettingsForPersistence = <Current extends object, Changes extends object>(
  current: Current,
  changes: Changes,
  keysToClear: ReadonlySet<PropertyKey>,
) => {
  const next = { ...current, ...changes };
  for (const key of keysToClear) {
    Reflect.deleteProperty(next, key);
  }
  return next;
};
