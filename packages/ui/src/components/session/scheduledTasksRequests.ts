type TaskRequestGate = {
  begin: (projectID: string) => number;
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

export const mayCommitTaskList = (projectID: string, selectedProjectID: string): boolean => (
  !projectID || projectID === selectedProjectID
);

export const mayEndTaskLoad = (
  gate: TaskRequestGate,
  projectID: string,
  request: number,
  selectedProjectID: string,
): boolean => Boolean(projectID) && gate.isLatest(projectID, request) && projectID === selectedProjectID;
