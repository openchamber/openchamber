const GRAPH_HEIGHT_MIN = 180;
const GRAPH_HEIGHT_MAX = 720;

export const clampGitGraphPaneHeight = (value: number): number => Math.min(GRAPH_HEIGHT_MAX, Math.max(GRAPH_HEIGHT_MIN, Math.round(value)));
