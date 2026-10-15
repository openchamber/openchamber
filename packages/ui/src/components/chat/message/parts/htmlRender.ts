import { z } from 'zod';

import type { Theme } from '@/types/theme';

/**
 * Pages an agent shows with the `openchamber_render` tool. The page is the
 * call's own `html` input; the chat draws it in a sandboxed frame without
 * `allow-same-origin`, so its scripts run in an opaque origin with no access to
 * OpenChamber's storage, credentials or DOM.
 *
 * A small bootstrap goes into the page's head ahead of its own styles. It sets
 * the app theme as CSS variables (and swaps them when the host posts a new
 * theme), reports the page's content height so the frame fits it, and hands
 * http(s) link clicks to the host, which opens them in the browser; a page
 * never navigates the frame away from itself.
 */

export const HTML_RENDER_MIN_HEIGHT = 48;
// Taller pages scroll inside the frame. The agent-facing description in
// packages/web/server/lib/agent-tool/runtime.js states this limit.
const HTML_RENDER_MAX_HEIGHT = 1200;
// On a touch screen a page never scrolls inside its frame in the chat. A frame
// that scrolls keeps a swipe that starts on it, and one as tall as the screen
// left no place to swipe the chat from. This ceiling only stops a page whose
// height grows with its frame from growing without end.
export const HTML_RENDER_TOUCH_MAX_HEIGHT = 20_000;

const MESSAGE_PREFIX = 'openchamber:html-render:';
const THEME_MESSAGE = `${MESSAGE_PREFIX}theme`;
const SIZE_MESSAGE = `${MESSAGE_PREFIX}size`;
const OPEN_LINK_MESSAGE = `${MESSAGE_PREFIX}open-link`;
const KEY_MESSAGE = `${MESSAGE_PREFIX}key`;
const SELECTION_MESSAGE = `${MESSAGE_PREFIX}selection`;
// The longest selection a page reports; the bootstrap cuts at this length.
const HTML_RENDER_SELECTION_MAX_LENGTH = 20_000;

export interface HtmlRenderTheme {
    appearance: 'light' | 'dark';
    variables: Record<string, string>;
}

interface HtmlRenderFonts {
    sans: string;
    mono: string;
}

/**
 * Chart series after the accent, the same in every theme. A theme's syntax
 * colors were used here first, but they are picked for reading code: in the
 * default theme they made near-twins (the accent orange beside the string
 * salmon, two teals, two greens), and the first two series of almost every
 * chart blurred together. These hues stay apart from each other and from any
 * accent; the light set is darker so it holds on a light background.
 */
const CHART_SERIES = {
    dark: ['#60a5fa', '#2dd4bf', '#a78bfa', '#f472b6', '#a3e635'],
    light: ['#2563eb', '#0d9488', '#7c3aed', '#db2777', '#65a30d'],
} as const;

/**
 * The variables a page styles against. The names follow the shadcn
 * convention models already write. The agent-facing description in
 * packages/web/server/lib/agent-tool/runtime.js lists them; change both together.
 */
export function htmlRenderTheme(theme: Theme, fonts: HtmlRenderFonts): HtmlRenderTheme {
    const { surface, interactive, primary, status, syntax } = theme.colors;
    return {
        appearance: theme.metadata.variant,
        variables: {
            '--background': surface.background,
            '--foreground': surface.foreground,
            '--muted': surface.muted,
            '--muted-foreground': surface.mutedForeground,
            '--card': surface.elevated,
            '--card-foreground': surface.elevatedForeground,
            '--border': interactive.border,
            '--primary': primary.base,
            '--primary-foreground': primary.foreground ?? surface.background,
            '--destructive': status.error,
            '--warning': status.warning,
            '--success': status.success,
            '--info': status.info,
            '--code-background': syntax.base.background,
            '--code-foreground': syntax.base.foreground,
            // The first series is the theme's accent, so the main one reads
            // as the app's own; the rest are a fixed set (CHART_SERIES).
            '--chart-1': primary.base,
            ...Object.fromEntries(CHART_SERIES[theme.metadata.variant].map((color, index) => [`--chart-${index + 2}`, color])),
            '--radius': '0.5rem',
            '--font-sans': fonts.sans,
            '--font-mono': fonts.mono,
        },
    };
}

