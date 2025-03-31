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
});

// Log webhook errors safely
app.webhooks.onError(({ error, request }) => {
  console.error("Webhook error:", error.message || "Unknown error");
});

// Handle push events
app.webhooks.on("push", async ({ payload }) => {
  console.log("Webhook handler triggered");

  const { repository, installation, sender, ref } = payload;
  const installationId = installation.id;

  // Skip if the push is from the bot itself to avoid loops
  if (sender.login === "copyright-app[bot]") {
    console.log("Push from bot, skipping...");
    return;
  }

  const octokit = await getInstallationOctokit(app, installationId);
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const branch = ref.replace("refs/heads/", "");

  try {
    const { data: refData } = await octokit.git.getRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${branch}`,
    });
    const latestCommitSha = refData.object.sha;

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

    if (filesToProcess.length === 0) {
      console.log("No supported files to process, skipping...");
      return;
    }

    const currentYear = new Date().getFullYear();
    const currentDate = new Date().toISOString().split("T")[0];
    const formattedCopyright = defaultCopyrightText
      .replace("{{YEAR}}", currentYear)
      .replace("{{DATE}}", currentDate);

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

      if (content.includes(formattedCopyright)) {
        console.log(`Skipping ${filePath}: Copyright already present`);
        continue;
      }

      content = formattedCopyright + "\n\n" + content;
      const { data: blobData } = await octokit.git.createBlob({
        owner: repoOwner,
        repo: repoName,
        content,
        encoding: "utf-8",
      });

      newTree.push({
        path: filePath,
        mode: "100644",
        type: "blob",
        sha: blobData.sha,
      });
      changesMade = true;
    }

    if (!changesMade) {
      console.log("No changes needed.");
      return;
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
      message: "chore: add copyright headers",
      tree: newTreeData.sha,
      parents: [latestCommitSha],
    });

    await octokit.git.updateRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${branch}`,
      sha: newCommitData.sha,
      force: false,
    });

    console.log(`Successfully added copyright to ${repoOwner}/${repoName} on ${branch}`);
  } catch (error) {
    console.error("Error processing push event:", error.message);
  }
});

// Export for Vercel/local testing
module.exports = async (req, res) => {
  console.log(`Incoming request: ${req.method} ${req.url}`);
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("GitHub App is running");
};
