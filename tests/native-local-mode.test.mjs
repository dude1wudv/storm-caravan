import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../native-host/js/local-mode.js', import.meta.url), 'utf8');
const prefix = 'alloy-2581-local-v1:';

// Contract mocks execute only project-written JS. Device validation is separately required for original gameplay.
function fixture(initial = new Map(), literalResult = 1, ftd = {}) {
  const storage = { getItem: (key) => initial.get(key) ?? null, setItem: (key, value) => initial.set(key, String(value)) };
  const calls = [];
  const intervals = [];
  const fts = { TEST: true };
  class Scene { stopPlayer() { calls.push('stop'); } }
  class Player {
    constructor() {
      assert.equal(fts.TEST, false, 'original TEST must be disabled before Player construction');
      assert.equal(ftc.openUserCenter, false, 'unconfigured SDK user center must be disabled before original UI initialization');
      this._safetyTest = () => { throw new Error('Independent lifecycle must not enter the original protection core'); };
      this.ManagerOrderKeys = [{ ManagerWorld: 'b' }, { ManagerTask: '5' }];
      this.msg = {};
      this.send = (...args) => calls.push(['send', ...args]);
      this.getPlayer = (...args) => calls.push(['original.getPlayer', ...args]);
      this.system = { init: () => calls.push('system.init') };
      this.dbFile = { tickSave: () => calls.push('tickSave'), init: (id, data, ready) => { calls.push(['db.init', id, data]); ready(); } };
      this.initFromDBFile = () => { Object.assign(this, { ste: 0, sid: '', ver: 0, device: '', oldVer: 0, nick: '', firstVersion: 0 }); };
      this.createSid = () => { this.sid = initial.get(prefix + 'test-sid') || 'test-local-seed'; initial.set(prefix + 'test-sid', this.sid); };
      this.playerLoadOver = () => { if (!this.device) { this.device = this.deviceId; this.ste = 2; } };
      this.initManagers = () => {
        calls.push('initManagers');
        this.ManagerWorld = { start: () => { assert.equal(fts.TEST, false); calls.push('World.start'); } };
        this.ManagerTask = { start: () => { assert.equal(fts.TEST, false); calls.push('Task.start'); } };
      };
      this._checkStart = () => calls.push('check');
      this.tick = () => calls.push('tick/ck/c1/c2');
      this.code = (text) => { assert.equal(text, '1'); return literalResult; };
      this.playerStart = () => calls.push('original.playerStart');
    }
  }
  class Prefab {}
  class SpriteAtlas { getSpriteFrame() { return this.missingFrame ? undefined : { source: 'contract-fixture' }; } }
  const resources = { PartUserRes: new Prefab(), home: new SpriteAtlas() };
  const ft = { type: { http: { GetUsrSession: 'GetUsrSession', CheckUsrSession: 'CheckUsrSession', Touch: 'Touch' } }, bindMsg: () => {}, md5: () => 'test-identity-not-a-credential', getSysSecond: () => 1700000000,
    toDay: (second) => Math.floor(second / 86400), getSysMilli: () => 1700000000000, getVersion: () => 2581,
    _loadAllFormData: (ready) => { assert.equal(fts.TEST, false); calls.push('load-original-tables'); ready(); }, value: { number: { hundred: 100 } } };
  const ftc = { ActiveNative: true, openUserCenter: true, ManagerLan: { getLanguage: () => 'zh' }, getSubSourceId: () => undefined,
    getSourceId: () => 99, getZone: () => 0, isTv: () => false, getBuildVersion: () => 0, getAreaCode: () => '0',
    ManagerData: { clean: () => {}, load: () => {}, passport: {} }, showTip: (text) => calls.push(['tip', text]),
    registDirs: [], registPrefabs: ['part/PartUserRes'], registTextures: ['home'], registAudios: [], registImgs: [],
    ManagerRes: { init: () => {}, newLayout: (name, ready) => { assert.equal(fts.TEST, false); calls.push(['layout', name]); ready(); },
      updateMainLoadingProgress() {}, _loadResource() {}, tick() {}, getResource: (name) => resources[name] } };
  const ftr = {};
  const window = { ftr, __require: (name) => { assert.equal(name, 'player'); return Player; },
    Alloy2581Core: { _arithmetic: () => literalResult, _getBaseValue: () => literalResult },
    setInterval: (callback) => { intervals.push(callback); return intervals.length; }, setTimeout: (callback) => callback() };
  const cc = { js: { getClassByName: (name) => name === 'SceneMain' ? Scene : undefined }, sys: { localStorage: storage },
    director: { loadScene: (name) => calls.push(['loadScene', name]) },
    Prefab, SpriteAtlas, audioEngine: { setMaxAudioInstance: (value) => assert.equal(value, 128) } };
  vm.runInNewContext(source, { window, cc, ft, ftc, fts, ftr, ftd, console: { log() {}, error() {} } });
  window.Alloy2581Local.installLocalMode({ ft, fts, ftc });
  const scene = ftc.scene = new Scene();
  scene.nodeWait = { active: true };
  scene.labelWaitingTip = { string: '' };
  return { initial, window, calls, intervals, scene, ftc, fts, resources, cc,
    finishResources() {
      const manager = ftc.ManagerRes;
      manager.isLoadOver = true; manager._loadingProgress = -1; manager._totalLoadingSize = 0;
      manager._callbackLoadingProgress(1, 0, 'home', 'ready');
    } };
}

