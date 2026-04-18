#!/usr/bin/env node
/**
 * TD-006 — Gera anon + service_role JWTs assinados com o novo JWT_SECRET.
 *
 * Usage:
 *   NEW_JWT_SECRET=$(openssl rand -hex 32) node generate-supabase-jwts.js
 *
 * Output (stdout): JSON { anon, service_role, jwt_secret } — pra ser
 * consumido via `jq` pelo rotator bash.
 *
 * Cuidado: o JSON vai pro stdout; qualquer log adicional DEVE ir
 * pro stderr pra não quebrar o parse.
 */

const crypto = require("crypto");

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHS256(payload, secret) {
  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64urlEncode(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = b64urlEncode(
    crypto.createHmac("sha256", secret).update(data).digest()
  );
  return `${data}.${sig}`;
}

const secret = process.env.NEW_JWT_SECRET;
if (!secret) {
  console.error("NEW_JWT_SECRET env var obrigatória");
  process.exit(1);
}
if (secret.length < 32) {
  console.error("NEW_JWT_SECRET curto demais (<32 chars)");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const tenYears = 10 * 365 * 24 * 3600;

const anon = signHS256(
  { role: "anon", iss: "alpes-ads", iat: now, exp: now + tenYears },
  secret
);
const service_role = signHS256(
  { role: "service_role", iss: "alpes-ads", iat: now, exp: now + tenYears },
  secret
);

// Sanity: decodifica e confere payload
function decode(token) {
  const [, p] = token.split(".");
  return JSON.parse(
    Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
  );
}
const anonCheck = decode(anon);
const svcCheck = decode(service_role);
if (anonCheck.role !== "anon" || svcCheck.role !== "service_role") {
  console.error("Sanity check falhou");
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({ jwt_secret: secret, anon, service_role }) + "\n"
);
