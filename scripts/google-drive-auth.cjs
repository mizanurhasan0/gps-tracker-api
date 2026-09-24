#!/usr/bin/env node
'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { existsSync } = require('node:fs');
const { createServer } = require('node:http');

if (existsSync('.env')) process.loadEnvFile('.env');
const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || '';
if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret) {
  process.stderr.write(
    'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Desktop OAuth client.\n',
  );
  process.exit(1);
}

const state = randomBytes(24).toString('base64url');
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
let finished = false;

const server = createServer(async (request, response) => {
  if (finished || !request.url) {
    response.writeHead(404).end();
    return;
  }
  const callback = new URL(request.url, 'http://127.0.0.1');
  if (callback.pathname !== '/oauth2callback') {
    response.writeHead(404).end();
    return;
  }
  finished = true;
  try {
    if (callback.searchParams.get('state') !== state)
      throw new Error('OAuth state check failed');
    const providerError = callback.searchParams.get('error');
    if (providerError) throw new Error(`Google authorization failed: ${providerError}`);
    const code = callback.searchParams.get('code');
    if (!code) throw new Error('Google did not return an authorization code');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OAuth callback is unavailable');
    const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || typeof token.refresh_token !== 'string')
      throw new Error(
        `Token exchange failed (${tokenResponse.status}). Revoke the old grant and retry with consent.`,
      );
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Authorization complete. Return to the private terminal.\n');
    process.stdout.write('\nStore this only in the server .env; do not paste it into chat or Git:\n');
    process.stdout.write(`GOOGLE_REFRESH_TOKEN=${token.refresh_token}\n`);
  } catch (error) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Authorization failed. Check the private terminal.\n');
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start OAuth callback');
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorization.search = new URLSearchParams({
    access_type: 'offline',
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    include_granted_scopes: 'true',
    prompt: 'consent',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    state,
  }).toString();
  process.stdout.write('Open this URL in a browser on this computer and authorize the Drive account:\n');
  process.stdout.write(`${authorization.toString()}\n`);
});

const timeout = setTimeout(() => {
  if (finished) return;
  finished = true;
  process.stderr.write('Authorization timed out after five minutes.\n');
  server.close();
  process.exitCode = 1;
}, 5 * 60_000);
timeout.unref();
server.on('close', () => clearTimeout(timeout));