test('local initialization preserves new-save ste and source manager order without an authenticated response', () => {
  const f = fixture();
  f.scene.loading();
  assert.equal(f.ftc.ActiveNative, false);
  assert.equal(f.ftc.player.ste, 2);
  assert.equal(f.ftc.player.localMode.authenticated, false);
  assert.equal(f.ftc.onLineOk, false);
  assert.equal(Object.keys(f.ftc.ManagerData.passport).length, 0);
  assert.deepEqual(f.calls.filter((call) => typeof call === 'string'), [
    'stop', 'load-original-tables', 'system.init', 'initManagers', 'World.start', 'Task.start', 'check', 'tick/ck/c1/c2',
  ]);
  f.finishResources();
  assert.equal(f.calls.findIndex((call) => call === 'tick/ck/c1/c2') < f.calls.findIndex((call) => Array.isArray(call) && call[0] === 'layout'), true);
  f.intervals[0](); f.intervals[0]();
  assert.equal(f.calls.filter((call) => call === 'World.start').length, 1);
  assert.equal(f.calls.filter((call) => call === 'Task.start').length, 1);
  f.ftc.player.msg.startGame({});
  assert.equal(f.calls.at(-1), 'original.playerStart');
  assert.equal(f.ftc.player.isStartGame, true);
  assert.equal(f.initial.has('header1'), false);
  assert.equal(f.initial.has(prefix + 'header'), true);
});

test('bad local header stops initialization instead of silently replacing a save', () => {
  const initial = new Map([[prefix + 'header', '{broken-json']]);
  const f = fixture(initial);
  assert.throws(() => f.scene.loading(), /JSON/);
  assert.equal(initial.get(prefix + 'header'), '{broken-json');
  assert.equal(f.calls.includes('initManagers'), false);
});

test('unimplemented remote calls fail explicitly and persist local logs only', () => {
  const f = fixture();
  f.scene.loading();
  f.ftc.player.serverLog.addActivityLog2(9, 7, 1, 1, 1001, 1, 1);
  f.ftc.player.serverLog.addEventLog('offline-check', 1);
  const result = f.ftc.player.http.rewardByTotalPay(999);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not-configured');
  assert.equal(result.local, true);
  assert.equal(f.ftc.player.http.getTime(), 1700000000);
  assert.equal(f.ftc.player.http.capabilities.clock, 'local-device');
  assert.equal(f.ftc.player.http.capabilities.authenticated, false);
  assert.equal(f.ftc.player.http.capabilities.remote, 'not-configured');
  f.ftc.player.serverLog.tick(5);
  const logs = JSON.parse(f.initial.get(prefix + 'logs'));
  assert.equal(logs.at(-1).kind, 'addLog');
  assert.equal(logs.at(-1).values[0], 'service-unavailable');
  let response;
  f.window.Alloy2581Local.httpConnect('GET', 'offline://local-service', null, (ok, message) => { response = [ok, message]; });
  assert.equal(response[0], false);
  assert.match(response[1], /not configured/);
  assert.throws(() => f.window.Alloy2581Local.httpConnect('GET', 'offline://local-service'), /callback/);
});