// The page sits on the chat's own background, and a scrollbar inside the
// reply would read as a box within the thread, so it stays hidden. Media
// shrinks to the column. What is still wider (a wide table) scrolls sideways,
// without the elastic bounce at its edges; the page never scrolls vertically
// while it fits its frame (see the bootstrap), so a vertical swipe still
// scrolls the chat. Only the horizontal bounce is turned off: turning off the
// vertical one would also stop a vertical swipe from reaching the chat.
const BASE_CSS = 'html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none;overflow-x:auto;overscroll-behavior-x:none}'
    + 'html::-webkit-scrollbar{display:none}body{margin:0}a{color:var(--primary)}code,kbd,pre,samp{font-family:var(--font-mono)}img,svg,video,canvas{max-width:100%}';

const CSS_VARIABLE_NAME = /^--[a-z0-9-]+$/;
const sanitizeCssValue = (value: string): string => value.replace(/[;{}<>]/g, '');

function themeCss(theme: HtmlRenderTheme): string {
    const declarations = Object.entries(theme.variables)
        .filter(([name]) => CSS_VARIABLE_NAME.test(name))
        .map(([name, value]) => `${name}:${sanitizeCssValue(value)};`)
        .join('');
    return `:root{color-scheme:${theme.appearance};${declarations}}${BASE_CSS}`;
}

