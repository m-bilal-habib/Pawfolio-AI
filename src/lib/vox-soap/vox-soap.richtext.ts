// File: d:\Pawfolio AI\src\lib\vox-soap\vox-soap.richtext.ts

/**
 * Minimal rich-text plumbing shared by client and server.
 *
 * Section edits are stored as sanitized HTML restricted to a small
 * formatting whitelist (bold/italic/underline/strike, headings, lists,
 * paragraphs). All attributes are stripped — no links, images, classes or
 * inline handlers ever survive, stores or render unescaped.
 */

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'div',
  'span',
]);

/** Strips scripts/styles entirely, then drops every non-whitelisted tag and attribute. */
export function sanitizeRichTextHtml(html: string): string {
  return String(html ?? '')
    .replace(/<(script|style|iframe|object|embed|svg)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<([a-zA-Z0-9]+)([^>]*)>/g, (_m, tag: string, _attrs: string) => {
      const t = tag.toLowerCase();
      if (t === 'br' || t === 'hr') return t === 'br' ? '<br>' : '';
      return ALLOWED_TAGS.has(t) ? `<${t}>` : '';
    })
    .replace(/<\/([a-zA-Z0-9]+)>/g, (_m, tag: string) => {
      const t = tag.toLowerCase();
      return ALLOWED_TAGS.has(t) ? `</${t}>` : '';
    })
    .replace(/&nbsp;/gi, ' ');
}

/** Converts stored rich-text HTML to readable plain text (for export/copy). */
export function richTextToPlainText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[a-zA-Z0-9]+([^>]*)>/g, '')
    .replace(/<\/[a-zA-Z0-9]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escapes plain clinical text into safe rich-text paragraphs (editor init). */
export function escapePlainToRichHtml(text: string): string {
  const plain = String(text ?? '');
  if (!plain.trim()) return '';
  return plain
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(/\n+/)
    .map((line) => `<p>${line.trim()}</p>`)
    .join('');
}
