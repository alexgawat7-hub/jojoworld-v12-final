'use strict';

// JojoWorld V26 Gift Hub domain service.
// This module validates and applies an in-memory gift transfer. The caller must
// persist BOTH users before reporting success to Messenger.
const GIFT_CATALOG = Object.freeze({
  ROSE: Object.freeze({ key: 'ROSE', name: '🌹 Red Rose', cost: 25, bonus: 5 }),
  COFFEE: Object.freeze({ key: 'COFFEE', name: '☕ Coffee Cup', cost: 60, bonus: 12 }),
  BEAR: Object.freeze({ key: 'BEAR', name: '🧸 Teddy Bear', cost: 120, bonus: 25 }),
  RING: Object.freeze({ key: 'RING', name: '💍 Diamond Ring', cost: 250, bonus: 50 }),
  CAR: Object.freeze({ key: 'CAR', name: '🏎️ Sports Car', cost: 750, bonus: 150 })
});

class GiftHubError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GiftHubError';
    this.code = code;
  }
}

function ensureUserGiftFields(user) {
  if (!user.giftsReceived || typeof user.giftsReceived !== 'object' || Array.isArray(user.giftsReceived)) {
    user.giftsReceived = {};
  }
  if (!Number.isFinite(user.giftsCount) || user.giftsCount < 0) user.giftsCount = 0;
  if (!Number.isFinite(user.coins) || user.coins < 0) {
    throw new GiftHubError('INVALID_BALANCE', 'Wallet balance is invalid.');
  }
}

/**
 * Applies one gift to sender/recipient objects after all checks pass.
 * senderPsid and recipientPsid must be authenticated Messenger PSIDs from
 * the webhook context, never arbitrary user-supplied display names.
 */
function sendGift({ senderPsid, recipientPsid, sender, recipient, giftKey }) {
  const key = String(giftKey || '').trim().toUpperCase();
  const gift = GIFT_CATALOG[key];
  if (!gift) throw new GiftHubError('UNKNOWN_GIFT', 'That gift is not available.');
  if (!senderPsid || !recipientPsid || senderPsid === recipientPsid) {
    throw new GiftHubError('INVALID_RECIPIENT', 'You cannot send a gift to yourself.');
  }
  if (!sender || !recipient) {
    throw new GiftHubError('USER_NOT_FOUND', 'Sender or recipient account was not found.');
  }

  ensureUserGiftFields(sender);
  ensureUserGiftFields(recipient);
  if (sender.coins < gift.cost) {
    throw new GiftHubError('INSUFFICIENT_COINS', 'You do not have enough coins for this gift.');
  }

  // Only mutate after validation so ordinary validation failures cost no coins.
  sender.coins -= gift.cost;
  recipient.giftsReceived[gift.key] = (recipient.giftsReceived[gift.key] || 0) + 1;
  recipient.giftsCount = (recipient.giftsCount || 0) + 1;
  recipient.coins += gift.bonus;

  return {
    gift,
    senderBalance: sender.coins,
    recipientBalance: recipient.coins,
    recipientGiftCount: recipient.giftsReceived[gift.key]
  };
}

function renderGiftCatalog() {
  return Object.values(GIFT_CATALOG)
    .map((gift) => `${gift.name} — ${gift.cost} coins (receiver bonus +${gift.bonus})`)
    .join('\n');
}

module.exports = { GIFT_CATALOG, GiftHubError, sendGift, renderGiftCatalog };
