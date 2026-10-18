import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import express from "express";
import { auth as actualOidcAuth } from "express-openid-connect";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createPublicAuth, loadPublicConfig, oauthChallenge, principalFromClaims,
  protectedResourceMetadata, PUBLIC_SCOPES, requirePrincipal,
} from "../src/public-auth.js";

const env = {
  NODE_ENV: "production",
  PUBLIC_ORIGIN: "https://workforce.example",
  AUTH0_ISSUER_BASE_URL: "https://workforce-test.auth0.com",
  AUTH0_CLIENT_ID: "test-website-client",
  AUTH0_CLIENT_SECRET: "not-a-real-provider-secret",
  SESSION_SECRET: "test-only-session-secret-with-at-least-32-bytes",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  ADMIN_SUBJECTS: "auth0|admin",
};
const config = loadPublicConfig(env);
const keys = await generateKeyPair("RS256");
const jwk = await exportJWK(keys.publicKey);
const keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
const csrf = "A".repeat(43);

async function signedToken({ claims = {}, header = {}, issuer = config.issuer,
  audience = config.audience, subject = "auth0|alice", expiration = "5m", noExpiration = false,
  privateKey = keys.privateKey } = {}) {
  let jwt = new SignJWT({ scope: PUBLIC_SCOPES.join(" "), ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key", ...header })
    .setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt();
  if (!noExpiration) jwt = jwt.setExpirationTime(expiration);
  return jwt.sign(privateKey);
}

function bearerRequest(token, extra = {}) {
  return { method: "POST", headers: { authorization: `Bearer ${token}`, ...extra } };
}

// Only a code-injected SDK test double establishes this fixture session. There is no
// environment flag, header, query or body parameter that enables it in production.
function sessionFactory(subject = "auth0|alice", capture) {
  return (options) => {
    if (capture) capture(options);
    return (req, res, next) => {
      req[options.session.name] = { ["workforceCsrf"]: csrf };
      req.oidc = {
        isAuthenticated: () => true,
        idTokenClaims: { iss: config.issuer, sub: subject, name: "Test user", email: "admin@example.com", roles: ["admin"] },
      };
      res.oidc = { logout: () => { throw new Error("Must not use GET SDK logout"); } };
      next();
    };
  };
}

async function fixture(t, { sessionSubject, capture, oidcFactory } = {}) {
  const auth = createPublicAuth(config, {
    jwtKeySet: keySet,
    ...(sessionSubject ? { oidcFactory: sessionFactory(sessionSubject, capture) } : {}),
    ...(oidcFactory ? { oidcFactory } : {}),
  });
  const app = express();
  app.use(express.json());
  app.use(auth.websiteMiddleware);
  app.get("/session", async (req, res, next) => {
    try {
      const principal = await auth.resolvePrincipal(req);
      res.json({ principal, csrfToken: auth.csrfToken(req) });
    } catch (error) { next(error); }
  });
  app.post("/write", auth.csrfGuard, async (req, res, next) => {
    try {
      const principal = requirePrincipal(await auth.resolvePrincipal(req), PUBLIC_SCOPES);
      res.json({ id: principal.id, isAdmin: principal.isAdmin });
    } catch (error) { next(error); }
  });
  app.get("/mcp-principal", async (req, res, next) => {
    try {
      res.json({ principal: await auth.resolvePrincipal(req, { allowSession: false }) });
    } catch (error) { next(error); }
  });
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ code: error.code || "internal_error", message: error.message });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { auth, url: `http://127.0.0.1:${server.address().port}` };
}

test("public configuration fails closed on every required field", () => {
  for (const key of ["PUBLIC_ORIGIN", "AUTH0_ISSUER_BASE_URL", "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET", "SESSION_SECRET", "DATABASE_URL"]) {
    const copy = { ...env };
    delete copy[key];
    assert.throws(() => loadPublicConfig(copy), new RegExp(key));
  }
  assert.throws(() => loadPublicConfig({ ...env, SESSION_SECRET: "test-short" }), /SESSION_SECRET/u);
  assert.equal(config.issuer, "https://workforce-test.auth0.com/");
  assert.equal(config.audience, "https://workforce.example/mcp");
  assert.ok(Object.isFrozen(config));
});

