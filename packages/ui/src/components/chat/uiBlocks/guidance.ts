import { tones, uiBlockLibrary } from './catalog';

/**
 * What an agent reads about UI blocks, built from the catalog so the
 * signatures it writes against are the ones the parser checks. The server
 * cannot import the catalog (`@openuidev/lang-core` stays out of the
 * published server package), so `generate-guidance.ts` writes this text into
 * `packages/web/server/lib/session-knowledge/ui-blocks-guidance.js`.
 *
 * Every session pays for this text, so it says each thing once: the child
 * lists of the layout components and the tone values are named once instead
 * of in every signature, and a component carries a description only where
 * its signature leaves the agent guessing.
 */

/** Examples the agent reads; each one must stay a valid block (guidance.test.ts). */
export const UI_BLOCK_EXAMPLES = [
  [
    'root = Stack([note, flow])',
    'note = Callout("Routers rewrite the MAC header, keep the IP header.", "info")',
    'flow = Steps([{title: "Sender", status: "done"}, {title: "Router", status: "current"}, {title: "Receiver"}], "row")',
  ].join('\n'),
  [
    'root = Stack([a])',
    'a = Card("#12 Login on Safari", [Badge("bug", "error"), Text("Broken since 2.1 on macOS."), Button("Fix now", "primary", "#12 Login on Safari"), Button("Later", "secondary", "#12 Login on Safari")])',
  ].join('\n'),
];

const TONE_UNION = tones.map((tone) => `"${tone}"`).join(' | ');
// A child list such as (Text | Badge | ...)[]; the rules name what nests where.
const CHILD_LIST = /\((?:[A-Z]\w* \| )+[A-Z]\w*\)\[\]/g;

const componentLines = (): string => Object.values(uiBlockLibrary.toSpec().components)
  .map((component) => {
    const signature = component.signature.replaceAll(TONE_UNION, 'Tone').replace(CHILD_LIST, 'Item[]');
    return component.description ? `${signature}: ${component.description}` : signature;
  })
  .join('\n');

export function buildUiBlocksGuidance(): string {
  return [
    'UI blocks: a fenced openui-lang block in your reply draws native UI there; keep the explanation in Markdown around it.',
    'Use one for data or structure the user would otherwise picture: values across items, comparisons, flows, trends, status. Not for a few numbers, a short list, code, or when asked for plain text. Several per reply are fine.',
    'Per-item decisions: a Card per item, a Button per option, value = the item. Choices collect until each decision has one (or the user sends early), then reach you together as your next turn. A question your current turn waits on goes through openchamber_render with ui (this language) and awaitAnswer.',
    '',
    'Syntax: one statement per line, name = Component(args); first line root = Stack([...]). Positional args in signature order, optional ones droppable from the end. Strings "...", arrays [...], objects {key: value}. Every name must be reachable from root.',
    `Item = any component below except Tab and Series. Card holds no Card or Tabs; Row holds no Row or Tabs; Tab holds no Tabs. Tone = ${TONE_UNION}.`,
    '',
    'Examples:',
    UI_BLOCK_EXAMPLES[0],
    '',
    UI_BLOCK_EXAMPLES[1],
    '',
    'Components:',
    componentLines(),
  ].join('\n');
}
