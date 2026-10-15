'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyMessengerSignature } = require('./messenger');

test('accepts a valid Meta Messenger request signature', () => {
  const body = Buffer.from('{"object":"page","entry":[]}');
  const secret = 'test-app-secret';
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyMessengerSignature(body, `sha256=${digest}`, secret), true);
});

test('rejects missing, malformed, or invalid Messenger signatures', () => {
  const body = Buffer.from('{}');
  assert.equal(verifyMessengerSignature(body, '', 'secret'), false);
  assert.equal(verifyMessengerSignature(body, 'sha1=abcd', 'secret'), false);
  assert.equal(verifyMessengerSignature(body, `sha256=${'0'.repeat(64)}`, 'secret'), false);
  assert.equal(verifyMessengerSignature(body, `sha256=${'a'.repeat(64)}`, ''), false);
  assert.equal(verifyMessengerSignature('{}', `sha256=${'a'.repeat(64)}`, 'secret'), false);
});