test("only credential-free HTTPS root origins and trusted issuer roots are accepted", () => {
  for (const value of ["http://example.com", "http://localhost:3000", "https://user:pass@example.com",
    "https://example.com/path", "https://example.com/?query=1", "https://example.com/#hash", "not a URL"]) {
    assert.throws(() => loadPublicConfig({ ...env, PUBLIC_ORIGIN: value }), /PUBLIC_ORIGIN/u);
    assert.throws(() => loadPublicConfig({ ...env, AUTH0_ISSUER_BASE_URL: value }), /AUTH0_ISSUER_BASE_URL/u);
  }
  assert.throws(() => loadPublicConfig({ ...env, AUTH0_AUDIENCE: "value\r\nX-Injected: true" }), /AUTH0_AUDIENCE/u);
  assert.equal(loadPublicConfig({ ...env, AUTH0_AUDIENCE: "urn:workforce-api" }).audience, "urn:workforce-api");
});

test("principal ids are issuer-and-subject derived; untrusted role/email/id claims do not grant admin", () => {
  const claims = { iss: config.issuer, sub: "auth0|alice", email: "admin@example.com", roles: ["admin"],
    isAdmin: true, ownerId: "forged", userId: "forged", scope: PUBLIC_SCOPES.join(" ") };
  const alice = principalFromClaims(claims, config);
  assert.equal(alice.id, createHash("sha256").update(`${config.issuer}|auth0|alice`).digest("hex"));
  assert.equal(alice.isAdmin, false);
  assert.notEqual(alice.id, principalFromClaims({ ...claims, sub: "auth0|bob" }, config).id);
  assert.notEqual(alice.id, principalFromClaims({ ...claims, iss: "https://another.example/" },
    { ...config, issuer: "https://another.example/" }).id);
  assert.equal(principalFromClaims({ ...claims, sub: "auth0|admin" }, config).isAdmin, true);
  assert.throws(() => principalFromClaims({ ...claims, iss: "https://forged.example/" }, config));
  assert.throws(() => principalFromClaims({ ...claims, sub: "" }, config));
  assert.equal(principalFromClaims({ ...claims, permissions: PUBLIC_SCOPES, scope: undefined }, config).scopes.length, 0);
});

test("valid RS256 access JWT is verified using fixed audience and issuer", async () => {
  const auth = createPublicAuth(config, { jwtKeySet: keySet });
  const token = await signedToken();
  const principal = await auth.resolvePrincipal(bearerRequest(token), { allowSession: false });
  assert.equal(principal.subject, "auth0|alice");
  assert.deepEqual(principal.scopes, PUBLIC_SCOPES);
  assert.equal(principal.isAdmin, false);
});

