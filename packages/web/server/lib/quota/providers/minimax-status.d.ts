export type MiniMaxBaseResp = {
  status_code?: unknown;
  status_msg?: unknown;
};

export function miniMaxStatusError(baseResp: MiniMaxBaseResp | null | undefined): string | null;
