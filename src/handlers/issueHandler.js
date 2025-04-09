const { getInstallationOctokit } = require('../github/client');
const { decryptEncodedString } = require('../utils/encryption');

async function handleIssueOpenedEvent(app, payload) {
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
}

module.exports = handleIssueOpenedEvent;