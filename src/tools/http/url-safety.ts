/**
 * SSRF 防护：判断一个 URL 能不能被插件抓取。
 *
 * ## 这份名单保护什么
 *
 * 云端 Worker 里能访问的东西远不止「公网」：
 * - `127.0.0.0/8` / `::1`：本机回环（`localhost` 的管理端口）
 * - `10/8`、`172.16/12`、`192.168/16` / `fc00::/7`：内网
 * - `169.254/16` / `fe80::/10`：链路本地，**云厂商元数据服务就在这**
 *   （`169.254.169.254` 能直接拿到实例凭证）
 * - `100.64/10`：CGNAT，运营商级 NAT 段，云上常被用作 VPC 内部地址
 * - `192.0.0.0/24`、`198.18.0.0/15`：特殊用途 / 基准测试段，任何真实服务都不该在这里
 * - `fec0::/10`：已废弃的 IPv6 site-local，等价于「内网」
 * - IPv4 兼容 IPv6（`::a.b.c.d`）、IPv4 映射 IPv6（`::ffff:a.b.c.d`）、
 *   NAT64（`64:ff9b::/96`）：三种把 IPv4 字面量藏进 IPv6 地址的写法
 *
 * ## 明确的限制：**不做 DNS 解析**
 *
 * URL 里写的是域名时这里只做字面量匹配（`localhost`、`*.localhost`），
 * 不做 DNS 查询。所以 `169.254.169.254.nip.io` 这类「解析后指向内网的公有域名」
 * **拦不住**，DNS rebinding（先解析到公网、再解析到内网）也拦不住。
 *
 * 不解析的理由：Worker 里没有同步 DNS；每次抓取多做一次查询既费子请求额度，
 * 又仍然存在 TOCTOU 窗口（校验时解析到公网、fetch 时解析到内网），
 * 只能算「提高门槛」，不能算「防住了」。真正的防线是网络层（Cloudflare 的
 * 出口访问控制），这里只是纵深防御的一层。**不要把这些限制包装成「已防护」**。
 */

/** IPv4 内网 / 保留段。返回 true = 禁止访问 */
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
    // 0.0.0.0/8「本网络」、10/8 私网、127/8 回环
    first === 0 ||
    first === 10 ||
    first === 127 ||
    // 100.64.0.0/10 运营商级 NAT（CGNAT）—— 云上常被拿来当 VPC 内部地址
    (first === 100 && second >= 64 && second <= 127) ||
    // 169.254.0.0/16 链路本地，云厂商元数据服务在这里
    (first === 169 && second === 254) ||
    // 172.16.0.0/12 私网
    (first === 172 && second >= 16 && second <= 31) ||
    // 192.0.0.0/24 IETF 协议保留、192.0.2.0/24 TEST-NET-1
    (first === 192 && (second === 0 || second === 2)) ||
    // 192.168.0.0/16 私网
    (first === 192 && second === 168) ||
    // 198.18.0.0/15 基准测试段、198.51.100.0/24 TEST-NET-2
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    // 203.0.113.0/24 TEST-NET-3
    (first === 203 && second === 0) ||
    // 224.0.0.0/4 组播、240.0.0.0/4 保留（含 255.255.255.255 广播）
    first >= 224
  );
}

function isBlockedIpv6(host: string): boolean {
  if (!host.includes(":")) {
    return false;
  }

  const expanded = expandIpv6(host);
  if (!expanded) {
    // 解析不了就当禁止：宁可拦住合法地址，也不能放过一个精心构造的
    return true;
  }

  // ::（未指定）与 ::1（回环）
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

  // fec0::/10 已废弃的 site-local，语义等同「内网」
  if ((first & 0xffc0) === 0xfec0) {
    return true;
  }

  // ::ffff:0:0/96 IPv4-mapped IPv6 addresses.
  if (expanded.slice(0, 5).every((segment) => segment === 0) && expanded[5] === 0xffff) {
    return isBlockedIpv4(embeddedIpv4(expanded));
  }

  // 64:ff9b::/96 well-known NAT64 prefix can tunnel IPv4 literals.
  if (
    first === 0x0064 &&
    second === 0xff9b &&
    expanded.slice(2, 6).every((segment) => segment === 0)
  ) {
    return isBlockedIpv4(embeddedIpv4(expanded));
  }

  // ::a.b.c.d IPv4-compatible IPv6（前 6 段为 0、不是 :: / ::1）。
  //
  // 实测 `http://[::127.0.0.1]/`、`http://[::192.168.1.1]/` 在旧实现里被放行：
  // 当时只认得 ::ffff: 前缀，`::7f00:1` 这种写法一路走到 false。
  if (expanded.slice(0, 6).every((segment) => segment === 0)) {
    return isBlockedIpv4(embeddedIpv4(expanded));
  }

  return false;
}

/** 从 IPv6 展开后的最后两段拼出内嵌的 IPv4 字面量 */
function embeddedIpv4(expanded: number[]): string {
  const high = expanded[6] ?? 0;
  const low = expanded[7] ?? 0;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

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

function expandIpv6(host: string): number[] | undefined {
  // 末尾的点分 IPv4 写法（如 `::ffff:127.0.0.1`）：URL 解析后一般已经是十六进制，
  // 但手工调 isBlockedHostname 时可能还是点分，先折成两段。
  const withTail = host.includes(".") ? collapseEmbeddedIpv4(host) : host;
  if (!withTail) {
    return undefined;
  }

  const [headText, tailText, extra] = withTail.split("::");
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

/** 把 `::ffff:127.0.0.1` 这种尾巴是点分 IPv4 的写法折成 `::ffff:7f00:1` */
function collapseEmbeddedIpv4(host: string): string | undefined {
  const match = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (!match) {
    return undefined;
  }

  const head = match[1] ?? "";
  const ipv4 = match[2] ?? "";
  const parts = ipv4.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) {
    return undefined;
  }

  const high = ((parts[0] ?? 0) << 8) | (parts[1] ?? 0);
  const low = ((parts[2] ?? 0) << 8) | (parts[3] ?? 0);
  return `${head}${high.toString(16)}:${low.toString(16)}`;
}

function parseIpv6Segments(input: string | undefined): number[] | undefined {
  if (!input) {
    return [];
  }

  const segments = input.split(":");
  if (segments.length === 0) {
    return [];
  }

  const parsed = segments.map((segment) => {
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) {
      return Number.NaN;
    }
    return Number.parseInt(segment, 16);
  });
  return parsed.every((segment) => Number.isFinite(segment)) ? parsed : undefined;
}
