# Teapot Tools

An extension that ships an OpenCode plugin. It declares
`contributes.opencodePlugin: "plugin"`, a folder inside the package with a
`package.json` whose `main` is the plugin's entry file. The plugin adds one
tool, `teapot_status`, which answers a fixed line. There is no panel and no
service: the extension exists to show how a plugin travels with an extension
and leaves with it.

The approval dialog asks for one permission, **Add a plugin to OpenCode**, and
says plainly that plugin code runs inside OpenCode with your full access.

## Try it

1. In **Settings → Extensions**, add this folder and allow it.
2. Open **Settings → Plugins**: within a couple of seconds `teapot-tools` is
   listed as active. OpenChamber wrote the folder into the OpenCode config it
   manages, and OpenCode reloaded its plugin list.
3. In a chat, ask the agent what the teapot says. It calls `teapot_status`
   and reads the answer back.
4. Disable the extension: the plugin leaves Settings → Plugins and the agent
   no longer has the tool. Enable it: it is back. Remove the extension: gone.

Nothing is written into your own `opencode.json`. When OpenChamber did not
start the OpenCode it talks to, or your environment sets `OPENCODE_CONFIG`,
the managed config does not reach that OpenCode: the extension's detail
screen says so and offers **Add to global config**, which writes this folder
into your global OpenCode config as a plugin you then own. The button never
appears where the managed config already does the job.

## What the plugin does

`plugin/index.js` default-exports `{ id, setup }`, the shape OpenCode 2 loads.
`setup` registers the tool through `ctx.tool.transform`, with its input as
plain JSON Schema and `options: { codemode: false }` so the model sees the
tool directly. The tool answers `{ content }`, text for the model: a bare
string is refused, and an `output` field needs an output schema the tool does
not declare. The file imports nothing: OpenCode loads it with a bare
`import()` from the plugin's own folder, where nothing is installed.

## Rebuild

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/opencode-plugin/plugin/index.ts packages/sdk/examples/opencode-plugin/plugin/index.js
```

`scripts/opencode-plugin-example.test.ts` imports the built plugin, runs its
`setup` against a fake tool list and checks that `teapot_status` is registered
and answers.
