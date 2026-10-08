---
name: communication-style
description: Rules for everything a person reads, from your own replies in a session to documentation, UI copy, PR and issue comments, release notes, and posts. Strips AI-generated patterns so the text reads like a person wrote it.
author: poteto (pstack), extended with OpenChamber's own drafts
---

# Communication style

The openchamber and openchamber-website repositories carry identical copies of this skill; an edit to one goes to both.

These rules cover everything you write that a person reads: your replies in a session, in any language, and every text that lands somewhere. Every rule below applies to all of it. Write like a person who knows the subject and respects the reader's time.

## The one rule

Every sentence tells the reader something that happened, something that is, or what you think about it. A sentence that does none of those is a trick or a signpost. Cut it.

## Process

1. For text that lands somewhere, pick the register for where it goes (next section).
2. Check what you wrote against the patterns below and rewrite before handing it over. Preserve meaning.
3. Run the self-check at the end. Ask "what makes this obviously AI-written?" and fix what remains.

## Where the text goes

- **Docs, READMEs, UI text.** Explain what the reader sees and does. Plain, impersonal, no story, no first-person asides. Present tense for how things work.
- **Comments on GitHub and messages the maintainer sends.** Written the way the maintainer types in chat: the point first, contractions, short. First person "I". Thanks and merge comments are one or two human sentences. Praise the help itself, never through numbers ("22 merged PRs").
- **Stories: release notes, blog posts, announcements.** Everything here applies, plus *Telling a story* below.

## Patterns to detect and fix

### Framing tricks

These feel "writerly" to the author and read as AI tells to everyone else.

1. **Contrast framing.** "X, not Y" in all its costumes: "It's a cache, not a database", "Not per file, per folder", "instead of guessing the encoding...", "rather than polling...", "a limit you can see beats one we picked for you". Say the true thing directly and skip the false one: "It's a cache, so a restart empties it." "The watcher subscribes to the folder and gets one event per change." The same goes for "Not just X, but Y".
2. **Dramatic reversal.** Deny the obvious, pause, reveal: "The parser was never the slow part.", "which looks like a memory leak and isn't", "My first reaction was X. My second was Y." State the finding and move on: "Most of the time went into reading the file twice, so we read it once."
3. **Signposting.** The text talking about itself: "This post is about...", "More on that below", "Let that sink in.", "The second column is where it gets interesting.", "Here's the thing:". Delete. If the reader needs a pointer, fold it into a sentence about the subject.
4. **Personifying code.** "the retry loop got a second job", "two checks keep it honest", "the scheduler never gets to quietly skip a run". Say what the code does: "The retry loop now also refreshes the token." "Two checks run before every write."
5. **Aphorism and generic endings.** "In the end, every cache is a promise you have to keep.", "The future looks bright." End on advice, a fact, or a plan: "Next release moves the index to disk, so a restart keeps it."
6. **Rule of three.** Forcing ideas into groups of three. Use the natural number.
7. **False ranges.** "from X to Y" where X and Y aren't on a meaningful scale. List the topics.

### Content

8. **Puffery.** "pivotal moment", "testament to", "evolving landscape", "setting the stage for", "deeply rooted". State what happened.
9. **Promotional language.** "seamless", "powerful", "vibrant", "groundbreaking", "stunning". Use neutral descriptions or a number.
10. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete or say the actual consequence.
11. **Vague attributions.** "Experts believe", "Some users say". Name the source or delete.
12. **Formulaic challenges.** "Despite challenges... continues to thrive." Replace with specific facts.
13. **Name-dropping.** Listing outlets or tools without context. Pick one and say what it did.
14. **Say what it does, not how it feels.** "the database stays close at hand", "SQL you can read" name a feeling. Name the mechanism or a number: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". If a sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
15. **Honesty about what isn't done.** Report an experiment as an experiment. Say where it pays off, where it doesn't yet, and what you haven't measured. "We haven't measured that properly yet" beats a confident claim nobody can check.

### Language

