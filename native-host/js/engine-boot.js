(function () {
    'use strict';

    // Source: client-recovery/startup-interfaces.json, normalJsbBoot and safeFragments.
    // Platform/local-identity installation is a required independent integration step.
    window.Alloy2581Boot = function (integration, onLaunched, onError) {
        if (!integration || typeof integration.httpConnect !== 'function' ||
            typeof integration.installLocalMode !== 'function' ||
            typeof onLaunched !== 'function' || typeof onError !== 'function') {
            throw new TypeError('A real local-mode/service integration and launch callbacks are required');
        }
        if (!window.jsb || typeof loadRuntime === 'function') {
            throw new Error('This host supports the source-verified normal JSB branch only');
        }
        require('src/settings.js');
        require('src/cocos2d-jsb.js');
        if (CC_PHYSICS_BUILTIN || CC_PHYSICS_CANNON) {
            throw new Error('The pinned 2581 source has both physics flags disabled');
        }
        require('jsb-adapter/jsb-engine.js');
        cc.macro.CLEANUP_IMAGE_CACHE = true;
        var settings = window._CCSettings;
        window._CCSettings = undefined;
        if (!settings || !settings.launchScene) throw new Error('Verified original settings are required');
        if (settings.remoteBundles && settings.remoteBundles.length || settings.server) {
            throw new Error('Remote bundle sources require a separately configured project service');
        }
        window.ft = window.ft || {};
        window.ft.httpConnect = integration.httpConnect;
        var names = cc.AssetManager.BuiltinBundleName;
        var bundles = [names.INTERNAL];
        if (settings.hasResourcesBundle) bundles.push(names.RESOURCES);
        cc.assetManager.init({
            bundleVers: settings.bundleVers,
            remoteBundles: settings.remoteBundles,
            server: settings.server
        });
        var finished = false;
        var successfulLoads = 0;

        function fail(error) {
            if (finished) return;
            finished = true;
            onError(error instanceof Error ? error : new Error(String(error)));
        }

        function launchScene() {
            try {
                cc.view.enableRetina(true);
                cc.view.resizeWithBrowserSize(true);
                if (cc.sys.isMobile) {
                    if (settings.orientation === 'landscape') cc.view.setOrientation(cc.macro.ORIENTATION_LANDSCAPE);
                    else if (settings.orientation === 'portrait') cc.view.setOrientation(cc.macro.ORIENTATION_PORTRAIT);
                    cc.view.enableAutoFullScreen([
                        cc.sys.BROWSER_TYPE_BAIDU, cc.sys.BROWSER_TYPE_BAIDU_APP,
                        cc.sys.BROWSER_TYPE_WECHAT, cc.sys.BROWSER_TYPE_MOBILE_QQ,
                        cc.sys.BROWSER_TYPE_MIUI, cc.sys.BROWSER_TYPE_HUAWEI, cc.sys.BROWSER_TYPE_UC
                    ].indexOf(cc.sys.browserType) < 0);
                }
                var bundle = cc.assetManager.bundles.find(function (entry) {
                    return entry.getSceneInfo(settings.launchScene);
                });
                if (!bundle) throw new Error('The original launch-scene bundle is unavailable');
                bundle.loadScene(settings.launchScene, null, null, function (error, scene) {
                    if (error) return fail(error);
                    try {
                        cc.director.runSceneImmediate(scene);
                        onLaunched(scene);
                        finished = true;
                    } catch (failure) { fail(failure); }
                });
            } catch (error) { fail(error); }
        }

        function loaded(error) {
            if (finished) return;
            if (error) return fail(error);
            successfulLoads += 1;
            if (successfulLoads !== bundles.length + 1) return;
            cc.assetManager.loadBundle(names.MAIN, function (failure) {
                if (failure) return fail(failure);
                try {
                    // Before scene.onLoad: no original passport/signature/SDK init is synthesized.
                    integration.installLocalMode({settings: settings, ft: window.ft, fts: window.fts, ftc: window.ftc});
                    cc.game.run({
                        id: 'GameCanvas',
                        debugMode: settings.debug ? cc.debug.DebugMode.INFO : cc.debug.DebugMode.ERROR,
                        showFPS: settings.debug,
                        frameRate: 60,
                        groupList: settings.groupList,
                        collisionMatrix: settings.collisionMatrix
                    }, launchScene);
                } catch (error) { fail(error); }
            });
        }
        // Keep the original jsList leg: no fabricated empty SkeletonExt or skipped callback.
        cc.assetManager.loadScript(settings.jsList.map(function (path) { return 'src/' + path; }), loaded);
        for (var index = 0; index < bundles.length; index += 1) {
            cc.assetManager.loadBundle(bundles[index], loaded);
        }
    };
}());
