/**
 * MCP tool definitions for the agent-driven embedded browser.
 *
 * Names map 1:1 to ops (browser_<op>). The endpoint exposes these via tools/list;
 * tools/call forwards into the runtime's dispatch(), which enforces capability +
 * consent. Keep descriptions agent-friendly and arg schemas tight.
 */

const obj = (properties, required) => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
  additionalProperties: true,
});

const TARGET_PROPS = {
  ref: { type: 'string', description: 'Element ref from a recent browser_snapshot (preferred).' },
  selector: { type: 'string', description: 'CSS selector (alternative to ref).' },
  coords: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[x, y] viewport coordinates.' },
};

export const BROWSER_TOOL_DEFINITIONS = Object.freeze([
  { name: 'browser_navigate', description: 'Navigate the embedded browser to a URL.', inputSchema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'browser_back', description: 'Go back in history.', inputSchema: obj({}) },
  { name: 'browser_forward', description: 'Go forward in history.', inputSchema: obj({}) },
  { name: 'browser_reload', description: 'Reload the current page.', inputSchema: obj({}) },
  {
    name: 'browser_wait_for',
    description: 'Wait for a condition: page load, a selector to appear, a JS expression to be truthy, the next navigation, or a fixed timeout.',
    inputSchema: obj({
      kind: { type: 'string', enum: ['load', 'selector', 'function', 'navigation', 'timeout'] },
      value: { type: 'string', description: 'Selector, JS expression, or ms (for timeout).' },
      timeoutMs: { type: 'number' },
    }, ['kind']),
  },

  { name: 'browser_snapshot', description: 'Return a ref-addressable accessibility/DOM snapshot of the page (preferred way to read the page and target elements).', inputSchema: obj({ maxNodes: { type: 'number' } }) },
  { name: 'browser_get_text', description: 'Get visible text of an element (or the whole page).', inputSchema: obj({ ...TARGET_PROPS }) },
  { name: 'browser_query', description: 'Query elements by CSS selector.', inputSchema: obj({ selector: { type: 'string' }, all: { type: 'boolean' } }, ['selector']) },
  { name: 'browser_get_attributes', description: 'Get an element\'s attributes.', inputSchema: obj({ ...TARGET_PROPS }) },
  { name: 'browser_get_computed_style', description: 'Get computed styles of an element.', inputSchema: obj({ ...TARGET_PROPS, props: { type: 'array', items: { type: 'string' } } }) },
  { name: 'browser_get_url_title', description: 'Get the current URL and document title.', inputSchema: obj({}) },

  { name: 'browser_click', description: 'Click an element.', inputSchema: obj({ ...TARGET_PROPS }) },
  { name: 'browser_double_click', description: 'Double-click an element.', inputSchema: obj({ ...TARGET_PROPS }) },
  { name: 'browser_right_click', description: 'Right-click (context menu) an element.', inputSchema: obj({ ...TARGET_PROPS }) },
  { name: 'browser_hover', description: 'Hover over an element.', inputSchema: obj({ ...TARGET_PROPS }) },
  { name: 'browser_fill', description: 'Set the value of an input/textarea/contenteditable.', inputSchema: obj({ ...TARGET_PROPS, text: { type: 'string' } }, ['text']) },
  { name: 'browser_type', description: 'Type text into the focused or targeted element.', inputSchema: obj({ ...TARGET_PROPS, text: { type: 'string' } }, ['text']) },
  { name: 'browser_press_key', description: 'Press a key (e.g. Enter, Tab, ArrowDown).', inputSchema: obj({ ...TARGET_PROPS, key: { type: 'string' } }, ['key']) },
  { name: 'browser_scroll', description: 'Scroll the page or an element by dx/dy.', inputSchema: obj({ ...TARGET_PROPS, dx: { type: 'number' }, dy: { type: 'number' } }) },
  { name: 'browser_select_option', description: 'Select option(s) in a <select>.', inputSchema: obj({ ...TARGET_PROPS, values: {} }, ['values']) },
  { name: 'browser_drag', description: 'Drag from one element/point to another.', inputSchema: obj({ from: {}, to: {} }, ['from', 'to']) },
  { name: 'browser_file_upload', description: 'Set files on a file input (advanced/gated).', inputSchema: obj({ ...TARGET_PROPS, paths: { type: 'array', items: { type: 'string' } } }, ['paths']) },

  { name: 'browser_screenshot', description: 'Capture a screenshot (viewport, fullPage, or a single element).', inputSchema: obj({ mode: { type: 'string', enum: ['viewport', 'fullPage', 'element'] }, ...TARGET_PROPS }) },
  { name: 'browser_highlight', description: 'Briefly outline an element (useful before a screenshot).', inputSchema: obj({ ...TARGET_PROPS }) },

  { name: 'browser_console_messages', description: 'Read captured console messages.', inputSchema: obj({ since: { type: 'number' } }) },
  { name: 'browser_network_requests', description: 'Read captured network requests.', inputSchema: obj({ since: { type: 'number' } }) },
  { name: 'browser_page_errors', description: 'Read captured uncaught page errors.', inputSchema: obj({ since: { type: 'number' } }) },

  { name: 'browser_evaluate', description: 'Evaluate JavaScript in the page and return the result (advanced/gated).', inputSchema: obj({ js: { type: 'string' } }, ['js']) },

  { name: 'browser_set_viewport', description: 'Set the viewport size.', inputSchema: obj({ width: { type: 'number' }, height: { type: 'number' }, dpr: { type: 'number' } }, ['width', 'height']) },
  { name: 'browser_emulate_device', description: 'Emulate a named device profile.', inputSchema: obj({ device: { type: 'string' } }, ['device']) },
  { name: 'browser_cookies', description: 'Get cookies, or set one (set is advanced/gated).', inputSchema: obj({ mode: { type: 'string', enum: ['get', 'set'] }, name: { type: 'string' }, value: { type: 'string' }, path: { type: 'string' }, maxAge: { type: 'number' } }, ['mode']) },
  { name: 'browser_storage', description: 'Get/set localStorage or sessionStorage (set is advanced/gated).', inputSchema: obj({ mode: { type: 'string', enum: ['get', 'set'] }, area: { type: 'string', enum: ['local', 'session'] }, key: { type: 'string' }, value: { type: 'string' } }, ['mode', 'area']) },
  { name: 'browser_handle_dialog', description: 'Set how the next JS dialog (alert/confirm/prompt) is answered.', inputSchema: obj({ action: { type: 'string', enum: ['accept', 'dismiss'] }, text: { type: 'string' } }, ['action']) },

  { name: 'browser_open', description: 'Ensure a browser pane is open (optionally navigating to a URL).', inputSchema: obj({ url: { type: 'string' }, controllerId: { type: 'string' } }) },
  { name: 'browser_close', description: 'Detach the browser controller.', inputSchema: obj({ controllerId: { type: 'string' } }) },
  { name: 'browser_status', description: 'List attached browser panes and their capabilities.', inputSchema: obj({ controllerId: { type: 'string' } }) },
  { name: 'browser_list_panes', description: 'Alias of browser_status.', inputSchema: obj({}) },
]);
