const http = require("http");
const webhookMiddleware = require("./middleware/webhookMiddleware");
const config = require("./config");

function startServer() {
  const PORT = config.PORT;
  const server = http.createServer(webhookMiddleware);
  
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
  
  return server;
}

module.exports = startServer;