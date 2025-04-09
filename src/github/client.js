const { Octokit } = require("@octokit/rest");

async function getInstallationOctokit(app, installationId) {
  const installationToken = await app.octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: installationId }
  ).then(response => response.data.token);
  
  return new Octokit({ auth: installationToken });
}

async function getEncryptionDetailsFromRepo(octokit, repoOwner, repoName, ref, defaultKey, defaultProject) {
  try {
    // For now using default values, but this could be extended to read from repo
    const encryptionKey = defaultKey;
    const projectName = defaultProject;
    
    const { encryptProjectName } = require('../utils/encryption');
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

module.exports = {
  getInstallationOctokit,
  getEncryptionDetailsFromRepo
};