export type ExtractedPage = {
  title?: string;
  description?: string;
  text: string;
  links?: PageLink[];
};

export type PageLink = {
  text: string;
  url: string;
};

const MAX_LINKS = 30;

export function extractPageContent(input: {
  body: string;
  contentType?: string;
  baseUrl: string;
  maxChars: number;
  includeLinks: boolean;
}): ExtractedPage {
  if (isHtml(input.contentType, input.body)) {
    return extractHtmlContent(input);
  }

  return {
    text: cleanText(input.body).slice(0, input.maxChars)
  };
}

function extractHtmlContent(input: {
  body: string;
  baseUrl: string;
  maxChars: number;
  includeLinks: boolean;
}): ExtractedPage {
  const title = firstMatch(input.body, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description =
    metaContent(input.body, "description") ??
    metaContent(input.body, "og:description") ??
    undefined;
  const links = input.includeLinks ? extractLinks(input.body, input.baseUrl) : undefined;

  const body = firstMatch(input.body, /<body[^>]*>([\s\S]*?)<\/body>/i) ?? input.body;
  const text = htmlToText(body).slice(0, input.maxChars);

  return {
    title: title ? decodeEntities(cleanText(title)) : undefined,
    description: description ? decodeEntities(cleanText(description)) : undefined,
    text,
    links
  };
}

function htmlToText(html: string): string {
  return decodeEntities(
    cleanText(
      html
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<(br|hr)\b[^>]*>/gi, "\n")
        .replace(/<\/(p|div|section|article|header|footer|main|li|tr|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function extractLinks(html: string, baseUrl: string): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html)) && links.length < MAX_LINKS) {
    const href = match[1];
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
      continue;
    }

    const url = resolveUrl(href, baseUrl);
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);
    links.push({
      url,
      text: htmlToText(match[2] ?? "").slice(0, 160)
    });
  }

  return links;
}

function isHtml(contentType: string | undefined, body: string): boolean {
  return (
    contentType?.includes("text/html") === true ||
    /^\s*<!doctype html/i.test(body) ||
    /^\s*<html/i.test(body)
  );
}

function metaContent(html: string, name: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escapeRegex(name)}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return firstMatch(html, pattern);
}

function firstMatch(input: string, pattern: RegExp): string | undefined {
  return pattern.exec(input)?.[1];
}

function resolveUrl(href: string, baseUrl: string): string | undefined {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function cleanText(input: string): string {
  return input
    .replace(/\r/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };

  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, value: string) => {
    if (value.startsWith("#x")) {
      return codePoint(Number.parseInt(value.slice(2), 16)) ?? entity;
    }

    if (value.startsWith("#")) {
      return codePoint(Number.parseInt(value.slice(1), 10)) ?? entity;
    }

    return named[value.toLowerCase()] ?? entity;
  });
}

function codePoint(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }

  try {
    return String.fromCodePoint(value);
  } catch {
    return undefined;
  }
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
