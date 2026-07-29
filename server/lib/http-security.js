import net from "node:net";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export class HttpRequestError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = "HttpRequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function assertSafeHostBinding(host, allowRemote = false) {
  if (isLoopbackHost(host) || allowRemote) return;
  throw new Error(
    `Refusing to listen on non-loopback host '${host}'. ` +
      "Set XUANNIAO_UNSAFE_ALLOW_REMOTE=1 only on a trusted network."
  );
}

export function assertTrustedRequest(req, url, { boundHost, allowRemote = false }) {
  const requestHost = hostNameFromHeader(req.headers.host);
  if (!allowRemote && !isLoopbackHost(requestHost)) {
    throw new HttpRequestError(403, "untrusted Host header", "UNTRUSTED_HOST");
  }

  const origin = req.headers.origin;
  if (origin) {
    const originHost = originHostName(origin);
    const trustedOrigin = isLoopbackHost(boundHost)
      ? isLoopbackHost(originHost)
      : allowRemote && requestHost === originHost;
    if (!trustedOrigin) {
      throw new HttpRequestError(403, "cross-origin API request rejected", "UNTRUSTED_ORIGIN");
    }
  }

  if (!url.pathname.startsWith("/api/") || !unsafeMethods.has(req.method || "")) return;
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpRequestError(415, "API write requests require application/json", "UNSUPPORTED_CONTENT_TYPE");
  }
}

export function setSecurityHeaders(res, requestId) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "no-store");
  if (requestId) res.setHeader("x-request-id", requestId);
}

export function isLoopbackHost(value) {
  const host = normalizeHost(value);
  if (host === "localhost" || host === "::1") return true;
  if (net.isIP(host) === 4) {
    return host.startsWith("127.");
  }
  return false;
}

function normalizeHost(value) {
  return String(value || "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function hostNameFromHeader(value) {
  const header = String(value || "");
  if (!header) return "";
  try {
    return new URL(`http://${header}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function originHostName(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase();
  } catch {
    throw new HttpRequestError(403, "invalid Origin header", "INVALID_ORIGIN");
  }
}
