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
  webhooks: { secret: process.env.WEBHOOK_SECRET },
  // Explicitly disable OAuth to avoid confusion
  oauth: { clientId: undefined, clientSecret: undefined },
});

// Default copyright text
const defaultCopyrightText = "© {{YEAR}} [YourCompanyName]. All Rights Reserved. {{DATE}}";

app.webhooks.on("push", async ({ payload }) => {
  console.log("Received push event:", payload.repository.full_name);
  
  const { repository, installation, sender } = payload;
  const installationId = installation.id;

  // Skip if from bot to avoid infinite loops
  if (sender.login === "copyright-app[bot]") {
    console.log("Push from bot, skipping...");
    return;
  }

  const octokit = await getInstallationOctokit(app, installationId);
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const defaultBranch = repository.default_branch;

  try {
    // Get custom copyright text or use default
    let copyrightText = defaultCopyrightText;
    try {
      const { data } = await octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path: ".github/copyright.txt",
      });
      copyrightText = Buffer.from(data.content, "base64").toString("utf8");
      console.log("Using custom copyright text from .github/copyright.txt");
    } catch (e) {
      console.log("No custom copyright.txt found, using default.");
    }

    // Get the latest commit SHA
    const { data: refData } = await octokit.git.getRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${defaultBranch}`,
    });
    const latestCommitSha = refData.object.sha;

    // Get the tree from the latest commit
    const { data: commitData } = await octokit.git.getCommit({
      owner: repoOwner,
      repo: repoName,
      commit_sha: latestCommitSha,
    });
    const treeSha = commitData.tree.sha;

    // Get all files in the tree
    const { data: treeData } = await octokit.git.getTree({
      owner: repoOwner,
      repo: repoName,
      tree_sha: treeSha,
      recursive: true,
    });

    let changesMade = false;
    const newTree = [];

    for (const file of treeData.tree) {
      if (!file.path || file.type !== "blob" || !supportedExtensions.some(ext => file.path.endsWith(ext))) continue;
      if ([".gitignore", "LICENSE", "README.md"].includes(file.path)) continue;

      const { data: fileData } = await octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path: file.path,
      });
      let content = Buffer.from(fileData.content, "base64").toString("utf8");

      const currentYear = new Date().getFullYear();
      const currentDate = new Date().toISOString().split("T")[0];
      const formattedCopyright = copyrightText
        .replace("{{YEAR}}", currentYear)
        .replace("{{DATE}}", currentDate);
      const syntax = require("./addCopyright").getCommentSyntax(file.path);
      if (!syntax) continue;

      const comment = `${syntax.start}${formattedCopyright}${syntax.end}\n\n`;
      if (content.includes(formattedCopyright)) continue;

      content = comment + content;
      newTree.push({
        path: file.path,
        mode: file.mode,
        type: "blob",
        content: content,
      });
      changesMade = true;
    }

    if (!changesMade) {
      console.log("No changes needed.");
      return;
    }

    // Create a new tree
    const { data: newTreeData } = await octokit.git.createTree({
      owner: repoOwner,
      repo: repoName,
      base_tree: treeSha,
      tree: newTree,
    });

    // Create a new commit
    const { data: newCommitData } = await octokit.git.createCommit({
      owner: repoOwner,
      repo: repoName,
      message: "chore: add copyright headers [skip ci]",
      tree: newTreeData.sha,
      parents: [latestCommitSha],
    });

    // Update the branch reference
    await octokit.git.updateRef({
      owner: repoOwner,
      repo: repoName,
      ref: `heads/${defaultBranch}`,
      sha: newCommitData.sha,
    });

    console.log(`Successfully added copyright headers to ${repoOwner}/${repoName}`);
  } catch (error) {
    console.error("Error processing push event:", error.message, error.stack);
    throw error;
  }
});

// Custom middleware to handle GET requests for health check
const customMiddleware = (req, res) => {
  if (req.method === "GET" && req.url === "/" || req.url === "/health") {
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
  } else {
    // Pass to Octokit middleware for webhook handling
    return createNodeMiddleware(app)(req, res);
  }
};

// Export for Vercel/local testing
module.exports = customMiddleware;

// Start server locally if run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  http.createServer(customMiddleware).listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}