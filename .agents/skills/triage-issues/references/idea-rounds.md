# Idea rounds

How the maintainer decides feature requests (open `enhancement` issues without `accepted`) in rounds of cards.

Sections: *Before a round*, *The card*, *Acting on the answers*, *Comments*, *What to carry between rounds*.

## Before a round

1. Refresh state from GitHub. An item closed since the last round gets no card.
2. Take the next 15 or so items, newest first.
3. For each item, establish *Що є зараз* yourself: read the code, search Settings pages and other runtimes (mobile, VS Code), and check commits since the item's date (`git log --since=<date> --grep=<terms>`). Sweep statuses from subagents or workflows are leads, not facts: they often call shipped features "partial" and miss a Settings page. A wrong "what exists" line sends the decision the wrong way, and the maintainer catches it.
4. Close without a card, and list in the reply what was closed and why:
   - a feature that already ships, naming where it lives (the *fixed-close* template);
   - an item the author confirmed is covered;
   - a duplicate of an accepted issue;
   - an item a recorded maintainer stance already decides (the *Idea triage: product stances* memory, `Triage notes`), named in the reply so the maintainer can object.
5. Read the maintainer's stances before writing *Моя думка*. Two that shape many cards:
   - OpenCode is building blocks, not the boss. "That's OpenCode's area" is never a reason to decline an idea; a genuinely interesting one becomes the maintainer's own exploratory feature request.
   - Third-party provider quotas and niche personal tools belong in extensions.

## The card

Cards go in the reply as one openui-lang block, one `Card` per item, so choices collect and arrive together with any note the maintainer writes per card. The question tool is too narrow for this.

- **Title**: the item link and a plain-language name of the feature.
- **Badges**: status (`Не зроблено`, `Частково`, `Вже зроблено`, `Схоже на помилку`), votes and comments, creation date, `Автор готовий зробити` when the reporter offered to build it. Leave that last badge off an idea that builds on an unfinished feature.
- **Text blocks**, in Ukrainian, in this order, skipping one that adds nothing: *Що це таке*, *Що просять*, *Що є зараз*, *Що це нам коштує*, *Моя думка*.
- **Buttons** `Хочемо` / `Ні` / `Не зараз`, value = the item, the recommended one primary. An item that already ships gets `Закрити` / `Лишити` instead.
- Related items (the same ask in two issues) share one card that names both.

The maintainer has not read these items: explain the feature in plain words with a concrete example, spell out any term or technology he may not know (research it first), and say what it costs us. *Що це нам коштує* comes from reading the code: an estimate made without it gets caught. *Моя думка* is a real recommendation, often a narrower shape ("without a setting", "only the shortcut").

```openui-lang
root = Stack([c1])
c1 = Card("[#6314](https://github.com/openchamber/openchamber/issues/6314) Статистика за сьогодні", [Row([Badge("Не зроблено", "warning"), Badge("1 голос", "neutral"), Badge("15 жовтня", "neutral")]), Text("**Що просять.** Період «Сьогодні» на сторінці Stats поруч із 7, 30 і 90 днями."), Text("**Що є зараз.** Найменший період 7 днів."), Text("**Що це нам коштує.** Мало: сервер уже рахує періоди від опівночі."), Text("**Моя думка.** Хочемо."), Row([Button("Хочемо", "primary", "#6314"), Button("Ні", "secondary", "#6314"), Button("Не зараз", "secondary", "#6314")])])
```

## Acting on the answers

Nothing stays open after a decision: an item left open is one the maintainer loses count of.

| Answer | Action |
|---|---|
| `Хочемо` | add `accepted` (plus `bug` for a regression), comment with the agreed scope |
| `Ні` | close as not planned |
| `Не зараз` | close as not planned, "not planned for today" |
| `Закрити` (already ships) | close as completed |
| duplicate | close as not planned, pointing at the kept issue |

- The maintainer's note on a card is the recorded scope: fold it into the issue body and the comment. When he says "робимо самі", write "I'll build this one myself, no PR needed". When the author offered to build it, say it's theirs.
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
