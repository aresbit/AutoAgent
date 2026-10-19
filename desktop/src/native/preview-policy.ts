/**
 * Preview origin policy.
 *
 * The allowlist is exact origins. Private/loopback literals (including `.local`
 * mDNS names and RFC1918 ranges) are rejected unless the operator explicitly
 * opts in with AUTOAGENT_PREVIEW_ALLOW_PRIVATE=1, because a preview tab is an
 * untrusted renderer and private services are not browsable by default.
 *
 * DNS rebinding cannot be fully solved at URL-validation time: a public name
 * may resolve to a private address after the check. The navigation guard denies
 * literal private hosts, redirects leave the allowed origin (and are blocked by
 * the navigation check), and the preview partition has no credentials or
 * downloads. Domain-level rebinding remains a documented residual risk.
 */

export interface OriginPolicyOptions {
  readonly allowInsecureHttp?: boolean;
  readonly allowPrivate?: boolean;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  if (host === "::1" || host === "::" || host === "0.0.0.0") return true;

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) literals.
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(host);
}

/** Validate one allowlist entry and return its canonical origin. */
export function normalizePreviewOrigin(
  value: string,
  options: OriginPolicyOptions = {},
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("preview allowlist entry is not a URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("preview allowlist entry must not contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("preview allowlist entries must be origins without a path");
  }
  if (url.protocol === "https:") {
    if (options.allowPrivate !== true && isPrivateHostname(url.hostname)) {
      throw new Error(
        "preview allowlist entry is a private address; set AUTOAGENT_PREVIEW_ALLOW_PRIVATE=1 to allow it",
      );
    }
    return url.origin;
  }
  if (
    options.allowInsecureHttp === true &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname)
  ) {
    return url.origin;
  }
  throw new Error("preview allowlist entries must use https");
}
