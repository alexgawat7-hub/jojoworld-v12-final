'use strict';
const crypto = require('node:crypto');

function parseSignature(header) {
  const parsed = {};
  for (const part of String(header || '').split(',')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    parsed[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return parsed;
}

function verifyPayMongoSignature(rawBody, header, secret, options = {}) {
  if (!Buffer.isBuffer(rawBody) || !secret || !header) return false;
  const parts = parseSignature(header);
  if (!parts.t || (!parts.te && !parts.li)) return false;
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.').update(rawBody).digest();
  return [parts.te, parts.li].filter(Boolean).some(candidate => {
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
    const supplied = Buffer.from(candidate, 'hex');
    return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
  });
}
module.exports = { parseSignature, verifyPayMongoSignature };
