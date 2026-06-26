/**
 * Discord attachment handling for the messenger ↔ OpenCode bridge.
 *
 * Attachment pipeline:
 *   - Text-like files are downloaded and inlined into the prompt as
 *     `<attachment filename="..." mime="...">…</attachment>` XML blocks.
 *   - Images and PDFs are downloaded and converted to base64 data URLs,
 *     forwarded to OpenCode as `file` parts on the prompt.
 *   - Voice messages (audio attachments) are transcribed through the
 *     server's OpenAI-compatible STT endpoint when one is configured.
 *   - Discord's "send message as file" → when the message body is empty
 *     and a text attachment exists, the attachment content becomes the
 *     prompt itself.
 */

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
  'application/sql',
]);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'json', 'jsonc', 'xml', 'yml', 'yaml', 'toml',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'svg', 'sh',
  'bash', 'zsh', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cs', 'php', 'sql', 'env', 'ini', 'cfg', 'conf', 'diff', 'patch', 'csv', 'tsv',
]);
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_MIME = 'application/pdf';

export const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_BINARY_ATTACHMENT_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024; // matches /api/stt limit
const MAX_INLINE_TEXT_CHARS = 60_000;

function extOf(filename) {
  const idx = String(filename ?? '').lastIndexOf('.');
  if (idx === -1) return '';
  return String(filename).slice(idx + 1).toLowerCase();
}

/** Classify a Discord attachment into how the bridge should handle it. */
export function classifyAttachment(attachment) {
  const mime = String(attachment?.content_type ?? attachment?.contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const filename = attachment?.filename ?? attachment?.name ?? 'attachment';

  if (mime.startsWith('audio/')) return 'audio';
  if (IMAGE_MIME.has(mime) || mime.startsWith('image/')) return 'image';
  if (mime === PDF_MIME) return 'pdf';
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p)) || TEXT_MIME_EXACT.has(mime)) {
    return 'text';
  }
  // No/unknown mime — fall back to the file extension.
  if (TEXT_EXTENSIONS.has(extOf(filename))) return 'text';
  return 'unknown';
}

