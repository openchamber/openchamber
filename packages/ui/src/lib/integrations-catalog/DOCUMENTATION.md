# Integrations catalog

The Integrations page (sidebar header, next to Archive) offers a hand-picked list of outside services. Each entry installs at user scope through the same routes Settings uses: MCP config, npm plugins, the skills-catalog installer, extensions. The catalog only points at vendor material; every install downloads it from the vendor's own source onto the user's machine. The only vendor material in this repository is the logo each tile shows.

## Files

| File | Holds |
|---|---|
| `registry.ts` | Every entry, typed. The only list. |
| `brand-icons.ts` | Generated brand glyphs and colors. Edit `generate-brand-icons.mjs`, then run it. |
| `vendor-logos.ts`, `../../assets/integration-logos/` | Vendor app icons for entries simple-icons lacks, written by `generate-vendor-logos.mjs`. |
| `probe-mcp.mjs` | The suitability probe for remote MCP servers (below). |
| `../i18n/messages/integrations-catalog.i18n.ts` | Page strings and each entry's `description` and `details`, all locales. |
| `../../components/views/IntegrationsCatalogView.tsx` | The page: browse, detail, install and uninstall. |

## Entry model

- An entry bundles components: at most one MCP server, plus OpenCode plugins, skills, or an OpenChamber extension. The entry id is also the MCP server name in the user's config.
- The main part is the MCP server when the entry has one, else its first component. An entry counts as installed once its main part is; a missing bundled skill gets its own Install on the detail page.
- Uninstall removes only what the catalog put there. Skills are deleted from the user's OpenCode skills folder by `skillDir`, so a same-named skill the user keeps elsewhere survives.
- Enterprise mode hides the whole page (`SidebarHeader`). Administrator-curated sources do not exist yet; see `enterprise-boundary` before changing that.

## What belongs

An entry earns its place when all of these hold:

- **Work-team use.** Engineering, product, design, data or ops work in a company. Consumer services (music, travel, fitness, finance apps) stay out.
- **Vendor-run.** The server, plugin or skill is published by the service itself (`verified: true` means exactly this). Community wrappers of someone else's API stay out.

OpenChamber's own extensions and OpenCode plugins belong too, in the `openchamber` category, with OpenChamber as the publisher. Their Settings cards stay where they are; the catalog is one more place to find them.
- **Installs from the catalog.** One-click OAuth, a token field, or a local command the user's machine can run. A service that first needs an app registered by us or by the user is not suitable yet (see Not suitable yet).
- **Licensed to install.** Skills and plugins come from sources with an open license (MIT, Apache-2.0, ISC, MPL-2.0). Vendor terms instead of a license go in `termsUrl`, which the detail page links. A skill repository with no license is acceptable only when the vendor plainly publishes it for installation (a `skills.sh.json` or install instructions); otherwise leave it out.

Candidates come from vendor docs and from integrations.sh, whose credential notes mark servers that need no app registration as "self-onboarding". Use it to find candidates; the app never fetches it, and nothing is imported from it wholesale.

## Vetting a candidate

1. Find the vendor's official MCP URL in their docs.
2. Run the probe with `--register`:

   ```sh
   node packages/ui/src/lib/integrations-catalog/probe-mcp.mjs https://mcp.example.com/mcp --register
   ```

   It signs in the way OpenCode 2.x does: dynamic client registration as `client_name: "opencode"` with a `http://127.0.0.1:<port>/callback` redirect, then a request for the authorization page. It leaves one unused client registered at the vendor.
3. Read the verdict:

   | Verdict | Entry |
   |---|---|
   | `one-click OAuth` | `auth: 'oauth'` with the remote URL |
   | `open` | `auth: 'none'`, or `auth: 'token'` with `tokenOptional: true` when a key raises limits. Many servers list their tools without sign-in and ask for the account only when a tool runs (Courier, Browserbase, OneUptime, Storyblok): check the vendor docs and use `auth: 'token'` there |
   | `no OAuth metadata` | usually a token header: `auth: 'token'`, `tokenHeader`, `tokenHelpUrl` from the vendor docs |
   | `needs a registered app` or `closed` | not suitable yet |

