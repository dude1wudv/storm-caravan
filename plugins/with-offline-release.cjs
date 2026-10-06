const { withAppBuildGradle, withAndroidManifest } = require('expo/config-plugins');

module.exports = function withOfflineRelease(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    if (!application) throw new Error('Android application manifest missing');
    application.$['android:usesCleartextTraffic'] = 'false';
    application.$['android:allowBackup'] = 'false';
    return mod;
  });
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') throw new Error('Expected Groovy build.gradle');
    const marker = '// storm-caravan independent release signing';
    if (mod.modResults.contents.includes(marker)) return mod;
    mod.modResults.contents += `
${marker}
def caravanReleaseRequested = gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }
def caravanKeystore = System.getenv('STORM_CARAVAN_KEYSTORE')
def caravanPassword = System.getenv('STORM_CARAVAN_STORE_PASS')
if (caravanReleaseRequested && (!caravanKeystore || !caravanPassword)) {
    throw new GradleException('Project Release signing credentials must be injected')
}
android {
    signingConfigs {
        stormCaravanRelease {
            if (caravanKeystore) storeFile file(caravanKeystore)
            storePassword caravanPassword
            keyAlias 'storm-caravan'
            keyPassword caravanPassword
        }
    }
    buildTypes.release.signingConfig = signingConfigs.stormCaravanRelease
}
`;
    return mod;
  });
};
