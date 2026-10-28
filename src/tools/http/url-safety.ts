export function validateFetchUrl(input: string): string | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "URL is not valid";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Only HTTP and HTTPS URLs are supported";
  }

  if (isBlockedHostname(url.hostname)) {
    return "Local or private network URLs are not allowed";
  }

  return undefined;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (!host) {
    return true;
  }

  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }

  if (isBlockedIpv4(host)) {
    return true;
  }

  return isBlockedIpv6(host);
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function isBlockedIpv4(host: string): boolean {
  const rawParts = host.split(".");
  if (rawParts.length !== 4 || rawParts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }

  const parts = rawParts.map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  // noUncheckedIndexedAccess 下这两个是 number | undefined；
  // 上面已经保证 length === 4 且每项都是数字，这里只补一个类型收窄
  if (first === undefined || second === undefined) {
    return false;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isBlockedIpv6(host: string): boolean {
  if (!host.includes(":")) {
    return false;
  }

  const expanded = expandIpv6(host);
  if (!expanded) {
    return true;
  }

  if (expanded.every((segment) => segment === 0)) {
    return true;
  }

  if (expanded.slice(0, 7).every((segment) => segment === 0) && expanded[7] === 1) {
    return true;
  }

  const first = expanded[0] ?? 0;
  const second = expanded[1] ?? 0;

  // fc00::/7 unique local addresses and fe80::/10 link-local addresses.
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) {
    return true;
  }

  // ::ffff:0:0/96 IPv4-mapped IPv6 addresses.
  if (expanded.slice(0, 5).every((segment) => segment === 0) && expanded[5] === 0xffff) {
    const ipv4 = `${(expanded[6] ?? 0) >> 8}.${(expanded[6] ?? 0) & 0xff}.${(expanded[7] ?? 0) >> 8}.${(expanded[7] ?? 0) & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  // 64:ff9b::/96 well-known NAT64 prefix can tunnel IPv4 literals.
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    expanded.slice(2, 6).every((segment) => segment === 0)
  ) {
    const ipv4 = `${(expanded[6] ?? 0) >> 8}.${(expanded[6] ?? 0) & 0xff}.${(expanded[7] ?? 0) >> 8}.${(expanded[7] ?? 0) & 0xff}`;
    return isBlockedIpv4(ipv4);
  }

  return false;
}

function expandIpv6(host: string): number[] | undefined {
  const [headText, tailText, extra] = host.split("::");
  if (extra !== undefined) {
    return undefined;
  }

  const head = parseIpv6Segments(headText);
  const tail = tailText === undefined ? [] : parseIpv6Segments(tailText);
  if (!head || !tail) {
    return undefined;
  }

  if (tailText === undefined) {
    return head.length === 8 ? head : undefined;
  }

  const missing = 8 - head.length - tail.length;
  if (missing < 1) {
    return undefined;
  }

  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function parseIpv6Segments(input: string | undefined): number[] | undefined {
  if (!input) {
    return [];
  }

  return input
    .split(":")
    .map((segment) => {
      if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
        return Number.NaN;
      }
      return Number.parseInt(segment, 16);
    })
    .every((segment) => Number.isFinite(segment))
    ? input.split(":").map((segment) => Number.parseInt(segment, 16))
    : undefined;
}
