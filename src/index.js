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

// Encryption functions adapted from the Python script
function generateFernetKey(keyString) {
  // Create a consistent key by hashing the input string
  const hashedKey = crypto.createHash('sha256').update(keyString).digest();
  // Convert to base64 format
  return Buffer.from(hashedKey.slice(0, 32)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encryptProjectName(projectName, key) {
  // Generate encryption key
  const fernetKey = generateFernetKey(key);
  
  // Node.js doesn't have Fernet directly, so we'll use a similar approach with AES
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(fernetKey, 'base64').slice(0, 32), iv);
  
  // Encrypt the project name
  let encrypted = cipher.update(projectName, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  // Combine IV and encrypted data and encode as base64
  const combined = Buffer.concat([iv, Buffer.from(encrypted, 'base64')]);
  return combined.toString('base64');
}

function decryptEncodedString(encodedString, key) {
  try {
    // Generate key
    const fernetKey = generateFernetKey(key);
    
    // Decode base64
    const combined = Buffer.from(encodedString, 'base64');
    
    // Extract IV and encrypted data
    const iv = combined.slice(0, 16);
    const encryptedData = combined.slice(16);
    
    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(fernetKey, 'base64').slice(0, 32), iv);
    let decrypted = decipher.update(encryptedData, undefined, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error(`Error decrypting: ${error.message}`);
    return null;
  }
}

function splitStringIntoParts(str, numParts = 5) {
  // Split a string into approximately equal parts
  const partLength = Math.floor(str.length / numParts);
  const parts = [];
  let remaining = str;
  
  // Create the first n-1 parts
  for (let i = 0; i < numParts - 1; i++) {
    const variation = remaining.length % (numParts - i);
    const currentLength = partLength + (variation > 0 ? 1 : 0);
    
    parts.push(remaining.substring(0, currentLength));
    remaining = remaining.substring(currentLength);
  }
  
  // Add the last part
  parts.push(remaining);
  
  return parts;
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

// Helper function to generate and insert encrypted identifiers
async function getEncryptionDetailsFromRepo(octokit, repoOwner, repoName, ref) {
  try {
    // Try to fetch encryption-key.txt to get encryption key
    const { data: keyFile } = await octokit.repos.getContent({
      owner: repoOwner,
      repo: repoName,
      path: "encryption-key.txt",
      ref,
    }).catch(() => ({ data: null }));

    const encryptionKey = keyFile ? 
      Buffer.from(keyFile.content, "base64").toString("utf8").trim() : 
      `${repoOwner}-${repoName}-key`;
    
    // Generate encrypted project name
    const projectName = `${repoOwner}/${repoName}`;
    const encryptedString = encryptProjectName(projectName, encryptionKey);
    const parts = splitStringIntoParts(encryptedString, 5);
    
    return {
      projectName,
      encryptionKey,
      encryptedString,
      parts
    };
  } catch (error) {
    console.error("Error getting encryption details:", error.message);
    return null;
  }
}

// Modify a file to include encrypted identifier parts as comments
function addEncryptedComments(content, filePath, parts) {
  const lines = content.split("\n");
  
  // Make sure file has at least 16 lines
  while (lines.length < 16) {
    lines.push('');
  }
  
  // Get comment syntax for the file
  const syntax = getCommentSyntax(filePath);
  if (!syntax) return content; // If no syntax defined, return original content
  
  // Add comments to lines 12-16
  for (let i = 0; i < Math.min(parts.length, 5); i++) {
    const lineNumber = 11 + i; // Lines are 0-indexed
    if (lineNumber < lines.length) {
      const commentChar = syntax.line || (syntax.start.includes('/*') ? '' : syntax.start);
      const lineEnd = commentChar ? ` ${commentChar} ${parts[i]}` : ` // ${parts[i]}`;
      
      if (lines[lineNumber].includes("//") || lines[lineNumber].includes(commentChar)) {
        lines[lineNumber] = lines[lineNumber].split(/\/\/|commentChar/)[0] + lineEnd;
      } else {
        lines[lineNumber] = lines[lineNumber].trimEnd() + lineEnd;
      }
    } else {
      const commentChar = syntax.line || syntax.start;
      lines.push(`${commentChar} ${parts[i]}`);
    }
  }
  
  return lines.join("\n");
}

// Save copyright and encryption info to a file in the repo
async function saveCopyrightInfo(octokit, repoOwner, repoName, branch, encryptionDetails, commitSha) {
  try {
    const infoContent = 
      `Project Name: ${encryptionDetails.projectName}\n` +
      `Key: ${encryptionDetails.encryptionKey}\n` +
      `Full Encrypted: ${encryptionDetails.encryptedString}\n`;
    
    // Create blob with the content
    const { data: blobData } = await octokit.git.createBlob({
      owner: repoOwner,
      repo: repoName,
      content: infoContent,
      encoding: "utf-8",
    });
    
    return {
      path: "copyright_info.txt",
      mode: "100644",
      type: "blob",
      sha: blobData.sha
    };
  } catch (error) {
    console.error("Error saving copyright info:", error.message);
    return null;
  }
}

// Handle push events
app.webhooks.on("push", async ({ payload }) => {
  console.log("Webhook handler triggered");
  console.log("Received push event:", payload.repository.full_name);
  console.time("handlePushEvent");

  const { repository, installation, sender, ref } = payload;
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

    // Always fetch all files in the repository
    const { data: treeData } = await octokit.git.getTree({
      owner: repoOwner,
      repo: repoName,
      tree_sha: treeSha,
      recursive: true,
    });
    
    // Filter for supported file types
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
      
      // Add encrypted identifiers as comments to lines 12-16
      if (encryptionDetails) {
        content = addEncryptedComments(content, filePath, encryptionDetails.parts);
      }

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

    // Add copyright_info.txt to the tree if encryption is enabled
    if (encryptionDetails) {
      const infoFileTree = await saveCopyrightInfo(
        octokit, 
        repoOwner, 
        repoName, 
        branch, 
        encryptionDetails, 
        latestCommitSha
      );
      
      if (infoFileTree) {
        newTree.push(infoFileTree);
        changesMade = true;
      }
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
  // Only handle issues with title starting with "verify:"
  if (!payload.issue.title.toLowerCase().startsWith("verify:")) {
    return;
  }

  const { repository, installation, issue } = payload;
  const installationId = installation.id;
  const octokit = await getInstallationOctokit(app, installationId);
  
  try {
    // Extract encryptedString and key from issue body
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
    
    // Try to decrypt
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