(function () {
    'use strict';
    require('alloy/engine-boot.js');
    require('alloy/local-mode.js');
    require('alloy/core-algorithms.js');
    console.log('[ALLOY2581_GAME_BOOT] independent-local; original baseline 2581; local-production rules');
    window.Alloy2581Boot(window.Alloy2581Local, function (scene) {
        console.log('[ALLOY2581_SCENE_LAUNCHED] ' + scene.name);
        var touchCounts = { start: 0, end: 0, cancel: 0 };
        var observedTalkNodes = [];
        function observeTalkTouches(layout) {
            if (!layout || layout._layoutName !== 'LayoutTalk' || !layout.buttonClick) return;
            var button = layout.buttonClick;
            var node = button.node;
            if (!node || observedTalkNodes.indexOf(node) !== -1) return;
            observedTalkNodes.push(node);
            ['TOUCH_START', 'TOUCH_END', 'TOUCH_CANCEL'].forEach(function (type) {
                [true, false].forEach(function (capture) {
                    node.on(cc.Node.EventType[type], function (event) {
                        var text = layout._texts && layout._texts[layout._textIndex];
                        console.log('[ALLOY2581_TALK_TOUCH] ' + JSON.stringify({
                            type: type, phase: capture ? 'capture' : 'bubble',
                            target: event.target && event.target.name,
                            currentTarget: event.currentTarget && event.currentTarget.name,
                            targetMatchesButton: event.target === node,
                            currentTargetMatchesButton: event.currentTarget === node,
                            layoutMatchesTop: ftc.ManagerRes.topLayout() === layout,
                            lockMatchesButton: ftc.ManagerRes.lockClicking === button,
                            globallyBlocked: ftc.ManagerRes.lockClicking === 1,
                            interactable: button.interactable, pressed: button._pressed,
                            textIndex: layout._textIndex, wordIndex: layout._wordIndex,
                            textLength: typeof text === 'string' ? text.length : null,
                            isLast: layout._isLast, setNext: layout._setNext,
                            hold: layout.hold, autoTalk: layout._isAutoTalk,
                            longPressTime: layout.__longPressTime,
                            componentEnabled: layout.enabledInHierarchy,
                            nodeActive: node.activeInHierarchy
                        }));
                    }, undefined, capture);
                });
            });
        }
        ['touchstart', 'touchend', 'touchcancel'].forEach(function (type, index) {
            document.addEventListener(type, function () {
                touchCounts[['start', 'end', 'cancel'][index]]++;
                console.log('[ALLOY2581_INPUT] ' + type);
            });
        });
        cc.game.on(cc.game.EVENT_HIDE, function () { console.log('[ALLOY2581_LIFECYCLE] hide'); });
        cc.game.on(cc.game.EVENT_SHOW, function () { console.log('[ALLOY2581_LIFECYCLE] show'); });
        window.setInterval(function () {
            var player = ftc.player;
            if (!player || !player.ManagerMap || !player.ManagerTask) return;
            var topLayout = ftc.ManagerRes.topLayout();
            if (window.Alloy2581Local && typeof window.Alloy2581Local.ensureSaveSwitcher === 'function') window.Alloy2581Local.ensureSaveSwitcher(topLayout);
            observeTalkTouches(topLayout);
            var lock = ftc.ManagerRes.lockClicking;
            console.log('[ALLOY2581_LOCAL_STATE] ' + JSON.stringify({
                sceneLoaded: ftc.scene.isLoaded, frameLifecycleReady: ftc.scene.isLoadedFtr,
                localGameplayStarted: player.isStartGame === true, uiGameplayStarted: ftc.ManagerData.isStartGame === true,
                runtimeProfile: ftc.localMode.profile, originalTestMode: fts.TEST,
                originalSte: player.ste, playerLevel: player.lv, saveError: player.dbFile.ERROR, dslReady: player.system.isStart,
                activeThreads: player.system._threads.length, storeThreads: player.system.storeThreadSize,
                map: player.ManagerMap.cur, task: player.ManagerTask.cur,
                pendingUiRequests: ftc._sendPackMsgs && ftc._sendPackMsgs.l,
                pendingPlayerMessages: player._packMessageStack.length,
                gamePaused: cc.game._paused, directorPaused: cc.director.isPaused(),
                totalFrames: cc.director.getTotalFrames(),
                topLayout: topLayout && (topLayout._layoutName || topLayout.name),
                lockClicking: lock === 1 ? 'blocked' : lock && lock.node ? lock.node.name : String(lock),
                shieldingActive: ftc.scene.nodeShielding.active, waitActive: ftc.scene.nodeWait.active,
                talkAuto: topLayout && topLayout._isAutoTalk, talkSetNext: topLayout && topLayout._setNext,
                talkTextIndex: topLayout && topLayout._textIndex, talkWordIndex: topLayout && topLayout._wordIndex,
                talkInteractable: topLayout && topLayout.buttonClick && topLayout.buttonClick.interactable,
                touchCounts: touchCounts
            }));
        }, 5000);
    }, function (error) {
        console.error('[ALLOY2581_GAME_BOOT_ERROR] ' + (error.stack || String(error)));
    });
}());
