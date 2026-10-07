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
        var result;
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
        result = {
            _datas: pending,
            tick: function (delta) { elapsed += delta; if (elapsed >= 5) { elapsed = 0; flush(); } },
            flush: flush,
            init: function () {},
            sendLog: flush,
            _getTime: function () { return ft.getSysSecond(); }
        };
        ['addLog', 'addDebug', 'addEventLog', 'addActivityLog', 'addActivityLog2', 'addActivityEndDelItemLog'].forEach(function (kind) {
            result[kind] = function () { add(kind, arguments); };
        });
        return result;
    }

    function unavailable(log, operation, args) {
        log.addLog('service-unavailable', operation);
        // No original server entity or response exists. Never synthesize success or rewards.
        var response = {ok: false, status: 'not-configured', local: true, operation: operation};
        var callback = null;
        for (var index = 0; index < args.length; index += 1) {
            if (typeof args[index] === 'function') { callback = args[index]; break; }
        }
        if (callback) window.setTimeout(function () { callback(false, JSON.stringify(response)); }, 0);
        return response;
    }

    function ensureLocalActivityMessages(player) {
        var manager = player && player.ManagerMsg;
        if (!manager || typeof manager.addMsgLocal !== 'function' || typeof ftd === 'undefined' || !ftd.Msg || !ftd.Msg.data) return;
        var supportedUi = {103: true, 109: true, 110: true, 111: true, 118: true};
        Object.keys(ftd.Msg.data).forEach(function (id) {
            // Online messages require the original server-supplied entity, base and ext.
            if (ftd.Msg.get(id, 'updateType')) return;
            var ui = ftd.Msg.get(id, 'ui');
            var values = Array.isArray(ui) ? ui : [ui];
            var type = ftd.Msg.get(id, 'type');
            var isRequiredType = typeof ft !== 'undefined' && ft.type && ft.type.msg &&
                (type === ft.type.msg.pointShop || type === ft.type.msg.vip || type === ft.type.msg.pointRate);
            if (!isRequiredType && !values.some(function (value) { return supportedUi[Number(value)] === true; })) return;
            try {
                manager.addMsgLocal(Number(id));
            } catch (error) {
                console.error('[ALLOY2581_LOCAL_MSG_SKIP] id=' + id + ' ui=' + values.join(',') + ' ' + error.message);
            }
        });
    }

    function localHttp(player, log) {
        var result = {
            capabilities: {mode: 'independent-local', clock: 'local-device', authenticated: false, remote: 'not-configured'},
            getTime: function () { return ft.getSysSecond(); },
            getDay: function () { return ft.toDay(ft.getSysSecond()); },
            getHoliday: function () { return -1; },
            tick: function () { result.lastLocalTick = ft.getSysSecond(); },
            readyTouch: function () { ensureLocalActivityMessages(player); result.lastLocalRollover = ft.toDay(ft.getSysSecond()); return {ok: true, status: 'local', local: true}; },
            log: function (data, kind) { log.addLog('http-log', kind, data); return {ok: true, destination: 'local-log'}; }
        };
        // Keep remote entry points callable, but explicitly reject operations without a server implementation.
        ['init', 'setPassportInfo', 'startGameService', 'touch', 'useCDKey', 'modifyNick',
            'useGiftMoney', 'rewardByTotalPay', 'getActivityCD', 'getActivityCD2', 'addMonsterroomReport',
            'addRankingScore', 'addTowerRanking', 'getBattleReport', 'getMonsterroomHeros',
            'getMonsterroomHerosRandom', 'getMonsterroomInfos', 'getMonsterroomReportList',
            'getRankingList', 'getTowerRankingVal', 'postBattleReport', 'praiseMonsterroom',
            'quitMonsterroom', 'updateMonsterroom', 'updateNickToRanking'].forEach(function (operation) {
            result[operation] = function () { return unavailable(log, operation, arguments); };
        });
        ['post', 'postLogic', '_post', 'handleTouch', 'playerMsg', '_initPreloadData',
            'insertConnect', 'deleteConnect', '_sysAcountResult', '_setPassport'].forEach(function (operation) {
            result[operation] = function () { return unavailable(log, operation, arguments); };
        });
        result.getHostUrl = function () { return ''; };
        result.convertServiceUrl = function () { return ''; };
        return result;
    }

    function installOfflineSessionBoundary(player, log) {
        var originalGetPlayer = player.getPlayer;
        if (typeof originalGetPlayer === 'function') {
            player.getPlayer = function (result, operation, text) {
                var types = ft.type && ft.type.http;
                var sessionOperation = types && ['GetUsrSession', 'CheckUsrSession', 'Touch'].some(function (name) {
                    return types[name] !== undefined && operation === types[name];
                });
                if (result && sessionOperation && !player.dbFile.ERROR) {
                    // Session failure is not save corruption in an unauthenticated local game.
                    log.addLog('offline-session-unavailable', operation, result);
                    player.send('showTip', '离线模式不连接账号服务器，此操作不可用。');
                    return false;
                }
                return originalGetPlayer.apply(this, arguments);
            };
        }
        player.playerExit = function (callback) {
            // Do not invoke original HTTP touch/re-login on local lifecycle exit.
            if (!player.dbFile.ERROR) {
                player.dbFile.tickSave();
                if (typeof ftc._tickLocalStorage === 'function') ftc._tickLocalStorage(1000);
            }
            log.flush();
            if (typeof callback === 'function') callback();
        };
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
                if (window.Alloy2581FullTestSeed && !headers.fullTestSlotV2) {
                    var fullSeedId = prefix + 'slot-' + headers.next;
                    if (storage.getItem(fullSeedId)) throw new Error('Full test slot exists; refusing overwrite');
                    storage.setItem(fullSeedId, '*01' + JSON.stringify(window.Alloy2581FullTestSeed));
                    headers.next++;
                    headers.list.push(fullSeedId);
                    headers.sel = fullSeedId;
                    headers.fullTestSlotV2 = fullSeedId;
                    save();
                    console.log('[ALLOY2581_FULL_TEST_SEED] created=' + fullSeedId);
                }
                if (window.Alloy2581TestLevel === 300 && !headers.level300Slot) {
                    // Explicit test fixture using original Player.SaveKeys and DbFile *01 format.
                    // Preserve every existing slot; never change recharge, currency or quest state.
                    var seedId = prefix + 'slot-' + headers.next;
                    if (storage.getItem(seedId)) throw new Error('Test seed slot already exists; refusing overwrite');
                    storage.setItem(seedId, '*01' + JSON.stringify({syn: 1,
                        data: {'00': {'9': 300, 'f': 0, 'a': '离线300级测试'}}, d1: {}, d2: {}, dt1: {}}));
                    headers.next++;
                    headers.list.push(seedId);
                    headers.sel = seedId;
                    headers.level300Slot = seedId;
                    save();
                    console.log('[ALLOY2581_LEVEL300_SEED] created=' + seedId);
                }
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
        installOfflineSessionBoundary(player, log);
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
                        if (window.Alloy2581FullTestSeed) {
                            var testHeader = JSON.parse(storage.getItem(prefix + 'header'));
                            if (testHeader.fullTestSlotV2 === player.id) {
                                // Explicit QA-only replenishment after original startup normalization.
                                // Never applies to ordinary/previous saves or changes paid eligibility.
                                Object.keys(player.ManagerItem.items).forEach(function (id) {
                                    player.ManagerItem.items[id].num = 99999;
                                });
                                Object.keys(player.ManagerEquip.equips).forEach(function (id) {
                                    player.ManagerEquip.equips[id].num = 60;
                                });
                                Object.keys(player.ManagerCore.cores).forEach(function (id) {
                                    player.ManagerCore.cores[id].lv = 5;
                                });
                                player.ManagerCore.tuanDuiHeXinLv = 50;
                                player.dbFile.tickSave();
                                if (typeof ftc._tickLocalStorage === 'function') ftc._tickLocalStorage(1000);
                                console.log('[ALLOY2581_FULL_TEST_READY] ' + JSON.stringify({
                                    items: Object.keys(player.ManagerItem.items).length,
                                    itemQuantity: 99999, equipment: Object.keys(player.ManagerEquip.equips).length,
                                    equipmentQuantity: 60, cores: Object.keys(player.ManagerCore.cores).length,
                                    coreLevel: 5, teamCoreLevel: player.ManagerCore.tuanDuiHeXinLv,
                                    roles: Object.keys(player.ManagerRole.roles).length
                                }));
                            }
                        }
                        ensureLocalActivityMessages(player);
                        player._checkStart();
                        // Deliver original ck/c1/c2 from actual defineVar state before any LayoutMain reads it.
                        player.tick();
                        ftc.ManagerData.open = true;
                        ftc.ManagerData.sid = player.sid;
                        ftc.onLineOk = false;
                        scene.isLoaded = true;
                        scene.mainLoop = window.setInterval(function () { player.tick(); }, 0);
                        scene.__alloySaveEnsure = window.setInterval(function () {
                            var layout = ftc.ManagerRes.findLayout && ftc.ManagerRes.findLayout('LayoutPlayerInfo');
                            if (layout) ensureLocalSaveSwitcher(layout);
                        }, 1000);
                        prepareResources(scene, function () {
                            ftc.ManagerRes.newLayout('LayoutMain', function (layout) {
                                scene.nodeWait.active = false;
                                console.log('[ALLOY2581_LOCAL_READY] ste=' + player.ste + ' managers=' + Object.keys(player.ManagerKeys).length);
                            });
                        });
                    } catch (error) { fail(error); }
                });
            } catch (error) { fail(error); }
        });
    }

    function localSaveSlots() {
        var player = ftc.player;
        if (!player || !player.dbHeader) return [];
        var selected = player.dbHeader.getSelectHeader();
        return player.dbHeader.getAllHeaders().map(function (id, index) {
            return {id: id, index: index + 1, selected: id === selected};
        });
    }

    function reloadLocalSave(id) {
        var player = ftc.player;
        if (!player || !player.dbHeader || !player.dbHeader.setSelectHeader(id)) return false;
        if (player.dbFile && typeof player.dbFile.tickSave === 'function') player.dbFile.tickSave();
        if (cc.director && typeof cc.director.loadScene === 'function') {
            cc.director.loadScene(ftc.localLaunchScene || 'original/SceneMain');
        } else if (ftc.scene && typeof ftc.scene.loading === 'function') {
            window.setTimeout(function () { ftc.scene.loading(); }, 0);
        }
        return true;
    }

    function createLocalSave() {
        var player = ftc.player;
        if (!player || !player.dbHeader || typeof player.dbHeader.createHeader !== 'function') return null;
        var id = player.dbHeader.createHeader();
        reloadLocalSave(id);
        return id;
    }

    function drawLocalButton(node, text, width, height) {
        node.setContentSize(width, height);
        node.active = true;
        var graphics = node.addComponent(cc.Graphics);
        graphics.fillColor = cc.color(65, 48, 35, 245);
        graphics.roundRect(-width / 2, -height / 2, width, height, 8);
        graphics.fill();
        var labelNode = new cc.Node('Label_' + text);
        labelNode.setPosition(cc.v2(0, 0));
        var label = labelNode.addComponent(cc.Label);
        label.string = text;
        label.fontSize = 22;
        label.lineHeight = height;
        labelNode.color = cc.color(255, 255, 255, 255);
        node.addChild(labelNode);
        node.zIndex = 1;
        return node;
    }

    function openLocalSavePanel(layout) {
        layout.__alloySavePanelClosed = false;
        var panel = new cc.Node('OfflineSavePanel');
        panel.setContentSize(620, 470);
        panel.setPosition(cc.v2(568, 320));
        panel.zIndex = 1000;
        var background = panel.addComponent(cc.Graphics);
        background.fillColor = cc.color(28, 24, 20, 248);
        background.roundRect(-310, -235, 620, 470, 14);
        background.fill();
        if (cc.BlockInputEvents) panel.addComponent(cc.BlockInputEvents);
        var titleNode = new cc.Node('OfflineSaveTitle');
        var title = titleNode.addComponent(cc.Label);
        title.string = '离线存档';
        title.fontSize = 30;
        title.lineHeight = 42;
        titleNode.setPosition(cc.v2(0, 190));
        panel.addChild(titleNode);
        localSaveSlots().forEach(function (slot, index) {
            var button = drawLocalButton(new cc.Node('OfflineSaveSlot' + slot.index), '存档' + slot.index + (slot.selected ? '（当前）' : ''), 380, 46);
            button.setPosition(cc.v2(0, 125 - index * 58));
            button.on(cc.Node.EventType.TOUCH_END, function () {
                if (reloadLocalSave(slot.id)) { layout.__alloySavePanel = null; layout.__alloySavePanelClosed = true; panel.removeFromParent(); }
            });
            panel.addChild(button);
        });
        var create = drawLocalButton(new cc.Node('OfflineSaveCreate'), '新建存档', 180, 44);
        create.setPosition(cc.v2(-105, -190));
        create.on(cc.Node.EventType.TOUCH_END, function () { createLocalSave(); layout.__alloySavePanel = null; layout.__alloySavePanelClosed = true; panel.removeFromParent(); });
        panel.addChild(create);
        var close = drawLocalButton(new cc.Node('OfflineSaveClose'), '关闭', 180, 44);
        close.setPosition(cc.v2(105, -190));
        close.on(cc.Node.EventType.TOUCH_END, function () { layout.__alloySavePanel = null; layout.__alloySavePanelClosed = true; panel.removeFromParent(); });
        panel.addChild(close);
        layout.node.addChild(panel);
        layout.__alloySavePanel = panel;
    }

    function findLocalNode(root, name) {
        if (!root) return null;
        if (root.name === name) return root;
        var children = root.children || [];
        for (var index = 0; index < children.length; index += 1) {
            var result = findLocalNode(children[index], name);
            if (result) return result;
        }
        return null;
    }

    function setLocalButtonText(root, text) {
        if (!root) return false;
        var changed = false;
        var label = root.getComponent && root.getComponent(cc.Label);
        if (label) { label.string = text; changed = true; }
        var children = root.children || [];
        for (var index = 0; index < children.length; index += 1) changed = setLocalButtonText(children[index], text) || changed;
        return changed;
    }

    function ensureLocalSaveSwitcher(layout) {
        var layoutName = layout && (layout._layoutName || layout.name || (layout.node && layout.node.name));
        if (!layout || !layout.node || layoutName !== 'LayoutPlayerInfo' || layout.node.__alloySaveButton) return;
        var button = layout.buttonSave && layout.buttonSave.node;
        if (!button) button = findLocalNode(layout.node, 'ButtonSave');
        if (!button) return;
        button.name = 'ButtonSaveOffline';
        setLocalButtonText(button, '存档');
        console.log('[ALLOY2581_SAVE_BUTTON] layout=' + layoutName + ' node=' + button.name);
        var openFromSave = function (event) {
            if (event && event.stopPropagationImmediate) event.stopPropagationImmediate();
            else if (event && event.stopPropagation) event.stopPropagation();
            if (event && event.type === cc.Node.EventType.TOUCH_END) openLocalSavePanel(layout);
        };
        button.on(cc.Node.EventType.TOUCH_START, openFromSave, null, true);
        button.on(cc.Node.EventType.TOUCH_END, openFromSave, null, true);
        button.__alloySaveTouchHook = true;
        layout.__alloySaveButton = button;
        layout.node.__alloySaveButton = button;
    }

     window.Alloy2581Local = {
        httpConnect: function (method, url, body, callback) {
            if (typeof callback !== 'function') throw new TypeError('A transport callback is required');
            window.setTimeout(function () { callback(false, 'Independent-local remote transport is not configured'); }, 0);
            return false;
        },
        listSaveSlots: localSaveSlots,
        switchSaveSlot: reloadLocalSave,
        createSaveSlot: createLocalSave,
        ensureSaveSwitcher: ensureLocalSaveSwitcher,
        openSavePanel: function () {
            var layout = ftc.ManagerRes.findLayout && ftc.ManagerRes.findLayout('LayoutPlayerInfo');
            if (!layout && ftc.ManagerRes.topLayout) layout = ftc.ManagerRes.topLayout();
            if (!layout) return false;
            openLocalSavePanel(layout);
        },
        installLocalMode: function (context) {
            if (installed) throw new Error('The independent-local lifecycle can only be installed once');
            if (!context.ft || !context.fts || !context.ftc) throw new Error('The original runtime globals are required');
            if (!window.Alloy2581Core || typeof window.Alloy2581Core._arithmetic !== 'function' ||
                typeof window.Alloy2581Core._getBaseValue !== 'function') throw new Error('Verified original core algorithms are required');
            var Scene = cc.js.getClassByName('SceneMain');
            if (!Scene) throw new Error('The original SceneMain class is not registered');
            var storage = cc.sys.localStorage;
            context.ftc.localLaunchScene = context.settings && context.settings.launchScene;
            // Independent release rules: disable original TEST-gated UI, commands and bypasses without impersonating an SDK source.
            // The original DbFile TEST branches only log; this does not change the selected slot or save encoding.
            context.fts.TEST = false;
            // Game cconfig overrides the base default to true. This is an explicit independent-host platform boundary,
            // not a claim that the original Android game disabled its commercial/protection bridge.
            context.ftc.ActiveNative = false;
            // Original getUserCenter uses this capability flag; an independent host has no account/SDK center.
            // Close it before any original UI reads passport.account, without inventing an authenticated passport.
            context.ftc.openUserCenter = false;
            // No delegating network links to external browser/apps in the offline host.
            cc.sys.openURL = function () { context.ftc.showTip('离线版不打开网络链接。'); return false; };
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
