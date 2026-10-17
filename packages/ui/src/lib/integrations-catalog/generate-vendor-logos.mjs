import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/**
 * Downloads the app icon each vendor publishes (its iOS touch icon, a large
 * favicon, or its GitHub organization avatar) for catalog entries that
 * simple-icons has no glyph for, and writes a 128px WebP per entry into
 * assets/integration-logos. The view shows these files as they are, so the
 * app never fetches a logo at runtime. A brand in generate-brand-icons.mjs
 * wins over a logo here.
 *
 * Run with `node packages/ui/src/lib/integrations-catalog/generate-vendor-logos.mjs`,
 * then look at every changed file: a source can change or start serving a
 * placeholder.
 */
const TARGET_DIR = new URL('../../assets/integration-logos/', import.meta.url).pathname;
const SIZE = 128;

/** Catalog entry id → the vendor's own icon URL. */
const LOGOS = {
  amplitude: 'https://amplitude.com/nextjs-public/favicon/apple-touch-icon.png',
  ashby: 'https://www.ashbyhq.com/icon.png',
  attio: 'https://github.com/attio.png?size=256',
  aws: 'https://a0.awsstatic.com/libra-css/images/site/touch-icon-iphone-114-smile.png',
  axiom: 'https://axiom.co/apple-touch-icon.png',
  azure: 'https://learn.microsoft.com/apple-touch-icon.png',
  'azure-devops': 'https://learn.microsoft.com/apple-touch-icon.png',
  'browser-use': 'https://browser-use.com/apple-touch-icon.png',
  browserbase: 'https://www.browserbase.com/favicon.svg',
  buf: 'https://buf.build/images/webclip.png',
  'chroma-package-search': 'https://github.com/chroma-core.png?size=256',
  circleback: 'https://circleback.ai/apple-touch-icon.png',
  close: 'https://close.com/apple-touch-icon.png',
  courier: 'https://framerusercontent.com/images/oWKCLLJZ33f3VIBMMbvQmZCCSMs.png',
  craft: 'https://www.craft.do/images/favicon-large.png',
  'day-ai': 'https://github.com/day-ai.png?size=256',
  deepwiki: 'https://github.com/CognitionAI.png?size=256',
  descope: 'https://github.com/descope.png?size=256',
  devcycle: 'https://devcycle.com/apple-icon.png?1d62bb615e6d0102',
  exa: 'https://github.com/exa-labs.png?size=256',
  fathom: 'https://cdn.prod.website-files.com/6899da9beccbdbe92be49b5d/6a4282cf896cae98018bfa8c_fathom_favicon.png',
  fellow: 'https://framerusercontent.com/images/W3zP48ABQ5JvFZqDFzSM0WCWKg.png',
  firecrawl: 'https://github.com/firecrawl.png?size=256',
  fireflies: 'https://fireflies.ai/apple-icon.png?81a7679a0c7e6094',
  flagsmith: 'https://cdn.prod.website-files.com/64425c978745b453797839bb/6492f2e21ba18a967f85529d_icon256.png',
  granola: 'https://www.granola.ai/favicon/apple-touch-icon.png',
  groundcover: 'https://www.groundcover.com/webclip.png',
  guru: 'https://cdn.prod.website-files.com/5d8d029013ffd80bbb91320d/6216a21ee8829c7531435bc8_Guru_G_Black%202256.png',
  hex: 'https://hex.tech/favicon.svg',
  honeycomb: 'https://github.com/honeycombio.png?size=256',
  hyperping: 'https://hyperping.com/assets/hyperping/apple-touch-icon.png',
  'incident-io': 'https://incident.io/icons/icon-48x48.png',
  jam: 'https://framerusercontent.com/images/PJzGWvCk8HH9Ho4kUWVsQtYI.png',
  jina: 'https://jina.ai/icons/favicon-128x128.png',
  jotform: 'https://www.jotform.com/apple-touch-icon.png',
  kernel: 'https://www.kernel.sh/apple-touch-icon.png',
  knock: 'https://knock.app/favicon/favicon-dark.svg',
  krisp: 'https://krisp.ai/wp-content/uploads/2023/12/cropped-favicon-1-180x180.png',
  'langfuse-plugin': 'https://langfuse.com/apple-touch-icon.png',
  lightfield: 'https://cdn.sanity.io/images/3ccg9tet/production/06c39c0d99c42e90b57fccf4975907af19118ea5-320x320.png',
  logrocket: 'https://logrocket.com/favicon/apple-touch-icon.png',
  lucid: 'https://github.com/lucidsoftware.png?size=256',
  'magic-patterns': 'https://www.magicpatterns.com/apple-icon.png?8c6337e930e9894a',
  markitdown: 'https://learn.microsoft.com/apple-touch-icon.png',
  mem: 'https://get.mem.ai/assets/brand/apple-touch-icon.png',
  mem0: 'https://framerusercontent.com/images/2ys67ADJdvcyGmQnhp8vKWSq8.svg',
  mercury: 'https://mercury.com/apple-icon.png?apple-icon.24duaeqfro1-o.png',
  'microsoft-learn': 'https://learn.microsoft.com/apple-touch-icon.png',
  monday: 'https://cdn.prod.website-files.com/656da6fea306219773d04208/65af6bd6e742d497b5f23f69_645898132bbaac20f1963919_256x256.png',
  motherduck: 'https://motherduck.com/apple-touch-icon.png',
  mux: 'https://www.mux.com/apple-icon-pwu6ef.png?apple-icon.30dosf78dmoz6.png',
  neon: 'https://neon.com/apple-touch-icon.png',
  oneuptime: 'https://oneuptime.com/img/favicons/apple-touch-icon.png',
  onlineornot: 'https://onlineornot.com/apple-touch-icon.png',
  openobserve: 'https://openobserve.ai/apple-touch-icon.png',
  openstatus: 'https://www.openstatus.dev/icon.png?icon.0ql4z1tq5lt1f.png',
  otter: 'https://cdn.prod.website-files.com/618e9316785b3582a5178502/618e943a80919a98b5e9bf69_apple-icon.png',
  pandadoc: 'https://github.com/PandaDoc.png?size=256',
  parallel: 'https://parallel.ai/apple-icon.png?apple-icon.ea4d2091.png',
  'pg-aiguide': 'https://github.com/timescale.png?size=256',
  plain: 'https://framerusercontent.com/images/oPE9BwSE8LUYzrxvpHa5FCmXc.png',
  playwright: 'https://playwright.dev/img/playwright-logo.svg',
  'process-street': 'https://www.process.st/wp-content/themes/koombea/icons/apple-touch-icon-57x57.png',
  productboard: 'https://www.productboard.com/apple-touch-icon.png',
  pylon: 'https://cdn.prod.website-files.com/6a2c6d7ab6674379553c0824/6a2c722c63cfe1af0f3302b7_webclip.png',
  qovery: 'https://www.qovery.com/favicon.svg',
  ramp: 'https://ramp.com/apple-touch-icon.png',
  'resource-monitor': 'https://github.com/openchamber.png?size=256',
  'read-ai': 'https://cdn.prod.website-files.com/614e5e239ea0f25fe5b6a797/615f71de842b191ea061fda6_ReadLogomark_256x256.png',
  readwise: 'https://github.com/readwiseio.png?size=256',
  redocly: 'https://github.com/Redocly.png?size=256',
  remote: 'https://remote.com/remote-symbol.svg',
  rootly: 'https://rootly.com/brand/favicon.svg',
  signoz: 'https://signoz.io/static/favicons/apple-touch-icon.png',
  sourcegraph: 'https://github.com/sourcegraph.png?size=256',
  statsig: 'https://statsig.com/images/favicons/favicon180.png',
  stytch: 'https://github.com/stytchauth.png?size=256',
  superhuman: 'https://superhumanstatic.com/super-funnel/main/public/images/v4/favicons/superhuman-apple-touch-icon.png',
  tally: 'https://tally.so/favicon.svg',
  tavily: 'https://www.tavily.com/apple-icon.png?apple-icon.2rsjznomrsf77.png',
  thoughtspot: 'https://www.thoughtspot.com/images/TS-FAV-180x180_Dark.png?v=2025',
  tigris: 'https://github.com/tigrisdata.png?size=256',
  tuist: 'https://tuist.dev/apple-touch-icon.png',
  unthread: 'https://unthread.io/favicon.ico',
  upsun: 'https://github.com/upsun.png?size=256',
  uptimerobot: 'https://uptimerobot.com/apple-touch-icon.png',
  vantage: 'https://www.vantage.sh/favicon/favicon.png',
  windmill: 'https://github.com/windmill-labs.png?size=256',
  workos: 'https://cdn.prod.website-files.com/621f54116cab10f6e9215d8b/621f549024eb2947f6f2f7f7_Favicon%20256x256.png',
};

const USER_AGENT = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36';

fs.mkdirSync(TARGET_DIR, { recursive: true });
const wanted = new Set(Object.keys(LOGOS).map((id) => `${id}.webp`));
for (const file of fs.readdirSync(TARGET_DIR)) {
  if (!wanted.has(file)) fs.rmSync(path.join(TARGET_DIR, file));
}

let failed = 0;
for (const [id, url] of Object.entries(LOGOS)) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
  if (!response.ok) {
    console.error(`${id}: ${url} answered ${response.status}`);
    failed += 1;
    continue;
  }
  const source = Buffer.from(await response.arrayBuffer());
  // Transparent icons get a white backing so a dark mark stays visible on a dark tile.
  await sharp(source, { density: 300 })
    .resize(SIZE, SIZE, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 85 })
    .toFile(path.join(TARGET_DIR, `${id}.webp`));
  console.log(`${id}: ok`);
}
console.log(`written: ${Object.keys(LOGOS).length - failed} logos`);
if (failed > 0) process.exitCode = 1;
