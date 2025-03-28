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
  console.error("Webhook error:", error.message || error.toString());
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

// Handle repository installation
app.webhooks.on("installation.created", async ({ payload }) => {
  console.log("Installation handler triggered");
  console.time("handleInstallation");

  const { installation, repositories } = payload;
  const installationId = installation.id;

  const octokit = await getInstallationOctokit(app, installationId);

  for (const repo of repositories) {
    const repoOwner = repo.owner.login;
    const repoName = repo.name;
    const defaultBranch = repo.default_branch;

    try {
      // Get the latest commit SHA of the default branch
      const { data: refData } = await octokit.git.getRef({
        owner: repoOwner,
        repo: repoName,
        ref: `heads/${defaultBranch}`,
      });
      const latestCommitSha = refData.object.sha;

      // Get copyright text
      const copyrightText = await getCopyrightText(octokit, repoOwner, repoName, latestCommitSha);

      // Get all files in the repository recursively
      const { data: commitData } = await octokit.git.getCommit({
        owner: repoOwner,
        repo: repoName,
        commit_sha: latestCommitSha,
      });
      const treeSha = commitData.tree.sha;

      const { data: treeData } = await octokit.git.getTree({
        owner: repoOwner,
        repo: repoName,
        tree_sha: treeSha,
        recursive: true,
      });

      const filesToProcess = treeData.tree
        .filter(item => item.type === "blob" && supportedExtensions.some(ext => item.path.endsWith(ext)))
        .map(item => item.path);

      console.log("Files to process on installation:", filesToProcess);

      if (filesToProcess.length === 0) {
        console.log(`No supported files in ${repoOwner}/${repoName}, skipping...`);
        continue;
      }

      let changesMade = false;
      const newTree = [];

      for (const filePath of filesToProcess) {
        console.log("Processing file:", filePath);
        const { data: fileData } = await octokit.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path: filePath,
          ref: latestCommitSha,
        });
        let content = Buffer.from(fileData.content, "base64").toString("utf8");

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
        console.log(`No changes needed in ${repoOwner}/${repoName}`);
        continue;
      }

      const { data: newTreeData } = await octokit.git.createTree({
        owner: repoOwner,
        repo: repoName,
        base_tree: treeSha,
        tree: newTree,
      });

      const { data: newCommitData } = await octokit.git.createCommit({
        owner: repoOwner,
        repo: repoName,
        message: "chore: add copyright headers to existing files [skip ci]",
        tree: newTreeData.sha,
        parents: [latestCommitSha],
      });

      await octokit.git.updateRef({
        owner: repoOwner,
        repo: repoName,
        ref: `heads/${defaultBranch}`,
        sha: newCommitData.sha,
      });

      console.log(`Successfully added copyright to all files in ${repoOwner}/${repoName}`);
    } catch (error) {
      console.error(`Error processing installation for ${repoOwner}/${repoName}:`, error.message || error.toString());
    }
  }
  console.timeEnd("handleInstallation");
});

// Handle push events (existing logic with copyright.txt integration)
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

  // Fetch copyright text
  const copyrightText = await getCopyrightText(octokit, repoOwner, repoName, head_commit.id);

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
      const formattedCopyright = copyrightText
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
    console.error("Error processing push event:", error.message || error.toString());
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
      console.error("Error in manual validation:", error.message || error.toString());
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