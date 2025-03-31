require("dotenv").config();
const { App } = require("@octokit/app");
const { getInstallationOctokit } = require("./githubClient");
const { getCommentSyntax, supportedExtensions } = require("./addCopyright");
const http = require("http");
const { Webhooks } = require("@octokit/webhooks");


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
const defaultCopyrightText = "© {{YEAR}} Company. All Rights Reserved.";

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

// Handle installation events: Process all files when app is installed
app.webhooks.on("installation.created", async ({ payload }) => {
  console.log("Webhook handler triggered");
  console.log("Received installation.created event for:", payload.repositories.map(r => r.full_name));
  console.time("handleInstallationEvent");

  const { installation, sender, repositories } = payload;
  const installationId = installation.id;
  const creator = sender.login;

  const octokit = await getInstallationOctokit(app, installationId);

  try {
    for (const repo of repositories) {
      const repoOwner = repo.owner.login;
      const repoName = repo.name;

      // Get the default branch
      const { data: repoData } = await octokit.repos.get({ owner: repoOwner, repo: repoName });
      const defaultBranch = repoData.default_branch;

      // Get the latest commit SHA of the default branch
      const { data: refData } = await octokit.git.getRef({
        owner: repoOwner,
        repo: repoName,
        ref: `heads/${defaultBranch}`,
      });
      const latestCommitSha = refData.object.sha;

      // Get the commit data to access the tree
      const { data: commitData } = await octokit.git.getCommit({
        owner: repoOwner,
        repo: repoName,
        commit_sha: latestCommitSha,
      });
      const treeSha = commitData.tree.sha;

      // Fetch all files recursively
      const { data: treeData } = await octokit.git.getTree({
        owner: repoOwner,
        repo: repoName,
        tree_sha: treeSha,
        recursive: true,
      });

      const filesToProcess = treeData.tree
        .filter(item => item.type === "blob" && supportedExtensions.some(ext => item.path.endsWith(ext)))
        .map(item => item.path);

      console.log(`Files to process in ${repoOwner}/${repoName}:`, filesToProcess);

      if (filesToProcess.length === 0) {
        console.log(`No supported files in ${repoOwner}/${repoName}, skipping...`);
        continue;
      }

      const copyrightText = await getCopyrightText(octokit, repoOwner, repoName, latestCommitSha);
      let changesMade = false;
      const newTree = [];
      const currentYear = new Date().getFullYear();
      const currentDate = new Date().toISOString().split("T")[0];

      for (const filePath of filesToProcess) {
        console.log(`Processing file: ${filePath} in ${repoOwner}/${repoName}`);
        const { data: fileData } = await octokit.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path: filePath,
          ref: latestCommitSha,
        });
        let content = Buffer.from(fileData.content, "base64").toString("utf8");
        const lines = content.split("\n");
        const firstTenLines = lines.slice(0, 10).join("\n");

        if (firstTenLines.includes("Copyright Header")) {
          console.log(`Skipping ${filePath}: Copyright header already present`);
          continue;
        }

        const syntax = getCommentSyntax(filePath);
        if (!syntax) {
          console.log(`Skipping ${filePath}: No comment syntax`);
          continue;
        }

        const baseCopyright = copyrightText.replace("{{YEAR}}", currentYear);
        let fullComment;
        if (syntax.end) {
          const prefix = syntax.line ? ` ${syntax.line} ` : '';
          fullComment = `${syntax.start}\n` +
                        `${prefix}Copyright Header\n` +
                        `${prefix}${baseCopyright}\n` +
                        `${prefix}Created date : ${currentDate}\n` +
                        `${prefix}Created by : ${creator}\n` +
                        `${syntax.end}\n\n`;
        } else {
          fullComment = `${syntax.start} Copyright Header\n` +
                        `${syntax.start} ${baseCopyright}\n` +
                        `${syntax.start} Created date : ${currentDate}\n` +
                        `${syntax.start} Created by : ${creator}\n\n`;
        }

        content = fullComment + content;
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
        message: "chore: add copyright headers on installation [skip ci]",
        tree: newTreeData.sha,
        parents: [latestCommitSha],
      });

      await octokit.git.updateRef({
        owner: repoOwner,
        repo: repoName,
        ref: `heads/${defaultBranch}`,
        sha: newCommitData.sha,
        force: false,
      });

      console.log(`Successfully added copyright to files in ${repoOwner}/${repoName} on branch ${defaultBranch}`);
    }
    console.timeEnd("handleInstallationEvent");
  } catch (error) {
    console.error("Error processing installation event:", error.message || "Unknown error");
    console.timeEnd("handleInstallationEvent");
    throw error;
  }
});