test('unimplemented purchase, ranking and activity-code operations never acknowledge success', () => {
  const f = fixture();
  f.scene.loading();
  const player = f.ftc.player;
  const before = new Map(f.initial);
  for (const operation of ['useGiftMoney', 'rewardByTotalPay', 'getRankingList', 'getActivityCD', 'getActivityCD2']) {
    let callback;
    const result = player.http[operation](1, (ok, text) => { callback = [ok, JSON.parse(text)]; });
    assert.equal(result.ok, false, operation);
    assert.equal(result.status, 'not-configured', operation);
    assert.equal(callback[0], false, operation);
    assert.equal(callback[1].operation, operation);
    assert.equal(Object.hasOwn(result, 'data'), false, operation);
  }
  assert.deepEqual(f.initial, before);
});

test('original activity award logging contract persists each awarded item locally', () => {
  const f = fixture();
  f.scene.loading();
  const player = f.ftc.player;
  // Original player.addActivityLog delegates each award item to serverLog.addActivityLog2.
  const awardIds = [3001, 3037, 3036];
  const awardNums = [100, 4, 1];
  awardIds.forEach((id, index) => player.serverLog.addActivityLog2(
    9, 7, 1, 1, id, awardNums[index], index === 0 ? 1 : 0));
  player.serverLog.flush();
  const entries = JSON.parse(f.initial.get(prefix + 'logs'));
  assert.deepEqual(entries.map(({ kind, values }) => [kind, ...values]), [
    ['addActivityLog2', 9, 7, 1, 1, 3001, 100, 1],
    ['addActivityLog2', 9, 7, 1, 1, 3037, 4, 0],
    ['addActivityLog2', 9, 7, 1, 1, 3036, 1, 0],
  ]);
});

test('local rollover never materializes an online message from a static template', () => {
  const added = [];
  const rows = {9: {ui: 111, updateType: null}, 61: {ui: 61, updateType: 1}};
  const f = fixture(new Map(), 1, {Msg: {data: rows, get: (id, key) => rows[id][key]}});
  f.scene.loading();
  f.ftc.player.ManagerMsg = {addMsgLocal: (id) => added.push(id)};
  f.ftc.player.http.readyTouch();
  assert.deepEqual(added, [9]);
});
test('local save slots can be created and selected without a remote service', () => {
  const f = fixture();
  f.scene.loading();
  assert.equal(JSON.stringify(f.window.Alloy2581Local.listSaveSlots()), JSON.stringify([{id: prefix + 'slot-1', index: 1, selected: true}]));
  const created = f.window.Alloy2581Local.createSaveSlot();
  assert.equal(created, prefix + 'slot-2');
  assert.equal(JSON.stringify(f.window.Alloy2581Local.listSaveSlots()), JSON.stringify([
    {id: prefix + 'slot-1', index: 1, selected: false},
    {id: prefix + 'slot-2', index: 2, selected: true},
  ]));
  assert.equal(f.window.Alloy2581Local.switchSaveSlot(prefix + 'slot-1'), true);
  assert.equal(JSON.parse(f.initial.get(prefix + 'header')).sel, prefix + 'slot-1');
});

