declare module '@zumer/snapdom' {
  export type SnapdomOptions = {
    backgroundColor?: string;
    cache?: 'disabled' | boolean | string;
    dpr?: number;
    embedFonts?: boolean;
    fast?: boolean;
    height?: number;
    outerShadows?: boolean;
    outerTransforms?: boolean;
    placeholders?: boolean;
    plugins?: unknown[];
    quality?: number;
    width?: number;
  };

  export type SnapdomCapture = {
    toCanvas(): Promise<HTMLCanvasElement>;
  };

  export function snapdom(element: Element, options?: SnapdomOptions): Promise<SnapdomCapture>;
}
