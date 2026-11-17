/**
 * Posts are Markdown, rendered through a strict sanitizer (DM 5.4; M7
 * decision 3). `micromark` is the CommonMark reference parser: raw HTML comes
 * out escaped and links with a dangerous protocol come out with an empty
 * `href`. Our step then rewrites what it made:
 * - a link stays a link only if it is `http(s)` and the author may post links,
 *   or its host is on the embed allow-list (HLD §7.1); otherwise it's text;
 * - an image becomes its alt text, since posts carry no images at launch.
 *
 * The regexes below read micromark's own output, never the author's: every
 * `<` the author typed is already `&lt;`, and attributes are quoted and
 * escaped, so `<a href="…">` and `<img … />` only ever come from micromark.
 * CommonMark links never nest.
 */
import { micromark } from "micromark";

/** Media hosts whose links every trust level may post (HLD §7.1). */
export const EMBED_HOSTS = [
  "youtube.com",
  "youtu.be",
  "imgur.com",
  "x.com",
  "twitter.com",
  "streamable.com",
] as const;

/** Every link we render opens apart from the page and passes no rank. */
const LINK_ATTRS = 'rel="nofollow ugc noopener noreferrer" target="_blank"';

const decodeAttr = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

function parseHttpUrl(href: string): URL | null {
  try {
    const url = new URL(decodeAttr(href));
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** True for an allow-listed host or one of its subdomains. */
export function isEmbedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return EMBED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

const SITE_PATH = /^\/(?![/\\])[^\s"]*$/;
const LINK = /<a href="([^"]*)"(?: title="[^"]*")?>([\s\S]*?)<\/a>/g;
const IMAGE = /<img src="[^"]*" alt="([^"]*)"(?: title="[^"]*")? \/>/g;

/** Safe HTML for a post body. */
export function renderPost(
  markdown: string,
  options: { linksAllowed: boolean },
): string {
  const html = micromark(markdown);
  return html
    .replace(IMAGE, (_match, alt: string) => alt)
    .replace(LINK, (_match, href: string, inner: string) => {
      // A page on this site: a path, never `//host` or `/\host`, which a
      // browser reads as another host. Safe for anyone, so it stays a link.
      if (SITE_PATH.test(href)) return `<a href="${href}">${inner}</a>`;
      const url = parseHttpUrl(href);
      if (!url) return inner;
      if (!options.linksAllowed && !isEmbedHost(url.hostname)) return inner;
      return `<a href="${href}" ${LINK_ATTRS}>${inner}</a>`;
    });
}
