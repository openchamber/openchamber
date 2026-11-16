import { describe, expect, test } from 'bun:test';

import { sharePageQuestions } from './questions';

describe('the questions a shared page asks', () => {
  test('are its fields in reading order: the label, else the card the field sits in, else its name', () => {
    const source = `root = Stack([intro, schema, Tabs([Tab("Later", [when, budget, notes])]), send])
intro = Text("Pick the **migration schema** before Friday.")
schema = Card("Which schema should we use?", [Choice("schema", ["A", "B"])])
when = DateInput("date", "When can we run it?")
budget = Slider("hours", 1, 16, "Downtime budget")
notes = Input("risks")
send = Button("Send", "primary", "send")`;
    expect(sharePageQuestions(source)).toEqual(['Which schema should we use?', 'When can we run it?', 'Downtime budget', 'risks']);
  });

  test('are none for a page that only shows things, or one that does not parse', () => {
    expect(sharePageQuestions('root = Stack([Text("Just a report")])')).toEqual([]);
    expect(sharePageQuestions('root = Stack([Choice(')).toEqual([]);
  });
});
