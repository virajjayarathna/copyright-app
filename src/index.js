require("dotenv").config();
const { App } = require("@octokit/app");
const { getInstallationOctokit } = require("./githubClient");
const { addCopyrightToFile, supportedExtensions } = require("./addCopyright");
const http = require("http");
const { Webhooks } = require("@octokit/webhooks");

// Debug environment variables
console.log("APP_ID:", process.env.APP_ID);
console.log("WEBHOOK_SECRET:", process.env.WEBHOOK_SECRET);
console.log("PRIVATE_KEY (first 50 chars):", process.env.PRIVATE_KEY.substring(0, 50));
console.log("GITHUB_TOKEN (first 10 chars):", process.env.GITHUB_TOKEN.substring(0, 10));

// Initialize the GitHub App
const app = new App({
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY,
  webhooks: { secret: process.env.WEBHOOK_SECRET },
  oauth: { clientId: undefined, clientSecret: undefined },
});

// Webhooks instance for manual validation
const webhooks = new Webhooks({
  secret: process.env.WEBHOOK_SECRET,
});

// Default copyright text
const defaultCopyrightText = "© {{YEAR}} [YourCompanyName]. All Rights Reserved. {{DATE}}";

// Log all webhook events
app.webhooks.onAny(({ id, name, payload }) => {
  console.log(`Webhook received: ${name} (ID: ${id})`);
  console.log("Payload:", JSON.stringify(payload, null, 2));
});

// Log webhook errors safely
app.webhooks.onError(({ error, request }) => {
  console.error("Webhook error:", error.message || "Unknown error");
  console.log("Request headers:", JSON.stringify(request.headers, null, 2));
  console.log("Request body:", request.body);
});

// Helper function to fetch and format copyright text
async function getCopyrightText(octokit, repoOwner, repoName, ref) {
  let copyrightText = defaultCopyrightText;
  try {
    const { data: copyrightFile } = await octokit.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path: "copyright.txt",
      ref,
    });
    if (copyrightFile.type === "file") {
      copyrightText = Buffer.from(copyrightFile.content, "base64").toString("utf8").trim();
      console.log("Using custom copyright text from copyright.txt");
    } else {
      console.log("copyright.txt is not a file, using default");
    }
  } catch (error) {
    if (error.status === 404) {
      console.log("copyright.txt not found, using default");
    } else {
      console.error("Error fetching copyright.txt:", error.message);
    }
  }
  return copyrightText;
}

// Handle push events: Check first 10 lines of all files on every push to any branch
app.webhooks.on("push", async ({ payload }) => {
  console.log("Webhook handler triggered");
  console.log("Received push event:", payload.repository.full_name);
  console.time("handlePushEvent");

  const { repository, installation, sender, ref, head_commit } = payload;
  const installationId = installation.id;

  // Skip if the push is from the bot itself to avoid loops
  if (sender.login === "copyright-app[bot]") {
    console.log("Push from bot, skipping...");
    return;
  }

  const octokit = await getInstallationOctokit(app, installationId);
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const branch = ref.replace("refs/heads/", ""); // Get the branch name from ref

  try {
    // Get the latest commit SHA of the branch
    const { data: refData } = await octokit.git.getRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = refData.object.sha;

    // Get the commit data to access the tree
    const { data: commitData } = await octokit.git.getCommit({
      owner: repoOwner,
      repo: repoName,
      commit_sha: latestCommitSha,
    });
    const treeSha = commitData.tree.sha;

    // Fetch all files recursively from the repository
    const { data: treeData } = await octokit.git.getTree({
      owner: repoOwner,
      repo: repoName,
      tree_sha: treeSha,
      recursive: true,
    });

    // Filter for supported file extensions
    const filesToProcess = treeData.tree
      .filter(item => item.type === "blob" && supportedExtensions.some(ext => item.path.endsWith(ext)))
      .map(item => item.path);

    console.log("Files to process:", filesToProcess);

    if (filesToProcess.length === 0) {
      console.log("No supported files to process, skipping...");
      console.timeEnd("handlePushEvent");
      return;
    }

    // Fetch the copyright text from the latest commit
    const copyrightText = await getCopyrightText(octokit, repoOwner, repoName, latestCommitSha);

    let changesMade = false;
    const newTree = [];

    // Process each file
    for (const filePath of filesToProcess) {
      console.log("Processing file:", filePath);
      const { data: fileData } = await octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path: filePath,
        ref: latestCommitSha,
      });
      let content = Buffer.from(fileData.content, "base64").toString("utf8");

      // Get the first 10 lines
      const lines = content.split("\n");
      const firstTenLines = lines.slice(0, 10).join("\n");

      const currentYear = new Date().getFullYear();
      const currentDate = new Date().toISOString().split("T")[0];
      const formattedCopyright = copyrightText
        .replace("{{YEAR}}", currentYear)
        .replace("{{DATE}}", currentDate);
      const syntax = require("./addCopyright").getCommentSyntax(filePath);
      if (!syntax) {
        console.log(`Skipping ${filePath}: No comment syntax`);
        continue;
      }

      const comment = `${syntax.start}${formattedCopyright}${syntax.end}\n\n`;
      if (firstTenLines.includes(formattedCopyright)) {
        console.log(`Skipping ${filePath}: Copyright already present in first 10 lines`);
        continue;
      }

      // Add the copyright comment to the top of the file
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

    // Create a new tree with the updated files
    const { data: newTreeData } = await octokit.git.createTree({
      owner: repoOwner,
      repo: repoName,
      base_tree: treeSha,
      tree: newTree,
    });

    // Create a new commit based on the latest commit SHA
    const { data: newCommitData } = await octokit.git.createCommit({
      owner: repoOwner,
      repo: repoName,
      message: "chore: add copyright headers [skip ci]",
      tree: newTreeData.sha,
      parents: [latestCommitSha],
    });

    // Update the branch reference with force option if needed (optional)
    await octokit.git.updateRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${branch}`,
      sha: newCommitData.sha,
      force: false, // Set to true if you want to force the update (not recommended)
    });

    console.log(`Successfully added copyright to files in ${repoOwner}/${repoName} on branch ${branch}`);
    console.timeEnd("handlePushEvent");
  } catch (error) {
    console.error("Error processing push event:", error.message || "Unknown error");
    console.timeEnd("handlePushEvent");
    throw error;
  }
});

// Custom middleware with manual validation
const customMiddleware = async (req, res) => {
  console.log(`Incoming request: ${req.method} ${req.url}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));

  let body = "";
  req.on("data", chunk => {
    body += chunk.toString();
  });
  req.on("end", async () => {
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

// Export for Vercel/local testing
module.exports = customMiddleware;

// Start server locally if run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3500;
  http.createServer(customMiddleware).listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}