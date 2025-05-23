module.exports = {
    APP_ID: process.env.APP_ID,
    PRIVATE_KEY: process.env.PRIVATE_KEY,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
    PORT: process.env.PORT || 3500,
    
    // Default copyright text
    DEFAULT_COPYRIGHT_TEXT: "© {{YEAR}} Company. All Rights Reserved.",
    
    // Default encryption key
    DEFAULT_ENCRYPTION_KEY: process.env.DEFAULT_ENCRYPTION_KEY || "secretvalue",
    DEFAULT_PROJECT_NAME: process.env.DEFAULT_PROJECT_NAME || "key",
};