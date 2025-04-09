const { getInstallationOctokit, getEncryptionDetailsFromRepo } = require('../github/client');
const { supportedExtensions, getCopyrightText, createCopyrightHeader } = require('../utils/copyright');
const config = require('../config');

async function handlePushEvent(app, payload) {
  console.log("Push handler triggered");
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

    const copyrightText = await getCopyrightText(
      octokit, 
      repoOwner, 
      repoName, 
      latestCommitSha, 
      config.DEFAULT_COPYRIGHT_TEXT
    );
    
    const encryptionDetails = await getEncryptionDetailsFromRepo(
      octokit, 
      repoOwner, 
      repoName, 
      latestCommitSha,
      config.DEFAULT_ENCRYPTION_KEY,
      config.DEFAULT_PROJECT_NAME
    );
    
    let changesMade = false;
    const newTree = [];

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

      const copyrightHeader = createCopyrightHeader(
        filePath, 
        copyrightText, 
        creator, 
        encryptionDetails ? encryptionDetails.encryptedString : null
      );
      
      if (!copyrightHeader) {
        console.log(`Skipping ${filePath}: No comment syntax`);
        continue;
      }

      content = copyrightHeader + content;

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
}

module.exports = handlePushEvent;