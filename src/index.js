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
      message: "chore: add copyright headers to all files [skip ci]",
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