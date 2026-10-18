import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";
import { auth as oidcAuth } from "express-openid-connect";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from "jose";

export const PUBLIC_SCOPES = Object.freeze(["workforce:read", "workforce:write"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SESSION_NAME = "__Host-workforce_session";
const CSRF_KEY = "workforceCsrf";

// Error messages deliberately contain no tokens, provider replies or configuration values.
export class PublicAuthError extends Error {
  constructor(code, status = 401) {
    const messages = {
      unauthenticated: "请先登录后再使用此功能。",
      invalid_token: "登录凭据无效或已过期，请重新登录。",
      insufficient_scope: "当前登录授权范围不足。",
      csrf_failed: "请求验证失败，请刷新页面后重试。",
    };
    super(messages[code] || messages.invalid_token);
    this.name = "PublicAuthError";
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function required(env, key) {
  const value = env[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`公开稳定版缺少配置：${key}`);
  }
  return value.trim();
}

function configuredOrigin(value, key) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${key} 必须是有效的 HTTPS 根地址`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${key} 必须是有效的 HTTPS 根地址`);
  }
  return parsed.origin;
}

/** Fail closed, including in local development: the public release always needs HTTPS. */
export function loadPublicConfig(env = process.env) {
  const origin = configuredOrigin(required(env, "PUBLIC_ORIGIN"), "PUBLIC_ORIGIN");
  const issuer = `${configuredOrigin(required(env, "AUTH0_ISSUER_BASE_URL"), "AUTH0_ISSUER_BASE_URL")}/`;
  const sessionSecret = required(env, "SESSION_SECRET");
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("SESSION_SECRET 至少需要 32 字节的随机密钥");
  }
  const audience = String(env.AUTH0_AUDIENCE || `${origin}/mcp`).trim();
  // Auth0 identifiers need not be URLs, but must not introduce control characters into headers.
  if (!audience || audience.length > 1024 || /[\u0000-\u0020\u007f]/u.test(audience)) {
    throw new Error("AUTH0_AUDIENCE 必须是有效的 API 标识符");
  }
  const adminSubjects = Object.freeze([...new Set(String(env.ADMIN_SUBJECTS || "")
    .split(/[\n,]/u).map((part) => part.trim()).filter(Boolean))]);
  if (adminSubjects.some((subject) => subject.length > 512 || /[\u0000-\u001f\u007f]/u.test(subject))) {
    throw new Error("ADMIN_SUBJECTS 必须是已验证用户的原始 sub 列表");
  }
  return Object.freeze({
    origin,
    issuer,
    clientId: required(env, "AUTH0_CLIENT_ID"),
    clientSecret: required(env, "AUTH0_CLIENT_SECRET"),
    sessionSecret,
    databaseUrl: required(env, "DATABASE_URL"),
    audience,
    adminSubjects,
    resourceUrl: `${origin}/mcp`,
    metadataUrl: `${origin}/.well-known/oauth-protected-resource`,
    isProduction: env.NODE_ENV === "production",
  });
}

function safeDisplayName(claims) {
  const name = [claims.name, claims.nickname].find((value) => typeof value === "string" && value.trim());
  return name ? name.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 128) : "已登录用户";
}

/** Only pass claims verified by this module's JWT verifier or by the OIDC SDK. */
export function principalFromClaims(verifiedClaims, config) {
  const claims = verifiedClaims || {};
  if (claims.iss !== config.issuer || typeof claims.sub !== "string" ||
      !claims.sub.trim() || claims.sub !== claims.sub.trim() || claims.sub.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(claims.sub)) {
    throw new PublicAuthError("invalid_token");
  }
  const scopes = typeof claims.scope === "string"
    ? [...new Set(claims.scope.split(/\s+/u).filter((scope) => PUBLIC_SCOPES.includes(scope)))]
    : [];
  return Object.freeze({
    id: createHash("sha256").update(`${config.issuer}|${claims.sub}`, "utf8").digest("hex"),
    subject: claims.sub,
    displayName: safeDisplayName(claims),
    isAdmin: config.adminSubjects.includes(claims.sub),
    scopes: Object.freeze(scopes),
  });
}

export function requirePrincipal(principal, requiredScopes = []) {
  if (!principal) throw new PublicAuthError("unauthenticated");
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
  if (scopes.some((scope) => !principal.scopes.includes(scope))) {
    throw new PublicAuthError("insufficient_scope", 403);
  }
  return principal;
}

export function protectedResourceMetadata(config) {
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.issuer],
    scopes_supported: [...PUBLIC_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "工程劳动力测算",
  };
}

export function oauthChallenge(config, reason) {
  const code = typeof reason === "string" ? reason : reason?.code;
  const error = code === "insufficient_scope" ? "insufficient_scope" : "invalid_token";
  const description = error === "insufficient_scope"
    ? "The required workforce access scope was not granted."
    : "Sign in to access your workforce library and personal plans.";
  return `Bearer resource_metadata="${config.metadataUrl}", scope="${PUBLIC_SCOPES.join(" ")}", error="${error}", error_description="${description}"`;
}

function authorizationHeader(req) {
  const headers = req.headers || {};
  const header = headers.authorization;
  if (header === undefined) return null;
  const count = (req.rawHeaders || []).filter((value, index) => index % 2 === 0 &&
    String(value).toLowerCase() === "authorization").length;
  if (typeof header !== "string" || count > 1 || header.length > 16384) {
    throw new PublicAuthError("invalid_token");
  }
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu.exec(header);
  if (!match) throw new PublicAuthError("invalid_token");
  return match[1];
}

function matchingCsrf(token, expected) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/u.test(token) &&
    timingSafeEqual(Buffer.from(token, "ascii"), Buffer.from(expected, "ascii"));
}

