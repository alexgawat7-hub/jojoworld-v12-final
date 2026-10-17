# JojoWorld V26 Ultimate Evolution

JojoWorld is a Facebook Messenger bot. The root `index.js` is the current full application entry point; the `v26/` directory contains V26 services and security checks being integrated without replacing the existing bot all at once.

## Requirements

- Node.js 20 or newer
- A Facebook Page and Messenger app with a Page Access Token and Meta App Secret
- A public HTTPS host for the Messenger webhook
- MongoDB connection string for persistent production data; use MongoDB Atlas or another replica-set deployment that supports transactions
- PayMongo credentials if you want payment top-ups enabled

## Run locally

1. Clone this repository and switch to `jojoworld-v26-ultimate-evolution`.
2. Install dependencies from the **repository root**:

   ```sh
   npm install
   ```

3. Copy `.env.example` to `.env` and replace the placeholder values with your own credentials. Never commit `.env`.
4. Run the checks:

   ```sh
   npm run check
   npm test
   ```

5. Start the server:

   ```sh
   npm start
   ```

6. Open `/health` on the hosted URL to confirm the process responds. Open `/ready` to see whether Messenger tokens are configured. The process can start before credentials are configured, but Messenger webhooks are rejected until valid `PAGE_TOKEN`, `VERIFY_TOKEN`, and `META_APP_SECRET` values are set and the webhook is configured.

## Facebook Messenger webhook

In Meta's developer dashboard, set the callback URL to `https://YOUR-HOST/webhook` and use the same `VERIFY_TOKEN` configured in the environment. Subscribe the Page to the message and postback events required by the bot. The host must be publicly reachable over HTTPS.

## Payments and storage

Set `MONGODB_URI` for persistent user data. Gift transfers and wallet/jackpot saves use MongoDB transactions, so the database must support transactions (for example, MongoDB Atlas or a replica set). Without it, the legacy application falls back to local `db.json`, which is not suitable for ephemeral hosting; automatic payment top-ups stay disabled unless MongoDB is connected. Configure both `PAYMONGO_SECRET` and `PAYMONGO_WEBHOOK_SECRET` before enabling live payment flows. Use test credentials while validating checkout and webhook behavior.

## AI-generated name-effect artwork

JojoWorld can optionally generate premium artwork for each of its 14 name effects through the OpenAI Images API. Add `OPENAI_API_KEY` as a private environment secret on the hosting service (for example, Render); never commit the real key. The default model is `gpt-image-1.5` at low quality to limit cost. You can override this with `OPENAI_IMAGE_MODEL` and `OPENAI_IMAGE_QUALITY`.

Artwork is generated lazily when a name-effect shop preview is requested, then cached in the host's `cache/` directory and reused. The user's name remains rendered by Canvas so it is accurate and consistent. Visual profiles only read cached artwork and do not trigger generation by themselves. If the API key is absent or generation fails, the existing Canvas effect remains available as a fallback. OpenAI API usage is billed separately from a ChatGPT subscription, and first-time generation can take longer than a cached preview.

## Automated checks

GitHub Actions runs JavaScript syntax checks and unit tests on pushes and pull requests to the V26 branch. A green check confirms those checks passed; it does **not** mean the bot has been deployed or verified against live Facebook, MongoDB, or PayMongo services.
