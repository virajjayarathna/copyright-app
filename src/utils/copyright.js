const path = require("path");

const supportedExtensions = [
  ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".cpp", ".h", ".c",
  ".cs", ".html", ".css", ".yml", ".yaml", ".sh"
];

const getCommentSyntax = (file) => {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".js": case ".jsx": case ".ts": case ".tsx":
    case ".java": case ".cpp": case ".h": case ".c": case ".cs":
      return { start: "// ", end: "" };
    case ".py": case ".yml": case ".yaml": case ".sh":
      return { start: "# ", end: "" };
    case ".html":
      return { start: "<!-- ", end: " -->" };
    case ".css":
      return { start: "/* ", end: " */" };
    default:
      return null;
  }
};

// Helper function to fetch and format copyright text
async function getCopyrightText(octokit, repoOwner, repoName, ref, defaultText) {
  let copyrightText = defaultText;
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

function createCopyrightHeader(filePath, copyrightText, creator, encryptedString) {
  const syntax = getCommentSyntax(filePath);
  if (!syntax) return null;

  const currentYear = new Date().getFullYear();
  const currentDate = new Date().toISOString().split("T")[0];
  const baseCopyright = copyrightText.replace("{{YEAR}}", currentYear);
  
  let fullComment;
  
  if (syntax.end) {
    const prefix = syntax.line ? ` ${syntax.line} ` : '';
    fullComment = `${syntax.start}\n` +
                  `${prefix}Copyright Header\n` +
                  `${prefix}${baseCopyright}\n` +
                  `${prefix}Created date : ${currentDate}\n` +
                  `${prefix}Auther : ${creator}\n`;
                  
    // Add OWNER_ID line if encryption details are available
    if (encryptedString) {
      fullComment += `${prefix}OWNER_ID: ${encryptedString}\n`;
    }
    
    fullComment += `${syntax.end}\n\n`;
  } else {
    fullComment = `${syntax.start} Copyright Header\n` +
                  `${syntax.start} ${baseCopyright}\n` +
                  `${syntax.start} Created date : ${currentDate}\n` +
                  `${syntax.start} Auther : ${creator}\n`;
                  
    // Add OWNER_ID line if encryption details are available
    if (encryptedString) {
      fullComment += `${syntax.start} OWNER_ID: ${encryptedString}\n`;
    }
    
    fullComment += "\n";
  }

  return fullComment;
}

module.exports = {
  supportedExtensions,
  getCommentSyntax,
  getCopyrightText,
  createCopyrightHeader
};