/**
 * opts.oidcFactory / opts.jwtKeySet are dependency injection for offline tests, never env switches.
 * Configure Express trust proxy for the deployment's one trusted TLS terminator before mounting.
 */
export function createPublicAuth(config, opts = {}) {
  const router = express.Router();
  const verifiedSessions = new WeakMap();
  const bearerCache = new WeakMap();
  const keySet = opts.jwtKeySet || createRemoteJWKSet(new URL(".well-known/jwks.json", config.issuer), {
    timeoutDuration: 5000,
    cooldownDuration: 30000,
    cacheMaxAge: 600000,
  });
  const authMiddleware = (opts.oidcFactory || oidcAuth)({
    authRequired: false,
    attemptSilentLogin: false,
    baseURL: config.origin,
    issuerBaseURL: config.issuer.slice(0, -1),
    clientID: config.clientId,
    clientSecret: config.clientSecret,
    clientAuthMethod: "client_secret_basic",
    secret: config.sessionSecret,
    idTokenSigningAlg: "RS256",
    clockTolerance: 5,
    enableTelemetry: false,
    auth0Logout: false,
    idpLogout: false,
    legacySameSiteCookie: false,
    authorizationParams: { response_type: "code", response_mode: "query", scope: "openid profile email" },
    // Both login and the signed transaction state always return to this application's root.
    getLoginState: () => ({ returnTo: config.origin }),
    afterCallback: async (_req, _res, session) => ({ ...session, [CSRF_KEY]: randomBytes(32).toString("base64url") }),
    routes: { login: "/login", callback: "/callback", logout: false, postLogoutRedirect: config.origin },
    session: {
      name: SESSION_NAME,
      rolling: true,
      rollingDuration: 8 * 60 * 60,
      absoluteDuration: 24 * 60 * 60,
      cookie: { httpOnly: true, secure: true, sameSite: "Lax", path: "/" },
    },
    transactionCookie: { name: "__Host-workforce_oidc", sameSite: "Lax" },
  });
  router.use(authMiddleware);
  router.use((req, _res, next) => {
    try {
      if (req.oidc?.isAuthenticated() && req[SESSION_NAME]) {
        const claims = req.oidc.idTokenClaims;
        // The SDK validated signature, issuer, client audience, state and PKCE at callback.
        // Website session permissions are application policy, not arbitrary role/email claims.
        const principal = principalFromClaims({ ...claims, scope: PUBLIC_SCOPES.join(" ") }, config);
        const session = req[SESSION_NAME];
        if (typeof session[CSRF_KEY] !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(session[CSRF_KEY])) {
          session[CSRF_KEY] = randomBytes(32).toString("base64url");
        }
        verifiedSessions.set(req, { principal, token: session[CSRF_KEY] });
      }
      next();
    } catch {
      next(new PublicAuthError("invalid_token"));
    }
  });

  async function resolvePrincipal(req, { allowSession = true } = {}) {
    // A supplied, invalid Bearer token must never fall back to a valid cookie.
    const token = authorizationHeader(req);
    if (token !== null) {
      if (bearerCache.has(req)) return bearerCache.get(req);
      const verifying = (async () => {
        try {
          const header = decodeProtectedHeader(token);
          if (header.alg !== "RS256" || ["jku", "jwk", "x5u", "x5c"].some((key) => key in header)) {
            throw new PublicAuthError("invalid_token");
          }
          const { payload } = await jwtVerify(token, keySet, {
            algorithms: ["RS256"],
            issuer: config.issuer,
            audience: config.audience,
            requiredClaims: ["iss", "aud", "sub", "exp", "iat"],
            clockTolerance: 5,
          });
          return principalFromClaims(payload, config);
        } catch {
          throw new PublicAuthError("invalid_token");
        }
      })();
      bearerCache.set(req, verifying);
      return verifying;
    }
    return allowSession ? verifiedSessions.get(req)?.principal || null : null;
  }

  function csrfToken(req) {
    return verifiedSessions.get(req)?.token || null;
  }

  async function csrfGuard(req, _res, next) {
    try {
      if (SAFE_METHODS.has(String(req.method || "").toUpperCase())) return next();
      // This is safe only after actually validating a non-cookie credential, not merely its presence.
      if (authorizationHeader(req) !== null) {
        requirePrincipal(await resolvePrincipal(req, { allowSession: false }));
        return next();
      }
      const session = verifiedSessions.get(req);
      requirePrincipal(session?.principal);
      const token = req.headers?.["x-csrf-token"];
      if (req.headers?.origin !== config.origin || !matchingCsrf(token, session.token)) {
        throw new PublicAuthError("csrf_failed", 403);
      }
      return next();
    } catch (error) { return next(error); }
  }

  // Local logout only: cookie clearing is handled by the SDK's session middleware on headers.
  // It intentionally cannot accept a returnTo from query/body or log the user out via GET.
  function logoutHandler(req, res, next) {
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").json({ error: "仅支持 POST 退出登录" });
    // Logout must authenticate the cookie and CSRF even if an unrelated Bearer is also supplied.
    const session = verifiedSessions.get(req);
    const token = req.headers?.["x-csrf-token"];
    if (!session || req.headers?.origin !== config.origin || !matchingCsrf(token, session.token)) {
      return next(new PublicAuthError("csrf_failed", 403));
    }
    req[SESSION_NAME] = undefined;
    verifiedSessions.delete(req);
    res.set("Cache-Control", "no-store").status(204).end();
  }
  router.all(["/logout", "/auth/logout"], logoutHandler);

  return Object.freeze({ websiteMiddleware: router, resolvePrincipal, csrfGuard, csrfToken, logoutHandler });
}
