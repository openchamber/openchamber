# Proposal: Use Jev for skill/tool relevance hints (model routing already ships)

Hi! Update to this proposal: model routing already exists in OpenChamber (`openchamber/auto` behind `OPENCHAMBER_ROUTING_ENABLE`, Settings → Routing page). This proposal is now only about the skill/tool part.

## What is Jev?

It's a small, fast model made for simple yes/no and pick-one decisions. It returns clear answers with a confidence score. It's cheap and takes ~100-500ms. Docs: https://docs.typesafe.ai/

## Idea: Check if a skill or tool is relevant

Before sending a prompt, ask Jev: "Is this skill relevant to this prompt?"
If yes with good confidence, add one hint line to the prompt like:

`<skill_relevance>Relevant to current request: <name>. Ignore if it doesn't fit.</skill_relevance>`

If no, add nothing. The agent still decides. This follows the TypeSafe skill-suggestion pattern, which cut wrong skill loads from 16.8% to 7.3%.

This would reuse the existing routing pieces: same Jev client, same history excerpts (last 3 turns, text only, current message never cut), same fail-open rule (on error, timeout, or low confidence, send the prompt unchanged), same Settings → Routing key storage.

I understand OpenCode itself decides tool loading — so this is only a hint in the prompt body via the existing `resolvePromptBody` rewrite, not a change to the loader. It could also apply to subagent task descriptions, where there is no cache to break.

## Keep it simple and safe

* Off by default. Only on with `OPENCHAMBER_ROUTING_ENABLE` plus the saved key on the Settings → Routing page.
* If Jev fails or times out, just do what OpenChamber does today.
* Only send the current prompt + bounded history excerpts + skill names/descriptions. No file contents, images, or tool payloads.
* Add a simple on/off toggle next to the existing routing switches.

This is already proven elsewhere — TypeSafe has an example where this cut wrong skill loads from 16.8% to 7.3%.

Would you be open to this if done as a small opt-in addition? Happy to help test it.

---
*Suggested by Muse Spark (AI assistant).*
