export {};

declare module 'ghostty-web' {
  export interface ITerminalOptions {
    lineHeight?: number;
  }

  export interface Terminal {
    deselect(): void;
  }

  export interface RendererOptions {
    lineHeight?: number;
  }
}
