import { mountBadge, mountBanner } from '@openchamber/sdk/ui';

// Example presentation, bundled into each extension. It is not an SDK dependency.
const css = `
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.5}body{overflow-wrap:anywhere}button,input,textarea{font:inherit}[hidden]{display:none!important}
[data-oc-theme="dark"]{color-scheme:dark}[data-oc-theme="light"]{color-scheme:light}.toolbar:empty{display:none}
.example{max-width:1160px;margin:auto;padding:20px;display:flex;flex-direction:column;gap:24px;container-type:inline-size}
.example h1,.example h2,.example h3,.example p{margin:0}.example h1{font-size:clamp(25px,5vw,36px);font-weight:650;letter-spacing:-.04em;line-height:1.12}.example h2{font-size:15px;letter-spacing:-.015em}.example h3{font-size:13px;font-weight:600}
.eyebrow{font:11px var(--oc-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--oc-muted)}.hero{display:flex;flex-direction:column;gap:12px;padding:8px 0 4px}.hero p{max-width:58ch;color:var(--oc-muted);font-size:13px}
.row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}.row.between{justify-content:space-between}.stack{display:flex;flex-direction:column;gap:14px;min-width:0}.muted{color:var(--oc-muted);font-size:12px}.grow{flex:1;min-width:0}
.card{min-width:0;border:1px solid var(--oc-border);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:16px}.card-heading{display:flex;flex-direction:column;gap:4px}.card-heading p{color:var(--oc-muted);font-size:12px}.soft{background:var(--oc-muted-surface)}
.grid,.split,.metrics,.lanes{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);align-items:start}.metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.metric{border-top:1px solid var(--oc-border);padding:12px 0}.metric strong{display:block;font-size:24px;font-weight:550;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.metric span{color:var(--oc-muted);font-size:11px}
.code{font:11px/1.65 var(--oc-mono);white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow:auto;margin:0;padding:14px;border-radius:9px;background:var(--oc-muted-surface);color:var(--oc-fg);tab-size:2}.code:empty{display:none}.api{border-top:1px solid var(--oc-border);padding-top:12px;font-size:12px;color:var(--oc-muted)}.api summary{cursor:pointer;width:fit-content;margin-bottom:10px}.api summary:focus-visible{outline:2px solid var(--oc-focus);outline-offset:3px}
.code:focus-visible{outline:2px solid var(--oc-focus);outline-offset:2px}
.example .oc-sdk-search{flex:1;min-width:140px}.example .oc-sdk-row{padding:11px 9px;min-height:48px}.example .oc-sdk-row-title{font-weight:500}.example .oc-sdk-row-sub{margin-top:3px}.example .oc-sdk-list-empty{padding:28px 8px}.example .oc-sdk-row-lead{width:48px}.example .oc-sdk-select{min-width:0}.example .oc-sdk-tabs{width:fit-content}.example .oc-sdk-field{gap:7px}
.workspace{border-top:1px solid var(--oc-border);padding-top:20px}.detail-title{font-size:22px;line-height:1.25;letter-spacing:-.025em}.inline-note{font:11px/1.5 var(--oc-mono);color:var(--oc-muted)}.result{border-left:2px solid var(--oc-primary);padding-left:14px}.toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.footer{border-top:1px solid var(--oc-border);padding-top:14px;display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--oc-muted)}
.repository-browser .oc-sdk-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.repository-browser .oc-sdk-row-main{grid-column:1/-1}.repository-browser .oc-sdk-badge{justify-self:start}.repository-browser .oc-sdk-row-meta{justify-self:end}
@container(min-width:620px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.split{grid-template-columns:minmax(0,1.15fr) minmax(260px,.85fr)}.lanes{grid-template-columns:repeat(3,minmax(0,1fr))}.wide{grid-column:1/-1}}
@media(min-width:760px){.example{padding:32px;gap:28px}.hero{padding-top:16px}.card{padding:22px}}
@media(prefers-reduced-motion:reduce){.example *{animation:none!important;transition:none!important}}
`;

export const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', content = '') => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  if (tag === 'pre') node.tabIndex = 0;
  return node;
};

export const row = (parent: Element) => { const node = element('div', 'row'); parent.append(node); return node; };
export const stack = (parent: Element) => { const node = element('div', 'stack'); parent.append(node); return node; };
export const paragraph = (parent: Element, content: string, className = 'muted') => { const node = element('p', className, content); parent.append(node); return node; };

type ExampleIdentity = { number: string; title: string; description: string; api: string };
export const createExample = (root: Element, identity: ExampleIdentity) => {
  if (!document.getElementById('example-style')) {
    const style = element('style', '', css); style.id = 'example-style'; document.head.append(style);
  }
  root.replaceChildren();
  const page = element('main', 'example');
  const hero = element('header', 'hero');
  const mark = row(hero);
  mark.append(element('span', 'eyebrow', `OpenChamber · ${identity.number}`));
  mountBadge(mark, { label: identity.api, tone: 'neutral' });
  hero.append(element('h1', '', identity.title));
  paragraph(hero, identity.description);
  const toolbar = element('div', 'toolbar');
  const content = element('div', 'stack');
  const footer = element('footer', 'footer');
  footer.append(element('span', '', 'Built with the OpenChamber SDK'), element('span', '', 'Explore. Adapt. Make it yours.'));
  page.append(hero, toolbar, content, footer); root.append(page);
  return { page, hero, toolbar, content };
};

export const card = (parent: Element, title: string, description = '') => {
  const section = element('section', 'card');
  const heading = element('header', 'card-heading');
  heading.append(element('h2', '', title));
  if (description) paragraph(heading, description);
  const body = element('div', 'stack'); section.append(heading, body); parent.append(section);
  return body;
};

export const codeSample = (parent: Element, code: string) => {
  const details = element('details', 'api');
  details.append(element('summary', '', 'How this works'), element('pre', 'code', code)); parent.append(details);
};

export const feedback = (parent: Element) => {
  const slot = element('div'); slot.hidden = true; slot.setAttribute('role', 'status'); parent.append(slot);
  const banner = mountBanner(slot, { tone: 'info', title: '' });
  return {
    run: async (operation: () => Promise<void>) => {
      try { await operation(); }
      catch (error) {
        slot.hidden = false;
        banner.update({ tone: 'error', title: 'Could not finish', body: error instanceof Error ? error.message : String(error) });
      }
    },
    clear: () => { slot.hidden = true; },
    show: (title: string, body = '', tone: 'info' | 'success' | 'warning' | 'error' = 'info') => {
      slot.hidden = false; banner.update({ title, body, tone });
    },
  };
};

export const metrics = (parent: Element, labels: string[]) => {
  const grid = element('div', 'metrics'); parent.append(grid);
  const values = labels.map((label) => {
    const item = element('div', 'metric'); const value = element('strong', '', '—');
    item.append(value, element('span', '', label)); grid.append(item); return value;
  });
  return (next: Array<string | number>) => values.forEach((node, index) => { node.textContent = String(next[index] ?? '—'); });
};
