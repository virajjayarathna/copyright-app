const crypto = require('crypto');

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

module.exports = {
  generateFernetKey,
  encryptProjectName,
  decryptEncodedString
};