const handlePushEvent = require('../handlers/pushHandler');
const handleIssueOpenedEvent = require('../handlers/issueHandler');

function registerWebhooks(app) {
  // Register push event handler
  app.webhooks.on("push", async ({ payload }) => {
    await handlePushEvent(app, payload);
  });

  // Register issues.opened event handler
  app.webhooks.on("issues.opened", async ({ payload }) => {
    await handleIssueOpenedEvent(app, payload);
  });

  return app;
}

module.exports = registerWebhooks;