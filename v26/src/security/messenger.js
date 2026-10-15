'use strict';

const crypto = require('node:crypto');

function verifyMessengerSignature(rawBody, signatureHeader, appSecret) {
  if (!Buffer.isBuffer(rawBody) || !appSecret || typeof signatureHeader !== 'string') return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const supplied = Buffer.from(match[1], 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}

module.exports = { verifyMessengerSignature };
