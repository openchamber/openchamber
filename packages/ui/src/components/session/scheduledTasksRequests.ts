/**
 * Which task-list response may touch the Scheduled Tasks view.
 *
 * Requests are numbered per project: a newer request for a project supersedes
 * an older one for the same project, whatever order the responses arrive in.
 * A response for another project is answered by the selection instead: only
 * the scope on screen may write the list or end its spinner.
 */
type TaskRequestGate = {
  /** Claims the next request number for a project. */
  begin: (projectID: string) => number;
  /** Whether this is still the newest request made for its project. */
  isLatest: (projectID: string, request: number) => boolean;
};

export const createTaskRequestGate = (): TaskRequestGate => {
  const latest = new Map<string, number>();
  return {
    begin: (projectID) => {
      const request = (latest.get(projectID) ?? 0) + 1;
      latest.set(projectID, request);
      return request;
    },
    isLatest: (projectID, request) => latest.get(projectID) === request,
  };
};

/** A list lands only for the scope on screen; the empty scope always may. */
export const mayCommitTaskList = (projectID: string, selectedProjectID: string): boolean => (
  !projectID || projectID === selectedProjectID
);

/** Only the newest load of the scope on screen ends its spinner. */
export const mayEndTaskLoad = (
  gate: TaskRequestGate,
  projectID: string,
  request: number,
  selectedProjectID: string,
): boolean => Boolean(projectID) && gate.isLatest(projectID, request) && projectID === selectedProjectID;
