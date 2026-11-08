/** MiniMax's `base_resp` envelope as it arrives in the response body. */
export type MiniMaxBaseResp = {
  status_code?: unknown;
  status_msg?: unknown;
};

export function miniMaxStatusError(baseResp: MiniMaxBaseResp | null | undefined): string | null;
