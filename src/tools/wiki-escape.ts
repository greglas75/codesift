/**
 * Escape markdown-significant characters for safe embedding in wiki pages.
 * Uses backslash escaping (NOT HTML entities).
 */
export function escMd(s: string): string {
  // Escape: \ ` * _ { } [ ] ( ) # + - . ! < >
  return s.replace(/[\\`*_{}\[\]()#+\-.!<>]/g, "\\$&");
}

/**
 * Escape HTML-significant characters for safe embedding in Lens HTML.
 * Uses HTML entity encoding.
 */
export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
