require("dotenv").config();
const { App } = require("@octokit/app");
const { getInstallationOctokit } = require("./githubClient");
const { getCommentSyntax, supportedExtensions } = require("./addCopyright");
const http = require("http");
const { Webhooks } = require("@octokit/webhooks");
const crypto = require('crypto');

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

// Encryption functions with deterministic IV
function generateFernetKey(keyString) {
  const hashedKey = crypto.createHash('sha256').update(keyString).digest();
  return Buffer.from(hashedKey.slice(0, 32)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encryptProjectName(projectName, key) {
  // Generate a deterministic IV based on the key and project name
  const ivSource = key + projectName;
  const iv = crypto.createHash('md5').update(ivSource).digest().slice(0, 16);
  
  const fernetKey = generateFernetKey(key);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(fernetKey, 'base64').slice(0, 32), iv);
  let encrypted = cipher.update(projectName, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const combined = Buffer.concat([iv, Buffer.from(encrypted, 'base64')]);
  return combined.toString('base64');
}

function decryptEncodedString(encodedString, key) {
  try {
    const fernetKey = generateFernetKey(key);
    const combined = Buffer.from(encodedString, 'base64');
    const iv = combined.slice(0, 16);
    const encryptedData = combined.slice(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(fernetKey, 'base64').slice(0, 32), iv);
    let decrypted = decipher.update(encryptedData, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    console.error(`Error decrypting: ${error.message}`);
    return null;
  }
}

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

async function getEncryptionDetailsFromRepo(octokit, repoOwner, repoName, ref) {
  try {
    const encryptionKey = `z9ogqrey1`;
    const projectName = `kingit`;
    const encryptedString = encryptProjectName(projectName, encryptionKey);
    
    return {
      projectName,
      encryptionKey,
      encryptedString
    };
  } catch (error) {
    console.error("Error getting encryption details:", error.message);
    return null;
  }
}

// Updated push event handler to prevent infinite loops
app.webhooks.on("push", async ({ payload }) => {
  console.log("Webhook handler triggered");
  console.log("Received push event:", payload.repository.full_name);
  console.time("handlePushEvent");

  const { repository, installation, sender, ref } = payload;
  const installationId = installation.id;

  const octokit = await getInstallationOctokit(app, installationId);

  // Skip if the latest commit is from the bot
  if (payload.commits.length > 0) {
    const latestCommit = payload.commits[payload.commits.length - 1];
    if (latestCommit.message === "chore: add copyright headers with encrypted identifiers [skip ci]") {
      console.log("Push contains bot commit, skipping...");
      return;
    }
  }

  if (sender.login === "copyright-app[bot]") {
    console.log("Push from bot, skipping...");
    return;
  }

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
      console.timeEnd("handlePushEvent");
      return;
    }

    const copyrightText = await getCopyrightText(octokit, repoOwner, repoName, latestCommitSha);
    const encryptionDetails = await getEncryptionDetailsFromRepo(octokit, repoOwner, repoName, latestCommitSha);
    
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
      
      // Create multi-line copyright header with OWNER_ID at the end
      let fullComment;
      
      if (syntax.end) {
        const prefix = syntax.line ? ` ${syntax.line} ` : '';
        fullComment = `${syntax.start}\n` +
                      `${prefix}Copyright Header\n` +
                      `${prefix}${baseCopyright}\n` +
                      `${prefix}Created date : ${currentDate}\n` +
                      `${prefix}Auther : ${creator}\n`;
                      
        // Add OWNER_ID line if encryption details are available
        if (encryptionDetails) {
          fullComment += `${prefix}OWNER_ID: ${encryptionDetails.encryptedString}\n`;
        }
        
        fullComment += `${syntax.end}\n\n`;
      } else {
        fullComment = `${syntax.start} Copyright Header\n` +
                      `${syntax.start} ${baseCopyright}\n` +
                      `${syntax.start} Created date : ${currentDate}\n` +
                      `${syntax.start} Auther : ${creator}\n`;
                      
        // Add OWNER_ID line if encryption details are available
        if (encryptionDetails) {
          fullComment += `${syntax.start} OWNER_ID: ${encryptionDetails.encryptedString}\n`;
        }
        
        fullComment += "\n";
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
      console.log(`Updated ${filePath} with copyright and encrypted identifiers`);
    }

    if (!changesMade) {
      console.log(`No changes needed in ${repoOwner}/${repoName}`);
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
      message: "chore: add copyright headers with encrypted identifiers [skip ci]",
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

    console.log(`Successfully added copyright and encryption to files in ${repoOwner}/${repoName} on branch ${branch}`);
    console.timeEnd("handlePushEvent");
  } catch (error) {
    console.error("Error processing push event:", error.message || "Unknown error");
    console.timeEnd("handlePushEvent");
    throw error;
  }
});

// Add a route to verify and decrypt encrypted strings
app.webhooks.on("issues.opened", async ({ payload }) => {
  if (!payload.issue.title.toLowerCase().startsWith("verify:")) {
    return;
  }

  const { repository, installation, issue } = payload;
  const installationId = installation.id;
  const octokit = await getInstallationOctokit(app, installationId);
  
  try {
    const lines = issue.body.split('\n');
    let encryptedString, key;
    for (const line of lines) {
      if (line.startsWith("Encrypted:")) {
        encryptedString = line.replace("Encrypted:", "").trim();
      } else if (line.startsWith("Key:")) {
        key = line.replace("Key:", "").trim();
      }
    }
    if (!encryptedString || !key) {
      await octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: issue.number,
        body: "Missing required information. Please provide both 'Encrypted:' and 'Key:' values."
      });
      return;
    }
    const decrypted = decryptEncodedString(encryptedString, key);
    if (decrypted) {
      await octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: issue.number,
        body: `✅ Successfully verified! Project name: ${decrypted}`
      });
    } else {
      await octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: issue.number,
        body: "❌ Verification failed. Unable to decrypt with provided key."
      });
    }
  } catch (error) {
    console.error("Error handling verification issue:", error.message);
    await octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: issue.number,
      body: `Error processing verification: ${error.message}`
    });
  }
});

// Custom middleware with manual validation
const customMiddleware = async (req, res) => {
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

// Export for Vercel/local testing
module.exports = customMiddleware;

// Start server locally if run directly
if (require.main === module) {
  const PORT = process.env.PORT || 3500;
  http.createServer(customMiddleware).listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}