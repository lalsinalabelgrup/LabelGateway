/**
 * redact.js — sanitization helpers for anything that may end up on disk
 * or in structured logs.
 *
 * redactSipText masks Authorization / Proxy-Authorization header lines
 * (and the Digest response= value specifically, in case it appears split
 * across a differently-cased or reformatted header) in a raw SIP message
 * before it is written to a SipDumper dump file.
 *
 * maskPhoneNumber is provided for future use — phone numbers currently
 * remain visible in development logs per product decision, but a reusable
 * masking helper is kept here so they can be masked later without
 * touching call sites.
 */

"use strict";

const AUTH_HEADER_LINE = /^((?:proxy-)?authorization\s*:).*$/gim;
const DIGEST_RESPONSE  = /(response\s*=\s*)"[^"]*"/gi;

function redactSipText(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    .replace(AUTH_HEADER_LINE, "$1 [REDACTED]")
    .replace(DIGEST_RESPONSE, '$1"[REDACTED]"');
}

function maskPhoneNumber(number) {
  if (typeof number !== "string" || number.length <= 4) return number;
  return `${"*".repeat(number.length - 4)}${number.slice(-4)}`;
}

module.exports = { redactSipText, maskPhoneNumber };
