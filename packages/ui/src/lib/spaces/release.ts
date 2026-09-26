// Whether the isolated-spaces feature is released to users. It is being built behind its
// switch, and releases ship before it is whole, so the switch's row in Settings and its search
// entry stay hidden until the first release of the feature (docs/isolated-spaces/STAGES.md,
// "First release"); the `isolatedSpacesEnabled` key in settings.json still works for the people
// building it. Flip this in that release; nothing else needs to change.
export const ISOLATED_SPACES_RELEASED = false;
