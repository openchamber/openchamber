const GRAPH_HEIGHT_MIN = 180;
const GRAPH_HEIGHT_MAX = 720;
const GRAPH_HEIGHT_DEFAULT = 280;

export const clampGitGraphPaneHeight = (value: number): number => {
  if (!Number.isFinite(value)) {
    return GRAPH_HEIGHT_DEFAULT;
  }

  return Math.min(GRAPH_HEIGHT_MAX, Math.max(GRAPH_HEIGHT_MIN, Math.round(value)));
};
