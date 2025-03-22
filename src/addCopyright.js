const fs = require("fs").promises;
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

async function addCopyrightToFile(filePath, copyrightText) {
  const syntax = getCommentSyntax(filePath);
  if (!syntax) return false;

  const currentYear = new Date().getFullYear();
  const currentDate = new Date().toISOString().split("T")[0];
  const formattedCopyright = copyrightText
    .replace("{{YEAR}}", currentYear)
    .replace("{{DATE}}", currentDate);
  const comment = `${syntax.start}${formattedCopyright}${syntax.end}\n\n`;

  const content = await fs.readFile(filePath, "utf8");
  if (content.includes(formattedCopyright)) return false;

  await fs.writeFile(filePath, comment + content);
  return true;
}

module.exports = { addCopyrightToFile, supportedExtensions };