4. Trust the probe over the vendor's docs, in both directions. Canva's docs demand a waitlist, yet the server registers OpenCode and the sign-in completes; Dropbox refuses a client under another name and accepts `opencode` as a trusted partner. The probe stops at the authorization page, so the token's return to the loopback port is proven only by a real sign-in: say in the handoff which new OAuth entries still need one.

Done when every candidate has a verdict, and every entry you add matches its verdict's row.

## Adding an entry

- Place it in `registry.ts` next to entries of the same auth kind, with one or two categories from `CATALOG_CATEGORY_ORDER`. `CATALOG_FEATURED_IDS` is the opening section; change it only when asked.
- Bundle the vendor's own skills only when they work with the server: the agent uses them alongside its tools (Render deploy and debug, the Exa research orchestrator). Skip skills that teach calling the vendor's REST API by hand, and framework-by-framework families. A skill installs under its folder basename, so the basename must name the skill on its own and stay unique (PostHog's `all` and `api` folders cannot be bundled). Its frontmatter `name` must be a plain kebab-case name OpenCode accepts: Webflow's `webflow-mcp:site-audit` style names are skipped. Skip skills that drive a vendor CLI or their own curl scripts (Tavily, Browserbase, Parallel research, Axiom SRE); the vendor's MCP server is what the entry installs. Set `skillName` when the SKILL.md frontmatter name differs from the folder.
- Plugins pin a major version in `spec` and carry `license`.
- Write `integrationsCatalog.entry.<id>.description` (one line: what the agent does with it) and `.details` (two or three sentences, mention bundled skills) in every locale block; `locale-ui-patterns` owns translation.
- Brand: add the simple-icons slug to `BRANDS` in `generate-brand-icons.mjs` and run it. When simple-icons has no glyph, add the vendor's own app icon to `LOGOS` in `generate-vendor-logos.mjs` (its iOS touch icon, a favicon of 120px or more, or its GitHub organization avatar), run it and look at the result: a GitHub placeholder avatar or a 32px favicon is worse than no logo. Without either the entry shows `icon` from the sprite; a new sprite name needs `bun run icons:generate`.
- Run the catalog tests (`IntegrationsCatalogView.test.tsx`, `registry.test.ts`, `i18n/messages.test.ts`), then `bun run check:changed`.

## Not suitable yet

Probed, with the reason, so they are not retried blind. Recheck when the reason may have changed.

| Service | Reason |
|---|---|
| Slack, HubSpot, Box, PagerDuty | No dynamic registration: needs a registered app (client ID and secret). A catalog field for the user's own OAuth client would open these. |
| Canny, DocuSeal, Front, Loops, Smartsheet, Wrike, Zoom | No dynamic registration (probed 2026-10-15). |
| Checkly, Dovetail | Dynamic registration is advertised but disabled. |
| Calendly, Gamma, Grain, MeetGeek, SignNow | Refuse a loopback redirect URI, which OpenCode needs. |
| DevRev | Rejects `127.0.0.1` as a redirect host. |
| Adobe Acrobat | Accepts only allow-listed client names. |
| Reclaim, Omni | Authorization page answers 401 to a fresh client. |
| Docusign, Mailchimp, Square, Adobe Photoshop and Creativity | Refuse before sign-in. |
| Fullstory, Pendo, Avo | No answer from the listed MCP URL. |
| Google Workspace | Developer Preview program, plus a Google Cloud project and OAuth client per user, or our own verified Google app. |
| Google Cloud (BigQuery and others) | GA, but the same OAuth-client requirement as Workspace. |
| Microsoft 365 | No public hosted server for third-party clients. |
| Anthropic office skills (docx, xlsx, pptx, pdf) | Proprietary license forbids redistribution and use outside Anthropic's products. |
| Figma skill | Kept, with `termsUrl`: governed by Figma Developer Terms. |
