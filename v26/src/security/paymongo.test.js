'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { verifyPayMongoSignature, parseSignature } = require('./paymongo');

test('parses PayMongo signature fields', () => {
  assert.deepEqual(parseSignature('t=123,te=abc,li=def'), { t: '123', te: 'abc', li: 'def' });
});

test('accepts matching test signature inside timestamp tolerance', () => {
  const body = Buffer.from('{"data":{"id":"evt_test"}}');
  const secret = 'test-secret';
  const now = 1700000000000;
  const timestamp = String(Math.floor(now / 1000));
  const signature = crypto.createHmac('sha256', secret).update(timestamp + '.').update(body).digest('hex');
  assert.equal(verifyPayMongoSignature(body, `t=${timestamp},te=${signature}`, secret, { now }), true);
});

test('rejects bad signatures and stale timestamps', () => {
  const body = Buffer.from('{}');
  assert.equal(verifyPayMongoSignature(body, 't=1700000000,te=' + '0'.repeat(64), 'secret', { now: 1700000000000 }), false);
  assert.equal(verifyPayMongoSignature(body, 't=1,te=' + '0'.repeat(64), 'secret', { now: 1700000000000 }), false);
  assert.equal(verifyPayMongoSignature(body, 't=1,te=' + '0'.repeat(64), '', { now: 1000 }), false);
});
