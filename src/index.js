require("dotenv").config();
const { App } = require("@octokit/app");
const { createNodeMiddleware } = require("@octokit/app");
const { getInstallationOctokit } = require("./githubClient");
const { addCopyrightToFile, supportedExtensions } = require("./addCopyright");
const http = require("http");

// Debug environment variables
console.log("APP_ID:", process.env.APP_ID);
console.log("WEBHOOK_SECRET:", process.env.WEBHOOK_SECRET);
console.log("PRIVATE_KEY (first 50 chars):", process.env.PRIVATE_KEY.substring(0, 50));
console.log("GITHUB_TOKEN (first 10 chars):", process.env.GITHUB_TOKEN.substring(0, 10));

// Initialize the GitHub App
const app = new App({
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY,
  //webhooks: { secret: process.env.WEBHOOK_SECRET },
  oauth: { clientId: undefined, clientSecret: undefined },
});

// Default copyright text
const defaultCopyrightText = "© {{YEAR}} [YourCompanyName]. All Rights Reserved. {{DATE}}";

// Log all webhook events
app.webhooks.onAny(({ id, name, payload }) => {
  console.log(`Webhook received: ${name} (ID: ${id})`);
  console.log("Payload:", JSON.stringify(payload, null, 2));
});

// Log webhook errors with more detail
app.webhooks.onError(({ error, request }) => {
  console.error("Webhook error:", error.message, error.stack);
  console.log("Request headers:", JSON.stringify(request.headers, null, 2));
  console.log("Request body:", request.body);
});

app.webhooks.on("push", async ({ payload }) => {
  console.log("Webhook handler triggered");
  console.log("Received push event:", payload.repository.full_name);
  console.time("handlePushEvent");

  const { repository, installation, sender, commits, head_commit } = payload;
  const installationId = installation.id;

  if (sender.login === "copyright-app[bot]") {
    console.log("Push from bot, skipping...");
    return;
  }

  const octokit = await getInstallationOctokit(app, installationId);
  const repoOwner = repository.owner.login;
  const repoName = repository.name;

  try {
    const filesToProcess = new Set();
    commits.forEach(commit => {
      commit.added?.forEach(file => filesToProcess.add(file));
      commit.modified?.forEach(file => filesToProcess.add(file));
    });
    console.log("Files to process:", Array.from(filesToProcess));

    if (filesToProcess.size === 0) {
      console.log("No files to process, skipping...");
      console.timeEnd("handlePushEvent");
      return;
    }

    let changesMade = false;
    const newTree = [];

    for (const filePath of filesToProcess) {
      if (!supportedExtensions.some(ext => filePath.endsWith(ext))) {
        console.log(`Skipping ${filePath}: Unsupported extension`);
        continue;
      }

      console.log("Processing file:", filePath);
      const { data: fileData } = await octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path: filePath,
        ref: head_commit.id,
      });
      let content = Buffer.from(fileData.content, "base64").toString("utf8");

      const currentYear = new Date().getFullYear();
      const currentDate = new Date().toISOString().split("T")[0];
      const formattedCopyright = defaultCopyrightText
        .replace("{{YEAR}}", currentYear)
        .replace("{{DATE}}", currentDate);
      const syntax = require("./addCopyright").getCommentSyntax(filePath);
      if (!syntax) {
        console.log(`Skipping ${filePath}: No comment syntax`);
        continue;
      }

      const comment = `${syntax.start}${formattedCopyright}${syntax.end}\n\n`;
      if (content.includes(formattedCopyright)) {
        console.log(`Skipping ${filePath}: Copyright already present`);
        continue;
      }

      content = comment + content;
      const { data: blobData } = await octokit.git.createBlob({
        owner: repoOwner,
        repo: repoName,
        content: content,
        encoding: "utf-8",
      });

      newTree.push({
        path: filePath,
        mode: "100644",
        type: "blob",
        sha: blobData.sha,
      });
      changesMade = true;
      console.log(`Updated ${filePath} with copyright`);
    }

    if (!changesMade) {
      console.log("No changes needed.");
      console.timeEnd("handlePushEvent");
      return;
    }

    const { data: newTreeData } = await octokit.git.createTree({
      owner: repoOwner,
      repo: repoName,
      base_tree: head_commit.tree_id,
      tree: newTree,
    });

    const { data: newCommitData } = await octokit.git.createCommit({
      owner: repoOwner,
      repo: repoName,
      message: "chore: add copyright headers [skip ci]",
      tree: newTreeData.sha,
      parents: [head_commit.id],
    });

    await octokit.git.updateRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${repository.default_branch}`,
      sha: newCommitData.sha,
    });

    console.log(`Successfully added copyright to ${repoOwner}/${repoName}`);
    console.timeEnd("handlePushEvent");
  } catch (error) {
    console.error("Error processing push event:", error.message, error.stack);
    console.timeEnd("handlePushEvent");
    throw error;
  }
});

// Custom middleware with raw request logging
const customMiddleware = (req, res) => {
  console.log(`Incoming request: ${req.method} ${req.url}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));

  let body = "";
  req.on("data", chunk => {
    body += chunk.toString();
  });
  req.on("end", () => {
    console.log("Raw body:", body);

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

    console.log("Passing to webhook handler");
    const octokitMiddleware = createNodeMiddleware(app);
    octokitMiddleware(req, res, () => {
      if (!res.headersSent) {
        console.log("No response sent by webhook handler, sending default 200");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "received" }));
      }
    });
  });
};

// Export for Vercel/local testing
module.exports = customMiddleware;

// Start server locally if run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3500;
  http.createServer(customMiddleware).listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}