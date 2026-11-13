import { rangesWithin, type MatchRange } from '@/lib/search/matchSegments';

export const splitRelativePath = (relativePath: string): { name: string; directory: string } => {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1
    ? { name: relativePath, directory: '' }
    : { name: relativePath.slice(slash + 1), directory: relativePath.slice(0, slash) };
};

/**
 * A file row shows its name, then its folder. The matcher ran on the whole
 * relative path, so each part takes the matches inside it.
 */
export const fileRowMatchRanges = (
  path: string,
  ranges: ReadonlyArray<MatchRange>,
) => {
  const { name, directory } = splitRelativePath(path);
  return {
    name,
    directory,
    nameRanges: rangesWithin(ranges, path.length - name.length, path.length),
    directoryRanges: rangesWithin(ranges, 0, directory.length),
  };
};

/**
 * A project row shows its name, then its path. The matcher ran on
 * `"<label> <path>"`; a project without a label is named after the path's
 * last segment, so the name takes that segment's matches.
 */
export const projectRowMatchRanges = (
  project: { label?: string; path: string; displayName: string },
  ranges: ReadonlyArray<MatchRange>,
) => {
  const pathStart = (project.label || '').length + 1;
  const nameStart = project.label ? 0 : pathStart + project.path.length - project.displayName.length;
  return {
    nameRanges: rangesWithin(ranges, nameStart, nameStart + project.displayName.length),
    pathRanges: rangesWithin(ranges, pathStart, pathStart + project.path.length),
  };
};