16. **AI vocabulary.** additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry, testament, underscore, vibrant, robust, comprehensive, leverage, utilize, facilitate, numerous. Use the plain word: "use", "help", "many".
17. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
18. **Abstract metaphor nouns.** substrate, wedge, vector, locus, nexus, primitive (as noun), harness (as metaphor), surface ("API surface"), bedrock, scaffolding, modality, paradigm, gold-plating, ratchet, evacuate (for moving code), endgame, north star, flywheel. Pick the concrete word: "base", "add", "way", "more than the job needs", "a limit that only tightens", "move out".
19. **Synonym cycling.** Protagonist, main character, central figure in one paragraph. Pick one word and repeat it.
20. **Filler and hedging.** "In order to" is "to". "Due to the fact that" is "because". "It is important to note that" goes. "could potentially possibly be argued that it might" is "may".
21. **Adverbs propping up weak verbs.** "runs quickly" is "is fast" or the number. "significantly improves" is the measured delta.
22. **Passive voice.** "queries are validated" is "the compiler validates queries". Passive is fine only when the actor is unknown or doesn't matter.
23. **Dense sentences.** If the reader has to backtrack, split the sentence or drop clauses. One idea per sentence.

### Chatbot artifacts

24. **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Certainly!", "Great question!", "You're absolutely right!", "Found the smoking gun!". Remove and respond directly.
25. **Cutoff disclaimers.** "While specific details are limited...". Find the facts or say plainly what you don't know.

### Punctuation and formatting

26. **No em dashes, en dashes, or dash substitutes, and no parentheses for asides.** End the sentence or use a comma. Reaching for parentheses instead of a dash trades one tell for another.
27. **Colons only before a list or an example**, never as a mid-sentence connector.
28. **Straight quotes**, never curly ones.
29. **Boldface sparingly.** Don't bold every proper noun. A bold lead-in that restates the line ("**Performance:** Performance improved...") becomes prose. A bold lead-in that names the item and ends in a period, followed by new detail, is fine.
30. **Headings say what the section contains**, in sentence case: "Why the index lives in memory", "What we'd change next time". Not "The concept", "Key learnings", "What we took from it".
31. **No decorative emojis** in headings and bullets.
32. **Numbers as digits** inside a sentence ("57 percent", "31 cases"); "%" in tables. Code identifiers in backticks, commands in a fenced block.
33. **Short paragraphs**, three to five lines, one idea each. Tables for before/after comparisons: one sentence of setup, the table, then commentary on the rows that matter.

## Write like a person

Removing patterns is half the job. Sterile, voiceless text is just as obvious.

- **Have an opinion.** React to facts instead of listing pros and cons. "Two failures in a hundred runs is too many for a default; it stays behind a setting."
- **Be specific.** Not "this is concerning" but "agents churning away at 3am while nobody watches the bill".
- **Vary rhythm.** Short sentences. Then a longer one that takes its time.
- **Let some mess in.** Perfect parallel structure looks machine-made.

## Telling a story

For release notes, blog posts, and announcements. Tell it the way you'd tell a colleague over coffee: what you tried, what broke, what you changed, what you'd do next.

- **Open with your own problem.** Admit something. "I kept twelve terminal tabs open for a year because I never trusted the app to remember where I left off. Then I lost a morning of work to a reboot, and that was the end of that."
- **Tell what happened in order.** Built it, used it, it broke, here's how, here's the fix. Past tense for the story, present tense for how it works now.
- **Humour comes from the facts, never from the prose.** Find the moment that was actually funny and describe it flatly; the numbers do the work. "The cleanup job deleted 4,000 temp files on its first run. 3,998 of them were its own logs." The joke is on us, our habits, or the situation. Never on the reader, other developers, or a vendor.
- **Headings may joke if they stay accurate:** "The retry loop, or how to DDoS yourself politely".
- **A blog post's frontmatter `description`** reads like the first line you'd say if someone asked what it's about.

## Self-check before handing back

1. Grep for `, not `, `instead of`, `rather than`, `never the`, `and isn't`, `not just`. Every hit is a suspect.
2. Grep for `—`, `–`, and curly quotes. Zero hits.
3. Find every sentence about the text itself: "this post", "below", "above", "this section", "here's". Cut.
4. Read each heading alone. Does it say what the section contains?
5. Read the last paragraph. Advice, a fact, or a plan? If it's a moral, rewrite.
6. For a story: is the funniest fact in the material in the text, told flatly?
