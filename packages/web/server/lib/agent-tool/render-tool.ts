export const RENDER_PAGE_UI_DESCRIPTION = [
  "Instead of html: one complete openui-lang program, the language of UI blocks, without the fence. Prefer it to html for a question: Choice and Input fields, drawn with the chat's own controls.",
  "Syntax: one statement per line, name = Component(args); first line root = Stack([...]). Args are positional only in signature order; name: value is not supported, so write Choice(\"id\", [\"A\", \"B\"], \"Pick one\"), never Choice(..., label=\"...\"). Strings \"...\", arrays [...], objects {key: value}. Every name must be reachable from root.",
  "With awaitAnswer the call returns summary (the button and the values in words) and data: { button, value, values, note }: the pressed button's label and value, each field's value under its name, and the note the user added, if any.",
].join(' ');
