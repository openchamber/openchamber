import { uiBlockLibrary } from './catalog';

/**
 * What an agent reads about UI blocks, built from the catalog so the
 * signatures it writes against are the ones the parser checks. The server
 * cannot import the catalog (`@openuidev/lang-core` stays out of the
 * published server package), so `generate-guidance.ts` writes this text into
 * `packages/web/server/lib/session-knowledge/ui-blocks-guidance.js`.
 */
/** Examples the agent reads; each one must stay a valid block (guidance.test.ts). */
export const UI_BLOCK_EXAMPLES = [
  [
    'root = Stack([summary, flow])',
    'summary = Callout("The router rewrites the MAC header and keeps the IP header.", "info")',
    'flow = Steps([{title: "Sender", status: "done"}, {title: "Router", status: "current"}, {title: "Receiver"}], "row")',
  ].join('\n'),
  [
    'root = Stack([a])',
    'a = Card("#12 Login on Safari", [Badge("bug", "error"), Text("Broken since 2.1 on macOS."), Row([Button("Fix now (recommended)", "primary", "#12 Login on Safari"), Button("Later", "secondary", "#12 Login on Safari")])])',
  ].join('\n'),
];

export function buildUiBlocksGuidance(): string {
  const spec = uiBlockLibrary.toSpec();
  const signatures = Object.values(spec.components)
    .map((component) => `${component.signature}${component.description ? `: ${component.description}` : ''}`)
    .join('\n');
  return [
    'A reply can draw native UI: put a fenced code block with the language openui-lang where the visual belongs, and keep the explanation in Markdown around it.',
    'Use one when that part of the answer is data or structure the user would otherwise picture: values across several items, options compared on several criteria, a sequence or flow, a trend, the status of several things.',
    'Skip it for a few numbers, a short list, code, or when the user asked for plain text. Several blocks may sit in one reply, each beside the text it explains.',
    'Buttons in a block of your reply collect the user\'s choices, one per decision (the buttons that share a value). Once every decision has a choice, or the user sends what they chose, the choices and the values of the block\'s Choice and Input fields reach you together and start your next turn. When your next step depends on the answer within this turn, ask with openchamber_render instead: ui (this same language) with awaitAnswer.',
    'When the user has to decide something about each item you list, give each item its own Card with a Button per option, and set each Button\'s value to the item it is about; a table leaves them nothing to press.',
    '',
    'Syntax: one statement per line, name = Component(arguments). The first line is root = Stack([...]).',
    'Arguments are positional, in the order of the signature; optional ones may be left off the end. Strings take double quotes, arrays [...], objects {key: value}.',
    'Every name you define must be reachable from root.',
    '',
    'Example, an explanation:',
    UI_BLOCK_EXAMPLES[0],
    '',
    'Example, a decision per item:',
    UI_BLOCK_EXAMPLES[1],
    '',
    'Components:',
    signatures,
  ].join('\n');
}
