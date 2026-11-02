// The Metro config of Expo finds the workspace of the repository by itself (apps/*, packages/*),
// also with the isolated install of Bun. Nothing else is needed.
const { getDefaultConfig } = require("expo/metro-config")

module.exports = getDefaultConfig(__dirname)