test('original resource terminal state and valid prefab/atlas/frame are required before LayoutMain', () => {
  const f = fixture();
  f.scene.loading();
  f.ftc.ManagerRes._callbackLoadingProgress(1, 0, 'home', 'loading');
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'layout'), false);
  delete f.resources.PartUserRes;
  assert.throws(() => f.finishResources(), /Required original prefab/);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'layout'), false);
});

test('missing original core literal evaluation blocks Manager.start and cannot create a playable save', () => {
  const f = fixture(new Map(), '');
  assert.throws(() => f.scene.loading(), /original core DSL algorithms/);
  assert.equal(f.ftc.player.dbFile.ERROR, true);
  assert.equal(f.ftc.player._running, false);
  assert.equal(f.calls.includes('World.start'), false);
  assert.equal(f.calls.includes('Task.start'), false);
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'layout'), false);
});

test('pre-core project development slots are preserved while a separate source-correct slot is selected once', () => {
  const oldHeader = { sel: prefix + 'slot-1', list: [prefix + 'slot-1'], next: 2 };
  const initial = new Map([[prefix + 'header', JSON.stringify(oldHeader)], [prefix + 'slot-1', 'old-development-bytes']]);
  const f = fixture(initial);
  f.scene.loading();
  const header = JSON.parse(initial.get(prefix + 'header'));
  assert.deepEqual(header.list, [prefix + 'slot-1', prefix + 'slot-2']);
  assert.equal(header.sel, prefix + 'slot-2');
  assert.equal(header.coreDSLVersion, 1);
  assert.equal(initial.get(prefix + 'slot-1'), 'old-development-bytes');
  const restarted = fixture(initial);
  restarted.scene.loading();
  assert.equal(JSON.parse(initial.get(prefix + 'header')).sel, prefix + 'slot-2');
  assert.equal(JSON.parse(initial.get(prefix + 'header')).list.length, 2);
});

test('independent production profile closes original TEST before initialization without faking the source', () => {
  const f = fixture();
  assert.equal(f.fts.TEST, false);
  assert.equal(f.ftc.localMode.profile, 'local-production');
  f.scene.loading();
  f.finishResources();
  assert.equal(f.ftc.player.sourceId, 99);
  assert.equal(f.ftc.player.ste, 2);
  assert.equal(f.ftc.player.localMode.authenticated, false);
  assert.equal(f.ftc.player.localMode.profile, 'local-production');
});

test('production rules retain an already-correct selected slot and save bytes without another migration', () => {
  const header = { sel: prefix + 'slot-2', list: [prefix + 'slot-1', prefix + 'slot-2'], next: 3, coreDSLVersion: 1 };
  const headerBytes = JSON.stringify(header);
  const initial = new Map([[prefix + 'header', headerBytes], [prefix + 'slot-1', 'preserved-old-bytes'],
    [prefix + 'slot-2', 'preserved-original-rule-bytes']]);
  const f = fixture(initial);
  f.scene.loading();
  assert.equal(initial.get(prefix + 'header'), headerBytes);
  assert.equal(initial.get(prefix + 'slot-1'), 'preserved-old-bytes');
  assert.equal(initial.get(prefix + 'slot-2'), 'preserved-original-rule-bytes');
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'db.init' && call[1] === prefix + 'slot-2'), true);
});

test('independent host closes the original SDK user-center capability without fabricating an account', () => {
  const f = fixture();
  assert.equal(f.ftc.openUserCenter, false);
  assert.equal(f.ftc.localMode.authenticated, false);
  f.scene.loading();
  f.finishResources();
  assert.equal(f.ftc.ManagerData.passport.account, undefined);
  assert.equal(f.ftc.ManagerData.passport.uid, undefined);
  assert.equal(f.ftc.openUserCenter, false);
  assert.equal(f.ftc.player.sourceId, 99);
  assert.equal(f.ftc.player.ste, 2);
});

