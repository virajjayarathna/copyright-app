require("dotenv").config();
const startServer = require("./src/server");

// Start server if not imported as a module
if (require.main === module) {
  startServer();
}

// Export middleware for Vercel/serverless environments
module.exports = require("./src/middleware/webhookMiddleware");