/** Render a text attachment as an inline XML block. */
export function renderTextAttachmentBlock({ filename, mime, content }) {
  const safeName = String(filename ?? 'attachment').replace(/"/g, "'");
  const safeMime = String(mime ?? 'text/plain').replace(/"/g, "'");
  const clipped =
    content.length > MAX_INLINE_TEXT_CHARS
      ? content.slice(0, MAX_INLINE_TEXT_CHARS) + '\n…(truncated)'
      : content;
  return `<attachment filename="${safeName}" mime="${safeMime}">\n${clipped}\n</attachment>`;
}

/** Render a failed attachment as a self-closing XML stub. */
export function renderFailedAttachmentBlock({ filename, error }) {
  const safeName = String(filename ?? 'attachment').replace(/"/g, "'");
  const safeError = String(error ?? 'failed').replace(/"/g, "'").slice(0, 200);
  return `<attachment filename="${safeName}" error="${safeError}" />`;
}

/**
 * Download and process Discord attachments for an inbound message.
 *
 * @param {object} args
 * @param {Array<object>} args.attachments - raw Discord attachment objects
 * @param {(url: string) => Promise<Response>} [args.fetchImpl] - injectable for tests
 * @param {(args: { audioBuffer: Buffer, mimeType: string, filename: string }) => Promise<string|null>} [args.transcribe]
 *   - optional voice transcription hook; returns transcript text or null
 * @returns {Promise<{
 *   textBlocks: string[],
 *   fileParts: Array<{ type: 'file', mime: string, filename: string, url: string }>,
 *   transcripts: string[],
 *   notes: string[],
 * }>}
 */
export async function processDiscordAttachments({ attachments, fetchImpl = fetch, transcribe = null }) {
  const textBlocks = [];
  const fileParts = [];
  const transcripts = [];
  const notes = [];

  const list = Array.isArray(attachments) ? attachments : [];
  for (const attachment of list) {
    const filename = attachment?.filename ?? attachment?.name ?? 'attachment';
    const url = attachment?.url ?? attachment?.proxy_url ?? null;
    const size = Number(attachment?.size ?? 0);
    const mime = String(attachment?.content_type ?? '').split(';')[0].trim() || 'application/octet-stream';
    const kind = classifyAttachment(attachment);

    if (!url) {
      textBlocks.push(renderFailedAttachmentBlock({ filename, error: 'no url' }));
      continue;
    }

    if (kind === 'unknown') {
      notes.push(`Skipped attachment \`${filename}\` (unsupported type ${mime})`);
      continue;
    }

    const maxBytes =
      kind === 'text' ? MAX_TEXT_ATTACHMENT_BYTES
      : kind === 'audio' ? MAX_AUDIO_ATTACHMENT_BYTES
      : MAX_BINARY_ATTACHMENT_BYTES;
    if (size > maxBytes) {
      textBlocks.push(renderFailedAttachmentBlock({ filename, error: `too large (${size} bytes)` }));
      continue;
    }

    let buffer;
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        textBlocks.push(renderFailedAttachmentBlock({ filename, error: `Failed to fetch: ${response.status}` }));
        continue;
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (err) {
      textBlocks.push(renderFailedAttachmentBlock({ filename, error: err?.message ?? 'download failed' }));
      continue;
    }
    if (buffer.length > maxBytes) {
      textBlocks.push(renderFailedAttachmentBlock({ filename, error: `too large (${buffer.length} bytes)` }));
      continue;
    }

    if (kind === 'text') {
      textBlocks.push(
        renderTextAttachmentBlock({ filename, mime, content: buffer.toString('utf8') }),
      );
      continue;
    }

    if (kind === 'image' || kind === 'pdf') {
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      fileParts.push({ type: 'file', mime, filename, url: dataUrl });
      continue;
    }

    // kind === 'audio' — voice message / audio file.
    if (typeof transcribe === 'function') {
      try {
        const transcript = await transcribe({ audioBuffer: buffer, mimeType: mime, filename });
        if (transcript && transcript.trim().length > 0) {
          transcripts.push(transcript.trim());
          continue;
        }
        notes.push(`Voice message \`${filename}\` produced an empty transcript`);
      } catch (err) {
        notes.push(`Could not transcribe \`${filename}\`: ${err?.message ?? 'transcription failed'}`);
      }
    } else {
      notes.push(
        `Voice message \`${filename}\` received but speech-to-text is not configured — set a Custom STT server in OpenChamber Settings → Voice.`,
      );
    }
  }

  return { textBlocks, fileParts, transcripts, notes };
}

/**
 * Compose the final prompt text from the user's message body plus
 * processed attachments:
 *   - transcripts replace/augment an empty body (voice messages)
 *   - "message sent as file": empty body + exactly one text block → the
 *     attachment content IS the prompt (without the XML wrapper)
 *   - otherwise text blocks are appended after the body
 */
export function composePromptText({ body, textBlocks, transcripts }) {
  const trimmedBody = String(body ?? '').trim();
  const pieces = [];

  if (trimmedBody.length > 0) pieces.push(trimmedBody);
  if (Array.isArray(transcripts) && transcripts.length > 0) {
    pieces.push(...transcripts);
  }

  const blocks = Array.isArray(textBlocks) ? textBlocks : [];
  if (pieces.length === 0 && blocks.length === 1) {
    // "Send message as file" — unwrap a single text attachment into the prompt.
    const m = blocks[0].match(/^<attachment [^>]*>\n([\s\S]*)\n<\/attachment>$/);
    if (m) return m[1];
  }
  pieces.push(...blocks);

  return pieces.join('\n\n');
}

/**
 * Resolve raw Discord mention syntax into human-readable names so the AI
 * never sees opaque snowflake IDs.
 *
 *   <@123> / <@!123>  → @username (from the gateway `mentions` array)
 *   <@&456>           → @role-name (via injected role lookup)
 *   <#789>            → #channel-name (via injected channel lookup)
 *
 * Lookups are best-effort; unresolved mentions are left as-is.
 */
export async function resolveDiscordMentions({ text, message, lookupRole = null, lookupChannel = null }) {
  let result = String(text ?? '');
  if (!result.includes('<')) return result;

  const mentionUsers = new Map(
    (Array.isArray(message?.mentions) ? message.mentions : [])
      .filter((u) => u?.id)
      .map((u) => [String(u.id), u.global_name || u.username || u.id]),
  );

  // User mentions — resolvable synchronously from the message payload.
  result = result.replace(/<@!?(\d+)>/g, (full, id) => {
    const name = mentionUsers.get(id);
    return name ? `@${name}` : full;
  });

  // Role mentions.
  if (typeof lookupRole === 'function') {
    const roleIds = [...result.matchAll(/<@&(\d+)>/g)].map((m) => m[1]);
    for (const roleId of new Set(roleIds)) {
      try {
        const name = await lookupRole(roleId);
        if (name) result = result.replaceAll(`<@&${roleId}>`, `@${name}`);
      } catch {
        // leave as-is
      }
    }
  }

  // Channel mentions.
  if (typeof lookupChannel === 'function') {
    const channelIds = [...result.matchAll(/<#(\d+)>/g)].map((m) => m[1]);
    for (const channelId of new Set(channelIds)) {
      try {
        const name = await lookupChannel(channelId);
        if (name) result = result.replaceAll(`<#${channelId}>`, `#${name}`);
      } catch {
        // leave as-is
      }
    }
  }

  return result;
}