// Runs in the page's head, before its own styles and scripts. It rewrites its
// own <style> element rather than setting inline properties, so the page's
// own :root rules still win. The height it reports is the document's content
// height: the root's box when the page is shorter than the frame, its scroll
// height when the page is taller.
//
// A page that fits its frame cannot scroll at all. A document that can scroll
// keeps a touch that starts on it: on a phone, a swipe over a page that fit
// its frame bounced inside it instead of scrolling the chat. Only a page taller
// than its frame (past the height cap, or in the full-screen view) scrolls.
//
// A focused frame keeps every key from the app, so a Cmd/Ctrl chord the page
// left alone is passed to the host, which replays it through the app's own
// shortcut handling. The page keeps what it handled itself, typing in its own
// fields, and the clipboard, select-all and undo chords. The deciding listener
// is added while the key dispatches, so it runs after every listener the page
// has and sees whether one of them took the key.
//
// The app cannot read a selection inside the frame, so the bootstrap reports
// it: the selected text and its box in the frame's viewport once it settles (on
// mouse up, or after a pause for keyboard and touch selections; not while the
// mouse is down), and an empty text when the selection is gone. The host shows
// the chat's selection menu from it.
//
// A tooltip or popup the page positions itself can stick out past the frame,
// where the frame cuts it off (on a phone the column is about 360px). Every
// absolutely or fixed positioned element that is partly inside and partly out
// is moved back in with the `translate` property, which the page's own
// `transform` composes with. An element wholly outside (a hidden off-screen
// panel), wider than the frame, or inside a box that scrolls or clips (where
// running past the edge is the point) is left alone. The positioned set is
// rebuilt when the DOM changes shape and checked on every change, hover, tap
// and resize; a CSS :hover tooltip changes nothing in the DOM, so hover counts.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("oc-html-render-theme");if(!s||window.parent===window)return;var B=${JSON.stringify(BASE_CSS)};`
    + `window.addEventListener("message",function(e){var d=e.data;if(e.source!==window.parent||!d||d.type!==${JSON.stringify(THEME_MESSAGE)}||!d.variables||typeof d.variables!=="object")return;var c=":root{color-scheme:"+(d.appearance==="light"?"light":"dark")+";";for(var k in d.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(d.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+B;});`
    + `document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null,u;if(!a)return;try{u=new URL(a.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();window.parent.postMessage({type:${JSON.stringify(OPEN_LINK_MESSAGE)},url:u.href},"*");},true);`
    + `var h,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);r.style.overflowY=v>window.innerHeight+1?"auto":"hidden";if(v===h)return;h=v;window.parent.postMessage({type:${JSON.stringify(SIZE_MESSAGE)},height:v},"*");};window.addEventListener("resize",z);`
    + `if(window.ResizeObserver){var o=new ResizeObserver(z);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);});}`
    + `document.addEventListener("DOMContentLoaded",z);window.addEventListener("load",z);`
    + `window.addEventListener("keydown",function(e){var t=e.composedPath()[0],f;if(!e.isTrusted||e.isComposing||!(e.metaKey||e.ctrlKey)||/^[acvxyz]$/i.test(e.key)&&!e.altKey||t&&(t.isContentEditable||/^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))return;`
    + `f=function(v){window.removeEventListener("keydown",f);if(v!==e||e.defaultPrevented)return;window.parent.postMessage({type:${JSON.stringify(KEY_MESSAGE)},key:e.key,code:e.code,metaKey:e.metaKey,ctrlKey:e.ctrlKey,shiftKey:e.shiftKey,altKey:e.altKey,repeat:e.repeat},"*");};`
    + `window.addEventListener("keydown",f);setTimeout(function(){window.removeEventListener("keydown",f);});},true);`
    + `var SL="",ST=0,SD=0,SF=function(f){clearTimeout(ST);ST=0;var s=window.getSelection(),t=s?s.toString().trim().slice(0,${HTML_RENDER_SELECTION_MAX_LENGTH}):"",r={top:0,left:0,width:0,height:0},b;`
    + `if(t&&s.rangeCount){b=s.getRangeAt(0).getBoundingClientRect();r={top:b.top,left:b.left,width:b.width,height:b.height};}else t="";`
    + `if(t===SL&&!(f&&t))return;SL=t;window.parent.postMessage({type:${JSON.stringify(SELECTION_MESSAGE)},text:t,rect:r},"*");};`
    + `document.addEventListener("selectionchange",function(){if(SD)return;clearTimeout(ST);ST=setTimeout(SF,200);});`
    + `document.addEventListener("mousedown",function(){SD=1;},true);document.addEventListener("mouseup",function(){SD=0;clearTimeout(ST);ST=setTimeout(function(){SF(1);},10);},true);`
    + `var P=[],Q=0,N=1,C=function(e){for(var a=e.parentElement;a&&a!==document.body;a=a.parentElement){var o=getComputedStyle(a);if(o.overflowX!=="visible"||o.overflowY!=="visible")return 1;}return 0;},`
    + `W=function(){P=[];var a=document.body?document.body.getElementsByTagName("*"):[];for(var i=0;i<a.length&&i<5000;i++){var p=getComputedStyle(a[i]).position;if((p==="absolute"||p==="fixed")&&!C(a[i]))P.push(a[i]);}},`
    + `F=function(){Q=0;if(N){N=0;W();}var w=document.documentElement.clientWidth;for(var i=0;i<P.length;i++){var e=P[i],x=e.__ocx||0,y=e.__ocy||0,r=e.getBoundingClientRect(),l=r.left-x,g=r.right-x,t=r.top-y,b=r.bottom-y,nx=0,ny=0;if(!r.width&&!r.height)continue;`
    + `if(g>0&&l<w&&r.width<=w){if(g>w)nx=w-g;if(l+nx<0)nx=-l;}if(t<0&&b>0)ny=-t;if(nx!==x||ny!==y){e.__ocx=nx;e.__ocy=ny;e.style.translate=nx||ny?nx+"px "+ny+"px":"";}}},`
    + `U=function(r){if(r)N=1;if(!Q)Q=requestAnimationFrame(F);};`
    + `new MutationObserver(function(m){for(var i=0;i<m.length;i++)if(m[i].type==="childList"||m[i].attributeName==="class")N=1;U(0);}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["style","class"]});`
    + `["mouseover","click","touchstart","scroll","resize"].forEach(function(n){window.addEventListener(n,function(){U(0);},{capture:true,passive:true});});document.addEventListener("DOMContentLoaded",function(){U(1);});})();`;

// Comments and raw-text elements are blanked to the same length before the
// head is located, so a "<head>" written inside a script or comment is never
// where the bootstrap lands.
const blankNonMarkup = (html: string): string => html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|template|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => ' '.repeat(match.length),
);

