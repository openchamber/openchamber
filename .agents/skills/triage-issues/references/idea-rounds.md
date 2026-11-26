# Idea rounds

How the maintainer decides feature requests (open `enhancement` issues without `accepted`) in rounds of cards.

Sections: *Before a round*, *The card*, *Acting on the answers*, *Comments*, *What to carry between rounds*.

## Before a round

1. Refresh state from GitHub. An item closed since the last round gets no card.
2. Take the next 15 or so items, newest first.
3. For each item, establish *What exists now* yourself: read the code, search Settings pages and other runtimes (mobile, VS Code), and check commits since the item's date (`git log --since=<date> --grep=<terms>`). Sweep statuses from subagents or workflows are leads, not facts: they often call shipped features "partial" and miss a Settings page. A wrong "what exists" line sends the decision the wrong way, and the maintainer catches it.
4. Close without a card, and list in the reply what was closed and why:
   - a feature that already ships, naming where it lives (the *fixed-close* template);
   - an item the author confirmed is covered;
   - a duplicate of an accepted issue;
   - an item a recorded maintainer stance already decides (the *Idea triage: product stances* memory, `Triage notes`), named in the reply so the maintainer can object.
5. Read the maintainer's stances before writing *My take*. Two that shape many cards:
   - OpenCode is building blocks, not the boss. "That's OpenCode's area" is never a reason to decline an idea; a genuinely interesting one becomes the maintainer's own exploratory feature request.
   - Third-party provider quotas and niche personal tools belong in extensions.

## The card

Cards go in the reply as one openui-lang block, one `Card` per item, so choices collect and arrive together with any note the maintainer writes per card. The question tool is too narrow for this.

Everything on a card (badges, headings, text, button labels) is written in the language of the user's messages. The labels below are the English meaning; render them in that language.

- **Title**: the item link and a plain-language name of the feature.
- **Badges**: status (`Not built`, `Partly built`, `Already ships`, `Looks like a bug`), votes and comments, creation date, `Author offers to build it` when the reporter offered to build it. Leave that last badge off an idea that builds on an unfinished feature.
- **Text blocks**, in this order, skipping one that adds nothing: *What it is*, *What they ask*, *What exists now*, *What it costs us*, *My take*.
- **Buttons** `Want it` / `We build it` / `No` / `Not now`, value = the item, the recommended one primary. An item that already ships gets `Close` / `Keep` instead.
- Related items (the same ask in two issues) share one card that names both.

The maintainer has not read these items: explain the feature in plain words with a concrete example, spell out any term or technology he may not know (research it first), and say what it costs us. *What it costs us* comes from reading the code: an estimate made without it gets caught. *My take* is a real recommendation, often a narrower shape ("without a setting", "only the shortcut").

```openui-lang
root = Stack([c1])
c1 = Card("[#6314](https://github.com/openchamber/openchamber/issues/6314) Stats for today", [Row([Badge("Not built", "warning"), Badge("1 vote", "neutral"), Badge("October 15", "neutral")]), Text("**What they ask.** A \"Today\" period on the Stats page next to 7, 30 and 90 days."), Text("**What exists now.** The shortest period is 7 days."), Text("**What it costs us.** Little: the server already counts periods from midnight."), Text("**My take.** Want it."), Row([Button("Want it", "primary", "#6314"), Button("We build it", "secondary", "#6314"), Button("No", "secondary", "#6314"), Button("Not now", "secondary", "#6314")])])
```

## Acting on the answers

Nothing stays open after a decision: an item left open is one the maintainer loses count of.

| Answer | Action |
|---|---|
| `Want it` | add `accepted` (plus `bug` for a regression), comment with the agreed scope; the issue is open to contributors |
| `We build it` | add `accepted` and `in-house`, comment with the agreed scope and "I'll build this one myself, no PR needed" |
| `No` | close as not planned |
| `Not now` | close as not planned, "not planned for today" |
| `Close` (already ships) | close as completed |
| duplicate | close as not planned, pointing at the kept issue |

- The maintainer's note on a card is the recorded scope: fold it into the issue body and the comment. A note that says the team builds it ("we'll build it", "that's us", in whatever language) on a `Want it` answer counts as `We build it`. When the author offered to build it and the answer is `Want it`, say it's theirs.
- A note that redefines the ask (the real need is different from the request) becomes a new issue; close the original kindly, pointing at it.
- An interesting idea with no clear approach becomes the maintainer's own feature request: the goal, "no plan yet, the approach is to be explored", "no PR needed".
- A note that says something is a bug: relabel the issue `bug` and keep it.
- When he asks to start work right away, create the issue first, then dispatch an OpenChamber session with the issue link and the code entry points, and tell it to leave the change uncommitted.

## Comments

Comments go out in the maintainer's name and follow `communication-style` (*Text sent in the maintainer's name*). On top of that:

- Open with thanks or with acknowledgement of the need, then the reason in plain words, then a pointer when there is one. "Not doing this." as an opener reads as a slammed door.
- A decline explains the real reason well enough that it isn't just "no" (e.g. why a Flatpak sandbox gives no isolation to an app that must run OpenCode, git and terminals).
- The maintainer's frustration in card notes is venting, never quoted or paraphrased publicly. Private business plans in notes (paid features) stay out of public text too.

## What to carry between rounds

- No round state to keep: every decided item ends up `accepted` or closed, so the queue is always the open `enhancement` issues without `accepted` (`gh issue list --label enhancement --search "-label:accepted"`).
- A new product stance from a round goes into the *Idea triage: product stances* memory.
