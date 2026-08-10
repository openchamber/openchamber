// Agent-facing browser actions exposed through the managed OpenChamber browser
// tool. Each maps directly to a browser runtime action. Descriptions state only
// required inputs or one non-obvious behavior, mirroring the openchamber tool's
// context budget discipline.
export const OPENCHAMBER_BROWSER_ACTION_DEFINITIONS = Object.freeze([
  { action: 'state', title: 'Inspect browser', description: 'Return open tabs, the active tab, and recording status; no parameters' },
  { action: 'tab.create', title: 'Open a browser tab', description: 'Open a new tab; optional url and viewport preset' },
  { action: 'navigate', title: 'Navigate the browser', description: 'Navigate the active or given tab to url; only http and https are allowed' },
  { action: 'click', title: 'Click in the browser', description: 'Click at viewport coordinates x and y' },
  { action: 'type', title: 'Type in the browser', description: 'Insert text at the current focus; requires text' },
  { action: 'key', title: 'Press a key', description: 'Dispatch a key or combo such as Enter or Control+A; requires key' },
  { action: 'scroll', title: 'Scroll the browser', description: 'Scroll by deltaX and deltaY at the cursor position' },
  { action: 'evaluate', title: 'Evaluate page script', description: 'Evaluate a JavaScript expression in the page and return its value; requires expression' },
  { action: 'wait', title: 'Wait for a condition', description: 'Wait until selector exists or expression is truthy; optional timeout in ms' },
  { action: 'viewport', title: 'Resize the viewport', description: 'Set the viewport with a preset (desktop, laptop, tablet, mobile) or width and height' },
  { action: 'screenshot', title: 'Capture a screenshot', description: 'Capture the tab as an inspectable artifact; optional fullPage' },
  { action: 'recording.start', title: 'Start recording', description: 'Start recording browser activity for later inspection' },
  { action: 'recording.stop', title: 'Stop recording', description: 'Stop recording and produce an inspectable artifact' },
]);

export const OPENCHAMBER_BROWSER_ACTIONS = Object.freeze(
  OPENCHAMBER_BROWSER_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENCHAMBER_BROWSER_TOOL_PARAMETERS = Object.freeze({
  tabId: { type: 'string', description: 'Target tab id; defaults to the active tab' },
  url: { type: 'string', description: 'http or https URL to open' },
  x: { type: 'number', description: 'Viewport x coordinate in CSS pixels' },
  y: { type: 'number', description: 'Viewport y coordinate in CSS pixels' },
  deltaX: { type: 'number' },
  deltaY: { type: 'number' },
  text: { type: 'string' },
  key: { type: 'string', description: 'Key or combo, e.g. Enter, Tab, Control+A' },
  expression: { type: 'string', description: 'JavaScript expression evaluated in the page' },
  selector: { type: 'string', description: 'CSS selector to wait for' },
  timeout: { type: 'integer', minimum: 100, maximum: 60000, description: 'Wait timeout in milliseconds' },
  preset: { type: 'string', enum: ['desktop', 'laptop', 'tablet', 'mobile', 'custom'], description: 'Viewport preset' },
  width: { type: 'integer', minimum: 320, maximum: 3840 },
  height: { type: 'integer', minimum: 320, maximum: 2160 },
  fullPage: { type: 'boolean', description: 'Capture the full scrollable page' },
});
