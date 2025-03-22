const { Octokit } = require("@octokit/rest");
const { App } = require("@octokit/app");

async function getInstallationOctokit(app, installationId) {
  const installationAccessToken = await app.getInstallationAccessToken({
    installationId,
  });
  return new Octokit({ auth: installationAccessToken });
}

module.exports = { getInstallationOctokit };