(function () {
    'use strict';
    var prefix = 'alloy-2581-local-v1:';
    var installed = false;

    function fail(error) {
        console.error('[ALLOY2581_LOCAL_ERROR] ' + (error.stack || String(error)));
        throw error;
    }

    function localLog(storage) {
        var pending = [];
        var elapsed = 0;
        function add(kind, args) {
            pending.push({time: Date.now(), kind: kind, values: Array.prototype.slice.call(args)});
        }
        function flush() {
            if (!pending.length) return;
            var previous = storage.getItem(prefix + 'logs');
            var entries = previous ? JSON.parse(previous) : [];
            entries = entries.concat(pending).slice(-256);
            storage.setItem(prefix + 'logs', JSON.stringify(entries));
            pending.length = 0;
        }
        var result = {tick: function (delta) { elapsed += delta; if (elapsed >= 5) { elapsed = 0; flush(); } }, flush: flush};
        ['addLog', 'addDebug', 'addEventLog', 'addActivityLog', 'addActivityEndDelItemLog'].forEach(function (kind) {
            result[kind] = function () { add(kind, arguments); };
        });
        return result;
    }

    function localHttp(player, log) {
        var result = {
            capabilities: {mode: 'independent-local', clock: 'local-device', authenticated: false, remote: 'not-configured'},
            getTime: function () { return ft.getSysSecond(); },
            getDay: function () { return ft.toDay(ft.getSysSecond()); },
            getHoliday: function () { return -1; },
            tick: function () { result.lastLocalTick = ft.getSysSecond(); },
            readyTouch: function () { result.lastLocalRollover = ft.toDay(ft.getSysSecond()); return {ok: false, status: 'not-configured'}; },
            log: function (data, kind) { log.addLog('http-log', kind, data); return {ok: true, destination: 'local-log'}; }
        };
        // All remote call sites in the pinned main bundle remain explicit unavailable boundaries.
        ['init', 'setPassportInfo', 'startGameService', 'touch', 'useCDKey', 'modifyNick',
            'useGiftMoney', 'rewardByTotalPay', 'getActivityCD', 'addMonsterroomReport',
            'addRankingScore', 'addTowerRanking', 'getBattleReport', 'getMonsterroomHeros',
            'getMonsterroomHerosRandom', 'getMonsterroomInfos', 'getMonsterroomReportList',
            'getRankingList', 'getTowerRankingVal', 'postBattleReport', 'praiseMonsterroom',
            'quitMonsterroom', 'updateMonsterroom', 'updateNickToRanking'].forEach(function (operation) {
            result[operation] = function () {
                log.addLog('service-unavailable', operation);
                if (ftc.scene && ftc.scene.isLoaded) ftc.showTip('本地模式未配置此远端服务：' + operation);
                return {ok: false, status: 'not-configured', operation: operation};
            };
        });
        return result;
    }

    function localHeader(storage) {
        var key = prefix + 'header';
        var headers;
        function save() { storage.setItem(key, JSON.stringify(headers)); }
        return {
            readHeader: function () {
                var text = storage.getItem(key);
                headers = text ? JSON.parse(text) : {sel: prefix + 'slot-1', list: [prefix + 'slot-1'], next: 2, coreDSLVersion: 1};
                if (!headers || !Array.isArray(headers.list) || headers.list.indexOf(headers.sel) < 0 ||
                    !Number.isSafeInteger(headers.next) || headers.next < 2 || headers.list.some(function (id) {
                        return typeof id !== 'string' || id.indexOf(prefix + 'slot-') !== 0;
                    })) throw new Error('Invalid independent-local save header; refusing to reset it');
                if (text && headers.coreDSLVersion === undefined) {
                    // The earlier project-only development runtime lacked native-injected DSL methods.
                    // Preserve every old slot/data byte; explicitly start a separate source-correct new-game slot.
                    var oldSelected = headers.sel;
                    headers.sel = prefix + 'slot-' + headers.next++;
                    headers.list.push(headers.sel);
                    headers.coreDSLVersion = 1;
                    console.log('[ALLOY2581_LOCAL_SAVE_UPGRADE] preserved=' + oldSelected + ' selected=' + headers.sel + ' reason=original-core-recovered');
                    save();
                } else if (!text) save();
                return true;
            },
            getSelectHeader: function () { return headers.sel; },
            getAllHeaders: function () { return headers.list.slice(); },
            setSelectHeader: function (id) { if (headers.list.indexOf(id) < 0) return false; headers.sel = id; save(); return true; },
            createHeader: function () { headers.sel = prefix + 'slot-' + headers.next++; headers.list.push(headers.sel); save(); return headers.sel; },
            saveHeader: save
        };
    }

    function prepareResources(scene, ready) {
        var manager = ftc.ManagerRes;
        if (manager.isLoadOver || manager._mainLoop) throw new Error('Unexpected repeated local resource preparation');
        var prefabs = ftc.registPrefabs.slice();
        var atlases = ftc.registTextures.slice();
        // Original startLoadGame registration/progress/queue leg, without remote hot-update or a second player creation.
        manager.isLoadOver = false;
        manager._registDirs = ftc.registDirs;
        manager._registPrefabs = ftc.registPrefabs;
        manager._registTextures = ftc.registTextures;
        manager._registAudios = ftc.registAudios;
        manager._registImgs = ftc.registImgs;
        cc.audioEngine.setMaxAudioInstance(128);
        manager._loadingProgress = 0;
        var count = manager._registDirs.length + prefabs.length + atlases.length +
            manager._registAudios.length + manager._registImgs.length;
        manager._everyLoadingBlockSize = count / 8;
        manager._totalLoadingSize = count + 2 * manager._everyLoadingBlockSize;
        var completed = false;
        manager._callbackLoadingProgress = function (ratio, subProgress, name, description) {
            if (description) scene.labelWaitingTip.string = description;
            if (completed || manager.isLoadOver !== true || manager._loadingProgress !== -1 || manager._totalLoadingSize !== 0) return;
            prefabs.forEach(function (path) {
                var name = path.substring(path.lastIndexOf('/') + 1);
                if (!(manager.getResource(name) instanceof cc.Prefab)) throw new Error('Required original prefab did not load: ' + path);
            });
            atlases.forEach(function (name) {
                if (!(manager.getResource(name) instanceof cc.SpriteAtlas)) throw new Error('Required original atlas did not load: ' + name);
            });
            if (!manager.getResource('home').getSpriteFrame('home_btn_jiasu1')) throw new Error('Required original home speed frame did not load');
            completed = true;
            console.log('[ALLOY2581_ORIGINAL_ASSETS_READY] prefabs=' + prefabs.length + ' atlases=' + atlases.length);
            ready();
        };
        // Table/player preparation has actually completed, so advance the two original data blocks before the original queue.
        manager.updateMainLoadingProgress(2 * manager._everyLoadingBlockSize, undefined, '正在加载游戏资源');
        manager._loadResource();
        manager._mainLoop = window.setInterval(manager.tick.bind(manager), 50);
    }

    function initializePlayer(scene, storage) {
        var Player = window.__require('player');
        var player = ftc.player = new Player();
        var log = localLog(storage);
        player.localMode = {mode: 'independent-local', profile: 'local-production', authenticated: false};
        player.http = localHttp(player, log);
        player.serverLog = log;
        player.dbHeader = localHeader(storage);
        var device = storage.getItem(prefix + 'identity');
        if (!device) {
            device = 'alloy-local-' + ft.md5(String(Date.now()) + ':' + String(Math.random()));
            storage.setItem(prefix + 'identity', device);
        }
        // Non-authentication BasePlayer.init skeleton, from expanded/main/baseplayer.js.
        player._autoCreateEntityId = 1;
        player._isH5ClientReadyOk = false;
        player._sendMessageStack = [];
        player._packMessageStack = [];
        player._latestSendMessageStack = [];
        player._flagAllSaveKeys = {};
        player._nextFrameCallbacks = [];
        player.subSourceId = ftc.getSubSourceId();
        player.sourceId = ftc.getSourceId();
        player.lanName = ftc.ManagerLan.getLanguage();
        player.deviceId = device;
        player.zone = ftc.getZone();
        player.isTv = !!ftc.isTv();
        player.buildVersion = ftc.getBuildVersion() || ft.getVersion();
        player.areaCode = ftc.getAreaCode();
        player.player = player;
        player.saveId = '00';
        player.className = player.notifyName = 'Player';
        player.forbidCover = {entityName: true, className: true, notifyName: true, player: true,
            entityId: true, saveId: true, manager: true};
        ft.bindMsg(player);
        player.ManagerKeys = {};
        player.ManagerOrderKeys.forEach(function (entry) {
            Object.keys(entry).forEach(function (name) { player.ManagerKeys[name] = entry[name]; });
        });
        player._msgIndex = -1;
        player._netErrorCount = 0;
        player.initTouch = true;
        if (player.playerLoadStart) player.playerLoadStart();
        player.msg.startGame = function (data) {
            player.isStartGame = true;
            player.isFirstGame = false;
            player.playerStart(data);
        };
        ft._loadAllFormData(function () {
            try {
                player.system.secretBox = window.Alloy2581Core;
                player.system.init();
                player.dbHeader.readHeader();
                player.id = player.dbHeader.getSelectHeader();
                player.dbFile.init(player.id, undefined, function () {
                    try {
                        player.initFromDBFile(player, player.saveId);
                        player.createSid();
                        player.playerLoadOver();
                        player.initManagers(player.ManagerOrderKeys);
                        player._running = true;
                        player._oldTick = ft.getSysMilli();
                        // Original Player.playerInit non-migration/local fields. No legacy account import or channel HTTP override.
                        if (player.device !== player.deviceId) player.device = player.deviceId;
                        player.pointRate = ft.value.number.hundred;
                        if (player.oldVer === 0) player.oldVer = -1;
                        player.nick = player.nick.replace(/[\r\n]/g, '');
                        player.tickTotalGameDt = 0;
                        player.initTouch = true;
                        player._updateSecond = 0;
                        if (!player.firstVersion) player.firstVersion = player.oldVer > 0 ? 1000 : ft.getVersion();
                        // Only the original once-only Manager.start leg; no readHotCode or authenticated allowRunCode.
                        if (!player.system.isStart) {
                            player.system.isStart = true;
                            if (player.code('1') !== 1) {
                                player.dbFile.ERROR = true;
                                player._running = false;
                                throw new Error('The original core DSL algorithms are required before Manager.start; refusing an invalid new-game save');
                            }
                            Object.keys(player.ManagerKeys).forEach(function (name) { player[name].start(); });
                        }
                        player._checkStart();
                        // Deliver original ck/c1/c2 from actual defineVar state before any LayoutMain reads it.
                        player.tick();
                        ftc.ManagerData.open = true;
                        ftc.ManagerData.sid = player.sid;
                        ftc.onLineOk = false;
                        scene.isLoaded = true;
                        scene.mainLoop = window.setInterval(function () { player.tick(); }, 0);
                        prepareResources(scene, function () {
                            ftc.ManagerRes.newLayout('LayoutMain', function () {
                                scene.nodeWait.active = false;
                                console.log('[ALLOY2581_LOCAL_READY] ste=' + player.ste + ' managers=' + Object.keys(player.ManagerKeys).length);
                            });
                        });
                    } catch (error) { fail(error); }
                });
            } catch (error) { fail(error); }
        });
    }

    window.Alloy2581Local = {
        httpConnect: function (method, url, body, callback) {
            if (typeof callback !== 'function') throw new TypeError('A transport callback is required');
            window.setTimeout(function () { callback(false, 'Independent-local remote transport is not configured'); }, 0);
        },
        installLocalMode: function (context) {
            if (installed) throw new Error('The independent-local lifecycle can only be installed once');
            if (!context.ft || !context.fts || !context.ftc) throw new Error('The original runtime globals are required');
            if (!window.Alloy2581Core || typeof window.Alloy2581Core._arithmetic !== 'function' ||
                typeof window.Alloy2581Core._getBaseValue !== 'function') throw new Error('Verified original core algorithms are required');
            var Scene = cc.js.getClassByName('SceneMain');
            if (!Scene) throw new Error('The original SceneMain class is not registered');
            var storage = cc.sys.localStorage;
            // Independent release rules: disable original TEST-gated UI, commands and bypasses without impersonating an SDK source.
            // The original DbFile TEST branches only log; this does not change the selected slot or save encoding.
            context.fts.TEST = false;
            // Game cconfig overrides the base default to true. This is an explicit independent-host platform boundary,
            // not a claim that the original Android game disabled its commercial/protection bridge.
            context.ftc.ActiveNative = false;
            // Original getUserCenter uses this capability flag; an independent host has no account/SDK center.
            // Close it before any original UI reads passport.account, without inventing an authenticated passport.
            context.ftc.openUserCenter = false;
            context.ftc.localMode = {mode: 'independent-local', profile: 'local-production', authenticated: false, remote: 'not-configured'};
            // Preserve the original top-UI resource construction; exclude the separate commercial certification initializer.
            window.ftr.init = function (ready) {
                window.ftr.__nodeTipBuffers = [];
                ftc.ManagerRes.newPart('PartSysTopR', 'PartSysTopR', ftc.scene, function (part) {
                    window.ftr._partTop = part;
                    ftc.scene.node.addChild(part.node, 260);
                    ready();
                });
            };
            Scene.prototype.loading = function () {
                ftc.ManagerData.clean();
                ftc._uiLogs = [];
                ftc._uploadErrors = [];
                ftc._sendPackMsgs = {l: 0};
                ftc._clientPackMsgs = [];
                ftc.__unHandlerMsg = [];
                ftc._sendMsgIndex = 0;
                ftc._forbidSendMsg = false;
                ftc._latestSendMsg = null;
                ftc._serverClose = false;
                ftc._serverReconnectCount = 0;
                ftc.__delaySendMsgs = [];
                ftc._forbidReconnect = true;
                ftc.__uniqueID = 0;
                ftc.ManagerRes.init();
                ftc.ManagerData.load();
                this.stopPlayer();
                this.createPlayer();
            };
            Scene.prototype.createPlayer = function () { initializePlayer(this, storage); };
            installed = true;
        }
    };
}());