// Handle push events
app.webhooks.on("push", async ({ payload }) => {
  console.log("Webhook handler triggered");
  console.log("Received push event:", payload.repository.full_name);
  console.time("handlePushEvent");

  const { repository, installation, sender, ref, commits } = payload;
  const installationId = installation.id;

  if (sender.login === "copyright-app[bot]") {
    console.log("Push from bot, skipping...");
    return;
  }

  const octokit = await getInstallationOctokit(app, installationId);
  const repoOwner = repository.owner.login;
  const repoName = repository.name;
  const branch = ref.replace("refs/heads/", "");
  const creator = sender.login;

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

    const isCopyrightTxtChanged = commits.some(commit =>
      commit.added?.includes("copyright.txt") || commit.modified?.includes("copyright.txt")
    );

    let filesToProcess;
    if (isCopyrightTxtChanged) {
      const { data: treeData } = await octokit.git.getTree({
        owner: repoOwner,
        repo: repoName,
        tree_sha: treeSha,
        recursive: true,
      });
      filesToProcess = treeData.tree
        .filter(item => item.type === "blob" && supportedExtensions.some(ext => item.path.endsWith(ext)))
        .map(item => item.path);
    } else {
      const newFiles = new Set();
      commits.forEach(commit => {
        commit.added?.forEach(file => {
          if (supportedExtensions.some(ext => file.endsWith(ext))) {
            newFiles.add(file);
          }
        });
      });
      filesToProcess = Array.from(newFiles);
    }

    console.log("Files to process:", filesToProcess);

    if (filesToProcess.length === 0) {
      console.log("No files to process, skipping...");
      console.timeEnd("handlePushEvent");
      return;
    }

    const copyrightText = await getCopyrightText(octokit, repoOwner, repoName, latestCommitSha);
    let changesMade = false;
    const newTree = [];
    const currentYear = new Date().getFullYear();
    const currentDate = new Date().toISOString().split("T")[0];

    for (const filePath of filesToProcess) {
      console.log("Processing file:", filePath);
      const { data: fileData } = await octokit.repos.getContent({
        owner: repoOwner,
        repo: repoName,
        path: filePath,
        ref: latestCommitSha,
      });
      let content = Buffer.from(fileData.content, "base64").toString("utf8");
      const lines = content.split("\n");
      const firstTenLines = lines.slice(0, 10).join("\n");

      if (firstTenLines.includes("Copyright Header")) {
        console.log(`Skipping ${filePath}: Copyright header already present`);
        continue;
      }

      const syntax = getCommentSyntax(filePath);
      if (!syntax) {
        console.log(`Skipping ${filePath}: No comment syntax`);
        continue;
      }

      const baseCopyright = copyrightText.replace("{{YEAR}}", currentYear);
      let fullComment;
      if (syntax.end) {
        const prefix = syntax.line ? ` ${syntax.line} ` : '';
        fullComment = `${syntax.start}\n` +
                      `${prefix}Copyright Header\n` +
                      `${prefix}${baseCopyright}\n` +
                      `${prefix}Created date : ${currentDate}\n` +
                      `${prefix}Created by : ${creator}\n` +
                      `${syntax.end}\n\n`;
      } else {
        fullComment = `${syntax.start} Copyright Header\n` +
                      `${syntax.start} ${baseCopyright}\n` +
                      `${syntax.start} Created date : ${currentDate}\n` +
                      `${syntax.start} Created by : ${creator}\n\n`;
      }

      content = fullComment + content;
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
      base_tree: treeSha,
      tree: newTree,
    });

    const { data: newCommitData } = await octokit.git.createCommit({
      owner: repoOwner,
      repo: repoName,
      message: "chore: add copyright headers [skip ci]",
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
    //console.log("Raw body:", body);

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