import assert from "node:assert/strict";
import test from "node:test";

import {
  HttpRequestError,
  assertSafeHostBinding,
  assertTrustedRequest,
  isLoopbackHost
} from "./http-security.js";

function request({ method = "GET", host = "127.0.0.1:4173", origin, contentType } = {}) {
  return {
    method,
    headers: {
      host,
      ...(origin ? { origin } : {}),
      ...(contentType ? { "content-type": contentType } : {})
    }
  };
}

test("loopback bindings are accepted and remote bindings fail closed", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("127.2.3.4"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.doesNotThrow(() => assertSafeHostBinding("127.0.0.1"));
  assert.throws(() => assertSafeHostBinding("0.0.0.0"), /Refusing to listen/);
  assert.doesNotThrow(() => assertSafeHostBinding("0.0.0.0", true));
});

test("local API accepts the Vite loopback origin and rejects cross-site requests", () => {
  const url = new URL("http://127.0.0.1:4173/api/document");
  assert.doesNotThrow(() =>
    assertTrustedRequest(
      request({
        method: "PUT",
        origin: "http://127.0.0.1:5173",
        contentType: "application/json; charset=utf-8"
      }),
      url,
      { boundHost: "127.0.0.1" }
    )
  );

  assert.throws(
    () =>
      assertTrustedRequest(
        request({
          method: "PUT",
          origin: "https://example.invalid",
          contentType: "application/json"
        }),
        url,
        { boundHost: "127.0.0.1" }
      ),
    (error) => error instanceof HttpRequestError && error.statusCode === 403
  );
});

test("API mutations require JSON and local requests reject DNS rebinding hosts", () => {
  const url = new URL("http://127.0.0.1:4173/api/threads");
  assert.throws(
    () => assertTrustedRequest(request({ method: "POST", contentType: "text/plain" }), url, { boundHost: "127.0.0.1" }),
    (error) => error instanceof HttpRequestError && error.statusCode === 415
  );
  assert.throws(
    () =>
      assertTrustedRequest(
        request({
          method: "POST",
          host: "attacker.invalid",
          contentType: "application/json"
        }),
        url,
        { boundHost: "127.0.0.1" }
      ),
    (error) => error instanceof HttpRequestError && error.code === "UNTRUSTED_HOST"
  );
});
