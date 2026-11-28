// OAuth 2.1 sign-in for AI agents: discovery, self-registration, the "Allow" page, tokens and revoke.
// Public clients with PKCE only. Mounted at the root, before the app's CORS list, only when MCP is on.
const express = require('express');
const rateLimit = require('express-rate-limit');
const access = require('../services/agentAccess');
const { validRedirect, validChallenge } = require('../utils/agentRules');
const { signInPage, messagePage } = require('../utils/agentPages');

const limit = (max, extra = {}) => rateLimit({
  windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'temporarily_unavailable', error_description: 'Too many requests. Try again in a few minutes.' }, ...extra,
});

/** Tokens travel in headers, never cookies, so any web page may call these. The sign-in page is not one of them. */
function openCors(req, res, next) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

const fail = (res, error, description, status = 400) => res.status(status).json({ error, error_description: description });

module.exports = function agentOAuth(config) {
  const router = express.Router();
  const { base } = config;
  const resource = `${base}/mcp`;
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const json = express.json({ limit: '20kb' });

  router.use(['/.well-known', '/oauth/register', '/oauth/token', '/oauth/revoke'], openCors);

  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => res.json({
    resource, authorization_servers: [base], scopes_supported: ['todos:read'], bearer_methods_supported: ['header'], resource_name: 'TaskHub to-dos',
  }));

  router.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['todos:read'],
    authorization_response_iss_parameter_supported: true,
  }));

  router.post('/oauth/register', limit(30), json, async (req, res, next) => {
    try {
      const uris = req.body?.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || uris.length > 5 || !uris.every(validRedirect)) {
        return fail(res, 'invalid_redirect_uri', 'Give 1 to 5 https, localhost or desktop-app redirect addresses.');
      }
      const name = String(req.body.client_name || 'AI agent').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'AI agent';
      const id = await access.registerClient(name, uris);
      return res.status(201).json({
        client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'todos:read',
      });
    } catch (err) {
      return next(err);
    }
  });

  // ---- the sign-in page ----------------------------------------------------
  const page = (res, status, html) => res.status(status).set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin', // "no-referrer" would blank the Origin header the form is checked by
    'Cross-Origin-Opener-Policy': 'unsafe-none', // agents open this in a popup and listen for it to come back
  }).type('html').send(html);

  /** The request an agent made, checked. A bad agent or address is shown here; other mistakes go back to the agent. */
  async function readRequest(res, source) {
    const p = {};
    for (const k of ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope']) {
      if (typeof source?.[k] === 'string' && source[k].length <= 1000) p[k] = source[k];
    }
    const client = await access.clientFor(p.client_id, p.redirect_uri);
    if (!client) {
      page(res, 400, messagePage('This agent could not be recognised. Remove the TaskHub connection in your AI app and add it again.'));
      return null;
    }
    const bad = (p.response_type !== 'code' && 'unsupported_response_type')
      || ((p.code_challenge_method !== 'S256' || !validChallenge(p.code_challenge)) && 'invalid_request')
      || (p.resource && ![resource, base].includes(p.resource.replace(/\/+$/, '')) && 'invalid_target');
    if (bad) {
      back(res, p, { error: bad });
      return null;
    }
    return { p, client };
  }

  function back(res, p, answer) {
    const url = new URL(p.redirect_uri);
    for (const [k, v] of Object.entries({ ...answer, ...(p.state ? { state: p.state } : {}), iss: base })) url.searchParams.set(k, v);
    res.set({ 'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'unsafe-none' }).redirect(302, url.href);
  }

  router.get('/oauth/authorize', limit(100), async (req, res, next) => {
    try {
      const ok = await readRequest(res, req.query);
      if (ok) page(res, 200, signInPage({ params: ok.p, clientName: ok.client.name }));
    } catch (err) {
      next(err);
    }
  });

  // Only failed sign-ins count: ten per address, and ten per username wherever they come from.
  const byAddress = limit(10, { skipSuccessfulRequests: true, skip: (req) => req.body?.action === 'deny' });
  const byName = limit(10, {
    skipSuccessfulRequests: true,
    skip: (req) => req.body?.action === 'deny',
    keyGenerator: (req) => `name:${String(req.body?.username || '').trim().toLowerCase().slice(0, 255)}`,
  });

  router.post('/oauth/authorize', form, byAddress, byName, async (req, res, next) => {
    try {
      // The form must come from this page, not from another site posting it.
      const origin = req.get('origin');
      if (origin && origin !== base) return page(res, 403, messagePage('This sign-in did not come from TaskHub.'));
      const ok = await readRequest(res, req.body);
      if (!ok) return undefined;
      if (req.body.action === 'deny') return back(res, ok.p, { error: 'access_denied' });
      const who = await access.checkPassword(config, req.body.username, req.body.password);
      if (who.error) return page(res, 401, signInPage({ params: ok.p, clientName: ok.client.name, error: who.error }));
      const code = await access.createCode({ clientId: ok.client.id, userId: who.user.id, redirectUri: ok.p.redirect_uri, challenge: ok.p.code_challenge });
      return back(res, ok.p, { code });
    } catch (err) {
      return next(err);
    }
  });

  // ---- tokens --------------------------------------------------------------
  router.post('/oauth/token', limit(300), form, json, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const b = req.body || {};
      let tokens;
      if (b.grant_type === 'authorization_code') {
        tokens = await access.exchangeCode({ code: b.code, clientId: b.client_id, redirectUri: b.redirect_uri, verifier: b.code_verifier });
      } else if (b.grant_type === 'refresh_token') {
        tokens = await access.refreshTokens({ refreshToken: b.refresh_token, clientId: b.client_id });
      } else {
        return fail(res, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
      }
      return tokens ? res.json(tokens) : fail(res, 'invalid_grant', 'The sign-in is no longer valid. Connect again.');
    } catch (err) {
      return next(err);
    }
  });

  router.post('/oauth/revoke', limit(100), form, json, async (req, res, next) => {
    try {
      await access.revokeToken(req.body?.token, req.body?.client_id);
      res.status(200).json({});
    } catch (err) {
      next(err);
    }
  });

  return router;
};
module.exports.openCors = openCors;
