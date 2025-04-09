const { app, webhooks } = require('../app');

// Custom middleware with manual validation
const webhookMiddleware = async (req, res) => {
  let body = "";
  req.on("data", chunk => {
    body += chunk.toString();
  });
  req.on("end", async () => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      console.log("Serving health check page");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html>
          <head><title>Copyright App Status</title></head>
          <body>
            <h1>Copyright App is running</h1>
            <p>Server is up and ready to process GitHub webhooks.</p>
            <p>Deployed on: ${new Date().toISOString()}</p>
          </body>
        </html>
      `);
      return;
    }

    const signature256 = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];
    const id = req.headers["x-github-delivery"];

    try {
      const isValid = await webhooks.verify(body, signature256);
      console.log("Signature validation result:", isValid);

      if (!isValid) {
        console.log("Signature invalid, rejecting request");
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      const payload = JSON.parse(body);
      console.log("Manually triggering event:", event);
      await app.webhooks.receive({
        id,
        name: event,
        payload,
      });

      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "processed" }));
      }
    } catch (error) {
      console.error("Error in manual validation:", error.message || "Unknown error");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });
};

module.exports = webhookMiddleware;