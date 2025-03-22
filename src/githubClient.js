const { Octokit } = require("@octokit/core");

async function getInstallationOctokit(app, installationId) {
  const installationToken = await app.octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    { installation_id: installationId }
  ).then(response => response.data.token);
  return new Octokit({ auth: installationToken });
}

module.exports = { getInstallationOctokit };