test('offline session errors do not enter forced-login exit, but other errors retain original handling', () => {
  const f = fixture(); f.scene.loading(); const p = f.ftc.player;
  for (const type of ['GetUsrSession', 'CheckUsrSession', 'Touch']) {
    assert.equal(p.getPlayer(1, type, 'network unavailable'), false);
  }
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === 'original.getPlayer'), false);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === 'send' && c[1] === 'showTip').length, 3);
  p.getPlayer(1, 'OtherError', 'keep error');
  assert.deepEqual(f.calls.at(-1), ['original.getPlayer', 1, 'OtherError', 'keep error']);
  p.dbFile.ERROR = true; p.getPlayer(1, 'Touch', 'damaged save');
  assert.deepEqual(f.calls.at(-1), ['original.getPlayer', 1, 'Touch', 'damaged save']);
});

test('local player exit flushes save and logs before callback without remote touch', () => {
  const f = fixture(); f.scene.loading(); const p = f.ftc.player;
  p.http.touch = () => { throw new Error('exit must not request server'); };
  p.serverLog.addLog('exit-evidence');
  p.playerExit(() => { assert.equal(f.calls.at(-1), 'tickSave'); assert.ok(f.initial.has(prefix + 'logs')); });
  p.dbFile.ERROR = true;
  p.dbFile.tickSave = () => { throw new Error('must not save corrupted state'); };
  let done = false; p.playerExit(() => { done = true; }); assert.equal(done, true);
});

test('level-300 test build creates a separate original-format slot once and preserves existing saves', () => {
  const f = fixture();
  const old = '*01{"syn":1,"data":{"00":{"9":12}},"d1":{},"d2":{}}';
  f.initial.set(prefix + 'slot-1', old);
  f.window.Alloy2581TestLevel = 300;
  f.scene.loading();
  const header = JSON.parse(f.initial.get(prefix + 'header'));
  assert.equal(header.sel, prefix + 'slot-2');
  assert.equal(header.level300Slot, header.sel);
  assert.equal(f.initial.get(prefix + 'slot-1'), old);
  const seed = JSON.parse(f.initial.get(header.sel).slice(3));
  assert.equal(seed.data['00']['9'], 300);
  assert.deepEqual(Object.keys(seed.data['00']).sort(), ['9','a','f']);
  f.initial.set(header.sel, 'progress-must-survive');
  f.ftc.player.dbHeader.readHeader();
  assert.equal(f.initial.get(header.sel), 'progress-must-survive');
  assert.equal(JSON.parse(f.initial.get(prefix + 'header')).next, 3);
});

test('offline host cannot launch external network links', () => {
  const f = fixture();
  assert.equal(f.cc.sys.openURL('https://example.invalid'), false);
  assert.equal(f.calls.at(-1)[0], 'tip');
  // The host binding is replaced at install, without invoking an external app.
  assert.equal(f.window.Alloy2581Local.httpConnect('GET', 'https://example.invalid', null, ok => assert.equal(ok, false)), false);
});

test('full test fixture is isolated, selected once and never resets existing progress', () => {
  const f = fixture(); f.window.Alloy2581FullTestSeed = {syn:1, data:{'00':{'9':300}}, d1:{}, d2:{}};
  f.initial.set(prefix + 'slot-1', 'old-save');
  // This test targets header import only; production manager normalization is device-verified.
  f.window.Alloy2581FullTestSeed = undefined;
  f.scene.loading();
  f.window.Alloy2581FullTestSeed = {syn:1, data:{'00':{'9':300}}, d1:{}, d2:{}};
  f.ftc.player.dbHeader.readHeader();
  const header = JSON.parse(f.initial.get(prefix + 'header'));
  assert.equal(header.fullTestSlotV2, header.sel);
  assert.equal(f.initial.get(prefix + 'slot-1'), 'old-save');
  assert.equal(JSON.parse(f.initial.get(header.sel).slice(3)).data['00']['9'], 300);
  f.initial.set(header.sel, 'later-progress');
  f.ftc.player.dbHeader.readHeader();
  assert.equal(f.initial.get(header.sel), 'later-progress');
  assert.equal(JSON.parse(f.initial.get(prefix + 'header')).next, header.next);
});
