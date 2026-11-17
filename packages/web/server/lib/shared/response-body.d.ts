export type BoundedResponseText = { tooLarge: false; text: string } | { tooLarge: true };

export type BoundedResponseBytes = { tooLarge: false; bytes: Buffer } | { tooLarge: true };

export function readBoundedResponseText(response: Response, maxBytes: number): Promise<BoundedResponseText>;
export function readBoundedResponseBytes(response: Response, maxBytes: number): Promise<BoundedResponseBytes>;
export function discardResponseBody(response: Response): Promise<void>;