/**
 * The document the frame loads: the agent's page with the bootstrap first in
 * its head. `contained` is for a frame with nothing around it to scroll (the
 * full-screen view): the page's own scrolling stops at its edges without the
 * elastic bounce.
 */
export function buildHtmlRenderDocument(html: string, theme: HtmlRenderTheme, { contained = false } = {}): string {
    const scan = blankNonMarkup(html);
    const bootstrap = [
        /<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
        /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<style id="oc-html-render-theme">${themeCss(theme)}</style>`,
        // Its own element: a theme switch rewrites the theme style whole.
        contained ? '<style>html{overscroll-behavior:none}</style>' : '',
        `<script>${BOOTSTRAP_SCRIPT}</script>`,
    ].join('');
    const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
    if (headOpen) {
        const at = headOpen.index + headOpen[0].length;
        return html.slice(0, at) + bootstrap + html.slice(at);
    }
    const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
    if (htmlOpen) {
        const at = htmlOpen.index + htmlOpen[0].length;
        return `${html.slice(0, at)}<head>${bootstrap}</head>${html.slice(at)}`;
    }
    const doctype = /^\s*<!doctype[^>]*>/i.exec(scan);
    if (doctype) {
        const at = doctype[0].length;
        return `${html.slice(0, at)}<head>${bootstrap}</head>${html.slice(at)}`;
    }
    return `<!doctype html><head>${bootstrap}</head>${html}`;
}

export const htmlRenderThemeMessage = (theme: HtmlRenderTheme) => ({ type: THEME_MESSAGE, ...theme });

const keyChordSchema = z.object({
    key: z.string().min(1).max(32),
    code: z.string().max(32),
    metaKey: z.boolean(),
    ctrlKey: z.boolean(),
    shiftKey: z.boolean(),
    altKey: z.boolean(),
    repeat: z.boolean(),
});

/** A key a page passed on; the host replays it as a keydown of its own. */
export type HtmlRenderKeyChord = z.infer<typeof keyChordSchema>;

const selectionRectSchema = z.object({
    top: z.number().finite(),
    left: z.number().finite(),
    width: z.number().finite().min(0),
    height: z.number().finite().min(0),
});

type HtmlRenderFrameMessage =
    | { kind: 'size'; height: number }
    | { kind: 'open-link'; url: string }
    | { kind: 'key'; chord: HtmlRenderKeyChord }
    // An empty text means the selection is gone.
    | { kind: 'selection'; text: string; rect: z.infer<typeof selectionRectSchema> };

const frameMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal(SIZE_MESSAGE), height: z.number().positive() }),
    z.object({ type: z.literal(OPEN_LINK_MESSAGE), url: z.string().regex(/^https?:\/\//i) }),
    keyChordSchema.extend({ type: z.literal(KEY_MESSAGE) }),
    z.object({
        type: z.literal(SELECTION_MESSAGE),
        text: z.string().max(HTML_RENDER_SELECTION_MAX_LENGTH),
        rect: selectionRectSchema,
    }),
]);

/** The message a page's bootstrap posted, or null for anything else. */
export function readHtmlRenderFrameMessage(event: Pick<MessageEvent, 'data'>): HtmlRenderFrameMessage | null {
    const parsed = frameMessageSchema.safeParse(event.data);
    if (!parsed.success) return null;
    const message = parsed.data;
    if (message.type === SIZE_MESSAGE) return { kind: 'size', height: message.height };
    if (message.type === OPEN_LINK_MESSAGE) return { kind: 'open-link', url: message.url };
    if (message.type === SELECTION_MESSAGE) return { kind: 'selection', text: message.text.trim(), rect: message.rect };
    // Only a chord with Cmd or Ctrl: the page never passes plain typing on,
    // and a page that tried to must not reach the app's single-key handling.
    if (!message.metaKey && !message.ctrlKey) return null;
    return { kind: 'key', chord: keyChordSchema.parse(message) };
}

export const clampHtmlRenderHeight = (height: number, maxHeight: number = HTML_RENDER_MAX_HEIGHT): number => (
    Math.min(maxHeight, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(height)))
);

/** A download name from the page title, without characters file systems reject. */
export function htmlRenderFileName(title: string): string {
    const name = title
        .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
        .trim();
    return `${name || 'page'}.html`;
}
