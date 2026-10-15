# JojoWorld V26 migration branch

This branch is isolated from the live production branch. Keep the existing Render service on `main` until the V26 integration has been tested.

## Existing Render variables
Preserve existing variable names where applicable: `MONGODB_URI`, `PAGE_TOKEN`, `PAYMONGO_SECRET`, `PAYMONGO_WEBHOOK_SECRET`, `VERIFY_TOKEN`, `ADMIN_ID`, `PAGE_USERNAME`, and `GCASH_NUM`. Never commit `.env` or reveal secrets.

## Deployment checklist
1. Use Node.js 20+.
2. Install dependencies from the V26 project directory.
3. Configure MongoDB using a replica set or supported transaction deployment for atomic wallet changes.
4. Configure Meta Messenger webhook HTTPS URL, Page token, App Secret and Verify Token.
5. Configure PayMongo webhook secret and verify signatures against the raw request body. Reject requests if the secret is missing.
6. Validate event type, payment status, order reference, amount and currency; use a unique payment reference to prevent duplicate coin credits.
7. Run syntax, unit and integration tests before changing the Render deployment.

This documentation alone is not a complete runnable V26 replacement. Keep the existing production service unchanged until model wiring, payment-order persistence, Messenger routing, and the existing command set have been integrated and tested.