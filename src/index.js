require("dotenv").config();
const { App } = require("@octokit/app");
const { createNodeMiddleware } = require("@octokit/app");
const { getInstallationOctokit } = require("./githubClient");
const { addCopyrightToFile, supportedExtensions } = require("./addCopyright");
const fs = require("fs").promises;
const path = require("path");
const { exec } = require("child_process");
const util = require("util");
const execPromise = util.promisify(exec);

const app = new App({
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY, // Directly from env variable
  webhooks: { secret: process.env.WEBHOOK_SECRET },
});

// Default copyright text
const defaultCopyrightText = "© {{YEAR}} [YourCompanyName]. All Rights Reserved. {{DATE}}";

app.webhooks.on("push", async ({ payload }) => {
  const { repository, installation, sender } = payload;
  const installationId = installation.id;

  // Skip if the push is from the bot itself to avoid infinite loops
  if (sender.login === "copyright-app[bot]") {
    console.log("Push from bot, skipping...");
    return;
  }

  const octokit = await getInstallationOctokit(app, installationId);
  const repoOwner = repository.owner.login;
  const repoName = repository.name;

  try {
    // Clone the repository locally
    const cloneDir = `/tmp/repo-${Date.now()}`;
    await execPromise(`git clone https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${repoOwner}/${repoName}.git ${cloneDir}`);
    process.chdir(cloneDir);

    // Check for custom copyright text
    let copyrightText = defaultCopyrightText;
    try {
      copyrightText = await fs.readFile(".github/copyright.txt", "utf8");
    } catch (e) {
      console.log("No custom copyright.txt found, using default.");
    }

    // Process files
    const files = (await execPromise("git ls-files")).stdout.split("\n");
    let changesMade = false;

    for (const file of files) {
      if (!file || !supportedExtensions.some(ext => file.endsWith(ext))) continue;
      if ([".gitignore", "LICENSE", "README.md"].includes(path.basename(file))) continue;

      const modified = await addCopyrightToFile(file, copyrightText);
      if (modified) changesMade = true;
    }

    // Commit and push if changes were made
    if (changesMade) {
      await execPromise(`git config user.name "copyright-app[bot]"`);
      await execPromise(`git config user.email "copyright-app[bot]@users.noreply.github.com"`);
      await execPromise(`git add .`);
      await execPromise(`git commit -m "chore: add copyright headers [skip ci]"`);
      await execPromise(`git push`);
      console.log(`Added copyright headers to ${repoOwner}/${repoName}`);
    } else {
      console.log("No changes needed.");
    }

    // Clean up
    process.chdir("/tmp");
    await execPromise(`rm -rf ${cloneDir}`);
  } catch (error) {
    console.error("Error processing push event:", error);
  }
});

// Export for Vercel
module.exports = createNodeMiddleware(app);