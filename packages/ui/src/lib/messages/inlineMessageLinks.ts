const SKILL_LINK_PREFIX = '#openchamber-skill:';
const AGENT_LINK_PREFIX = '#openchamber-agent:';
const ATTACHMENT_LINK_PREFIX = '#openchamber-attachment:';
const OPENABLE_ATTACHMENT_LINK_PREFIX = '#openchamber-attachment-open:';

// external: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent Parentheses and apostrophes remain unescaped; a closing parenthesis ends a Markdown link target.
const encodeHrefPart = (value: string): string =>
    encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export const INLINE_REFERENCE_CHIP_CLASS =
    'mx-px -my-[0.2em] inline-flex h-[1.3em] max-w-full items-center gap-1 whitespace-nowrap rounded-md border border-edge bg-background/50 px-1.5 align-middle text-[0.875em] leading-none text-foreground';

export const REFERENCE_CHIP_LABEL_CLASS = 'min-w-0 truncate leading-normal';

export const CHIP_TRAILING_PUNCTUATION = /^[.,;:!?…)\]}»”’"'%]+/;

export const INTERACTIVE_REFERENCE_CHIP_CLASS = `${INLINE_REFERENCE_CHIP_CLASS} cursor-pointer transition-colors hover:border-foreground/40`;

export const SKILL_CHIP_ICON_HREF = '#oc-book-open';

export type AttachmentCitationLink = {
    filename: string;
    iconId: string;
    openable?: boolean;
};

export const buildAgentMentionUrl = (name: string): string => {
    const encoded = encodeURIComponent(name);
    return `https://opencode.ai/docs/agents/#${encoded}`;
};

export const buildSkillHref = (name: string): string => `${SKILL_LINK_PREFIX}${encodeURIComponent(name)}`;

export const buildAgentHref = (name: string): string => `${AGENT_LINK_PREFIX}${encodeURIComponent(name)}`;

export const parseSkillHref = (href: string | null | undefined): string | null => {
    if (!href?.startsWith(SKILL_LINK_PREFIX)) return null;
    try {
        return decodeURIComponent(href.slice(SKILL_LINK_PREFIX.length));
    } catch {
        return null;
    }
};

export const parseAgentHref = (href: string | null | undefined): string | null => {
    if (!href?.startsWith(AGENT_LINK_PREFIX)) return null;
    try {
        return decodeURIComponent(href.slice(AGENT_LINK_PREFIX.length));
    } catch {
        return null;
    }
};

export const buildAttachmentHref = ({ filename, iconId, openable }: AttachmentCitationLink): string =>
    `${openable ? OPENABLE_ATTACHMENT_LINK_PREFIX : ATTACHMENT_LINK_PREFIX}${encodeHrefPart(iconId)}:${encodeHrefPart(filename)}`;

export const parseAttachmentHref = (href: string | null | undefined): AttachmentCitationLink | null => {
    const openable = href?.startsWith(OPENABLE_ATTACHMENT_LINK_PREFIX) ?? false;
    const prefix = openable ? OPENABLE_ATTACHMENT_LINK_PREFIX : ATTACHMENT_LINK_PREFIX;
    if (!href?.startsWith(prefix)) return null;
    const rest = href.slice(prefix.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) return null;
    try {
        const filename = decodeURIComponent(rest.slice(separator + 1));
        if (!filename) return null;
        const iconId = decodeURIComponent(rest.slice(0, separator));
        return openable ? { iconId, filename, openable } : { iconId, filename };
    } catch {
        return null;
    }
};