test("expired, missing-exp, wrong-audience, wrong-issuer, wrong-signature and unsecured JWTs are rejected", async () => {
  const auth = createPublicAuth(config, { jwtKeySet: keySet });
  const otherKey = await generateKeyPair("RS256");
  const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.` +
    `${Buffer.from(JSON.stringify({ iss: config.issuer, sub: "auth0|admin", aud: config.audience,
      exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.`;
  for (const token of [await signedToken({ expiration: "-1m" }),
    await signedToken({ noExpiration: true }), await signedToken({ audience: "https://other.example/api" }),
    await signedToken({ issuer: "https://other-tenant.auth0.com/" }),
    await signedToken({ privateKey: otherKey.privateKey }), none]) {
    await assert.rejects(() => auth.resolvePrincipal(bearerRequest(token)), { code: "invalid_token", status: 401 });
  }
  const symmetric = await new SignJWT({ sub: "auth0|admin", scope: PUBLIC_SCOPES.join(" ") })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(config.issuer).setAudience(config.audience)
    .setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode("test-symmetric-secret-at-least-32-bytes"));
  await assert.rejects(() => auth.resolvePrincipal(bearerRequest(symmetric)), { code: "invalid_token" });
});

test("signed tokens cannot redirect key lookup using jku, jwk, x5u or x5c headers", async () => {
  const auth = createPublicAuth(config, { jwtKeySet: keySet });
  for (const header of [{ jku: "https://attacker.example/jwks" }, { jwk },
    { x5u: "https://attacker.example/cert" }, { x5c: ["fake"] }]) {
    const token = await signedToken({ header });
    await assert.rejects(() => auth.resolvePrincipal(bearerRequest(token)),
      { code: "invalid_token" });
  }
});

test("body owner ids, arbitrary identity headers, query access tokens and manually attached oidc do not authenticate", async () => {
  const auth = createPublicAuth(config, { jwtKeySet: keySet });
  const req = { headers: { "x-user-id": "auth0|admin", "x-owner-id": "forged", "x-admin": "true" },
    body: { ownerId: "auth0|admin", userId: "auth0|admin", isAdmin: true },
    query: { access_token: await signedToken() },
    oidc: { isAuthenticated: () => true, idTokenClaims: { iss: config.issuer, sub: "auth0|admin" } } };
  assert.equal(await auth.resolvePrincipal(req), null);
  assert.equal(auth.csrfToken(req), null);
});

test("malformed or repeated Authorization headers fail instead of selecting a credential", async () => {
  const auth = createPublicAuth(config, { jwtKeySet: keySet });
  const good = `Bearer ${await signedToken()}`;
  for (const value of ["Basic secret", "Bearer invalid", `${good}, ${good}`, [good, good], ""]) {
    await assert.rejects(() => auth.resolvePrincipal({ headers: { authorization: value } }), { code: "invalid_token" });
  }
  await assert.rejects(() => auth.resolvePrincipal({ headers: { authorization: good },
    rawHeaders: ["Authorization", good, "authorization", good] }), { code: "invalid_token" });
});

test("scope enforcement is independent of admin status and rejects permissions-role substitutions", async () => {
  const auth = createPublicAuth(config, { jwtKeySet: keySet });
  const principal = await auth.resolvePrincipal(bearerRequest(await signedToken({
    subject: "auth0|admin", claims: { scope: "workforce:read", permissions: ["workforce:write"] },
  })));
  assert.equal(principal.isAdmin, true);
  requirePrincipal(principal, ["workforce:read"]);
  assert.throws(() => requirePrincipal(principal, PUBLIC_SCOPES), { code: "insufficient_scope", status: 403 });
  assert.throws(() => requirePrincipal(null), { code: "unauthenticated", status: 401 });
});

test("website uses Auth Code + PKCE-capable SDK, encrypted secure cookie and fixed return destination", async (t) => {
  let captured;
  const { url } = await fixture(t, { sessionSubject: "auth0|alice", capture: (options) => { captured = options; } });
  const response = await fetch(`${url}/session?returnTo=https://attacker.example`);
  const result = await response.json();
  assert.equal(result.principal.subject, "auth0|alice");
  assert.equal(result.principal.isAdmin, false);
  assert.deepEqual(result.principal.scopes, PUBLIC_SCOPES);
  assert.equal(result.csrfToken, csrf);
  assert.equal(captured.authRequired, false);
  assert.equal(captured.authorizationParams.response_type, "code");
  assert.equal(captured.authorizationParams.response_mode, "query");
  assert.equal(captured.idTokenSigningAlg, "RS256");
  assert.equal(captured.routes.logout, false);
  assert.deepEqual(captured.getLoginState({}, { returnTo: "https://attacker.example" }), { returnTo: config.origin });
  assert.deepEqual(captured.session.cookie, { httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
  const first = await captured.afterCallback({}, {}, { id_token: "verified-test-session" });
  const second = await captured.afterCallback({}, {}, { id_token: "verified-test-session" });
  assert.match(first.workforceCsrf, /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(first.workforceCsrf, second.workforceCsrf);
});

test("real SDK on Express 5 accepts anonymous reads without contacting an Auth0 account", async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/session`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { principal: null, csrfToken: null });
  const tampered = await fetch(`${url}/session`, { headers: { Cookie: "__Host-workforce_session=not-a-valid-encrypted-cookie" } });
  assert.deepEqual(await tampered.json(), { principal: null, csrfToken: null });
});

test("real SDK generates S256 PKCE, nonce/state and Secure HttpOnly Lax transaction cookie", async (t) => {
  let discoveryCalls = 0;
  const { url } = await fixture(t, {
    oidcFactory: (options) => actualOidcAuth({
      ...options,
      customFetch: async (input) => {
        assert.equal(String(input), `${config.issuer}.well-known/openid-configuration`);
        discoveryCalls += 1;
        return new Response(JSON.stringify({
          issuer: config.issuer,
          authorization_endpoint: `${config.issuer}authorize`,
          token_endpoint: `${config.issuer}oauth/token`,
          jwks_uri: `${config.issuer}.well-known/jwks.json`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        }), { headers: { "Content-Type": "application/json" } });
      },
    }),
  });
  const response = await fetch(`${url}/login?returnTo=https://attacker.example`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(discoveryCalls, 1);
  const destination = new URL(response.headers.get("location"));
  assert.equal(destination.origin, new URL(config.issuer).origin);
  assert.equal(destination.pathname, "/authorize");
  assert.equal(destination.searchParams.get("response_type"), "code");
  assert.equal(destination.searchParams.get("code_challenge_method"), "S256");
  assert.match(destination.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/u);
  assert.ok(destination.searchParams.get("nonce"));
  assert.ok(destination.searchParams.get("state"));
  assert.equal(destination.searchParams.get("redirect_uri"), `${config.origin}/callback`);
  assert.equal(destination.searchParams.has("code_verifier"), false);
  assert.equal(response.headers.get("location").includes(config.clientSecret), false);
  const transaction = response.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-workforce_oidc="));
  assert.ok(transaction);
  assert.match(transaction, /; Secure/u);
  assert.match(transaction, /; HttpOnly/u);
  assert.match(transaction, /; SameSite=Lax/u);
  assert.match(transaction, /; Path=\//u);
  assert.doesNotMatch(transaction, /; Domain=/u);
});

test("MCP cannot authenticate through website session cookies", async (t) => {
  const { url } = await fixture(t, { sessionSubject: "auth0|alice" });
  const response = await fetch(`${url}/mcp-principal`);
  assert.deepEqual(await response.json(), { principal: null });
});

test("invalid Bearer token does not fall back to a valid authenticated website session", async (t) => {
  const { url } = await fixture(t, { sessionSubject: "auth0|admin" });
  const response = await fetch(`${url}/session`, { headers: { Authorization: "Bearer broken" } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "invalid_token");
});

test("valid Bearer takes precedence over a different cookie identity and ignores supplied owner ids", async (t) => {
  const { url } = await fixture(t, { sessionSubject: "auth0|admin" });
  const token = await signedToken({ subject: "auth0|bob" });
  const response = await fetch(`${url}/write`, { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-user-id": "auth0|admin",
  }, body: JSON.stringify({ ownerId: "auth0|admin" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: principalFromClaims({ iss: config.issuer, sub: "auth0|bob" }, config).id, isAdmin: false,
  });
});

test("cookie writes need both exact Origin and session-bound CSRF token", async (t) => {
  const { url } = await fixture(t, { sessionSubject: "auth0|alice" });
  for (const headers of [{}, { Origin: config.origin }, { "x-csrf-token": csrf },
    { Origin: "https://attacker.example", "x-csrf-token": csrf },
    { Origin: `${config.origin}/`, "x-csrf-token": csrf },
    { Origin: config.origin, "x-csrf-token": "B".repeat(43) },
    { Origin: config.origin, "x-csrf-token": "é".repeat(43) }]) {
    const response = await fetch(`${url}/write`, { method: "POST", headers });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "csrf_failed");
  }
  const response = await fetch(`${url}/write`, { method: "POST", headers: {
    Origin: config.origin, "x-csrf-token": csrf,
  } });
  assert.equal(response.status, 200);
});

test("forged Bearer cannot bypass CSRF guard and anonymous writes remain blocked", async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/write`, { method: "POST", headers: {
    Origin: config.origin, "x-csrf-token": csrf, "x-user-id": "auth0|admin",
  } });
  assert.equal(response.status, 401);
  const forged = await fetch(`${url}/write`, { method: "POST", headers: { Authorization: "Bearer forged" } });
  assert.equal(forged.status, 401);
});

test("logout is POST + CSRF only and does not redirect to user-controlled returnTo", async (t) => {
  const { url } = await fixture(t, { sessionSubject: "auth0|alice" });
  const get = await fetch(`${url}/logout?returnTo=https://attacker.example`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  const forged = await fetch(`${url}/auth/logout`, { method: "POST" });
  assert.equal(forged.status, 403);
  const bearerOnly = await fetch(`${url}/auth/logout`, { method: "POST", headers: {
    Authorization: `Bearer ${await signedToken()}`,
  } });
  assert.equal(bearerOnly.status, 403);
  const success = await fetch(`${url}/auth/logout?returnTo=https://attacker.example`, { method: "POST", headers: {
    Origin: config.origin, "x-csrf-token": csrf,
  } });
  assert.equal(success.status, 204);
  assert.equal(success.headers.get("location"), null);
  assert.equal(success.headers.get("cache-control"), "no-store");
});

test("OAuth challenge and resource metadata disclose only public configuration", () => {
  const metadata = protectedResourceMetadata(config);
  assert.deepEqual(metadata.authorization_servers, [config.issuer]);
  assert.deepEqual(metadata.scopes_supported, PUBLIC_SCOPES);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
  assert.equal(metadata.resource, `${config.origin}/mcp`);
  assert.match(oauthChallenge(config), /resource_metadata="https:\/\/workforce.example\/\.well-known\/oauth-protected-resource"/u);
  assert.match(oauthChallenge(config, "invalid_token"), /error="invalid_token"/u);
  assert.match(oauthChallenge(config, "insufficient_scope"), /error="insufficient_scope"/u);
  assert.doesNotMatch(oauthChallenge(config, "secret\r\nvalue"), /secret/u);
  const output = JSON.stringify(metadata) + oauthChallenge(config);
  for (const secret of [config.clientSecret, config.sessionSecret, config.databaseUrl]) {
    assert.equal(output.includes(secret), false);
  }
});
