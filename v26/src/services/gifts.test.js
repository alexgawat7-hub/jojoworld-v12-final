'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GIFT_CATALOG, GiftHubError, sendGift, renderGiftCatalog } = require('./gifts');

function user(coins = 200) {
  return { coins, giftsReceived: {}, giftsCount: 0 };
}

test('gift catalog preserves the V25 gift prices and receiver bonuses', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(GIFT_CATALOG).map(([key, g]) => [key, [g.cost, g.bonus]])),
    { ROSE: [10, 5], COFFEE: [25, 12], BEAR: [50, 25], RING: [100, 50], CAR: [300, 150] }
  );
  assert.match(renderGiftCatalog(), /Red Rose/);
});

test('successful gift debits sender and credits receiver bonus and showcase', () => {
  const sender = user(50);
  const recipient = user(10);
  const result = sendGift({
    senderPsid: 'sender-1', recipientPsid: 'recipient-1',
    sender, recipient, giftKey: 'coffee'
  });
  assert.equal(sender.coins, 25);
  assert.equal(recipient.coins, 22);
  assert.equal(recipient.giftsReceived.COFFEE, 1);
  assert.equal(recipient.giftsCount, 1);
  assert.equal(sender.giftsReceived.COFFEE, undefined);
  assert.equal(result.gift.key, 'COFFEE');
});

test('insufficient balance leaves both wallets and gift stats unchanged', () => {
  const sender = user(9);
  const recipient = user(0);
  assert.throws(() => sendGift({
    senderPsid: 'a', recipientPsid: 'b', sender, recipient, giftKey: 'ROSE'
  }), (error) => error instanceof GiftHubError && error.code === 'INSUFFICIENT_COINS');
  assert.equal(sender.coins, 9);
  assert.equal(recipient.coins, 0);
  assert.equal(recipient.giftsCount, 0);
});

test('rejects unknown gifts and self-gifting', () => {
  const a = user();
  const b = user();
  assert.throws(() => sendGift({
    senderPsid: 'a', recipientPsid: 'b', sender: a, recipient: b, giftKey: 'DIAMOND'
  }), { code: 'UNKNOWN_GIFT' });
  assert.throws(() => sendGift({
    senderPsid: 'a', recipientPsid: 'a', sender: a, recipient: a, giftKey: 'ROSE'
  }), { code: 'INVALID_RECIPIENT' });
  assert.equal(a.coins, 200);
});
