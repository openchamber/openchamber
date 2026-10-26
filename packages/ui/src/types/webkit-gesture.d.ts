// WebKit-only pinch events (Safari on macOS trackpads, iOS WKWebView).
// lib.dom does not declare them.
interface GestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface HTMLElementEventMap {
  gesturestart: GestureEvent;
  gesturechange: GestureEvent;
  gestureend: GestureEvent;
}
