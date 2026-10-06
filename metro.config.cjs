const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
if (!config.resolver.assetExts.includes('story')) config.resolver.assetExts.push('story');
module.exports = config;
