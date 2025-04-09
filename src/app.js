require("dotenv").config();
const { App } = require("@octokit/app");
const { Webhooks } = require("@octokit/webhooks");
const config = require("./config");
const registerWebhooks = require("./github/webhooks");

// Initialize the GitHub App
const app = new App({
  appId: config.APP_ID,
  privateKey: config.PRIVATE_KEY,
  webhooks: { secret: config.WEBHOOK_SECRET },
  oauth: { clientId: undefined, clientSecret: undefined },
});

// Webhooks instance for manual validation
const webhooks = new Webhooks({
  secret: config.WEBHOOK_SECRET,
});

// Register all webhook handlers
registerWebhooks(app);

module.exports = { app, webhooks };