import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../native-host/js/engine-boot.js', import.meta.url), 'utf8');

function fixture() {
  const calls = [];
  const callbacks = {};
  const settings = {
    jsList: ['assets/develop/tool/SkeletonExt.js'], hasResourcesBundle: true,
    remoteBundles: [], server: '', bundleVers: {}, launchScene: 'original/SceneMain',
    orientation: 'landscape', debug: false, groupList: [], collisionMatrix: [],
  };
  const scene = { origin: 'test-only-scene' };
  const originalBundle = {
    getSceneInfo: (path) => path === settings.launchScene,
    loadScene(path, option, progress, callback) {
      calls.push(['loadScene', path, option, progress]);
      callbacks.scene = () => callback(null, scene);
    },
  };
  const window = { jsb: {}, _CCSettings: settings, ft: {}, fts: {}, ftc: {} };
  const cc = {
    macro: { ORIENTATION_LANDSCAPE: 0 }, sys: { isMobile: false },
    debug: { DebugMode: { INFO: 1, ERROR: 2 } },
    AssetManager: { BuiltinBundleName: { INTERNAL: 'internal', RESOURCES: 'resources', MAIN: 'main' } },
    assetManager: {
      init(options) { calls.push(['assetManager.init', options]); },
      loadScript(paths, callback) { calls.push(['loadScript', Array.from(paths)]); callbacks.script = callback; },
      loadBundle(name, callback) { calls.push(['loadBundle', name]); callbacks[name] = callback; },
      bundles: { find(predicate) { return predicate(originalBundle) ? originalBundle : undefined; } },
    },
    view: {
      enableRetina(value) { calls.push(['retina', value]); },
      resizeWithBrowserSize(value) { calls.push(['resize', value]); },
    },
    game: { run(options, onStart) { calls.push(['game.run', options]); onStart(); } },
    director: { runSceneImmediate(value) { calls.push(['runScene', value]); } },
  };
  vm.runInNewContext(source, {
    window, cc, CC_PHYSICS_BUILTIN: false, CC_PHYSICS_CANNON: false,
    require(path) { calls.push(['require', path]); },
  }, { filename: 'project-native-engine-boot.js' });
  const integration = {
    httpConnect() { throw new Error('A unit test must not request any service'); },
    installLocalMode(context) { calls.push(['installLocalMode', context]); },
  };
  const failures = [];
  const launched = [];
  return { window, cc, settings, calls, callbacks, integration, failures, launched,
    start() { window.Alloy2581Boot(integration, (value) => launched.push(value), (error) => failures.push(error)); } };
}

test('normal JSB preserves original script/internal/resources barrier and installs local mode before SceneMain', () => {
  const f = fixture();
  f.start();
  assert.deepEqual(f.calls.filter(([name]) => name === 'require').map(([, path]) => path), [
    'src/settings.js', 'src/cocos2d-jsb.js', 'jsb-adapter/jsb-engine.js',
  ]);
  assert.deepEqual(f.calls.find(([name]) => name === 'loadScript')[1], ['src/assets/develop/tool/SkeletonExt.js']);
  f.callbacks.script(null);
  f.callbacks.resources(null);
  assert.equal(f.callbacks.main, undefined);
  f.callbacks.internal(null);
  assert.equal(typeof f.callbacks.main, 'function');
  f.callbacks.main(null);
  const installIndex = f.calls.findIndex(([name]) => name === 'installLocalMode');
  const runIndex = f.calls.findIndex(([name]) => name === 'game.run');
  assert.ok(installIndex >= 0 && installIndex < runIndex);
  assert.equal(f.calls[runIndex][1].frameRate, 60);
  f.callbacks.scene();
  assert.equal(f.launched.length, 1);
  assert.equal(f.failures.length, 0);
  assert.equal(f.window.ft.httpConnect, f.integration.httpConnect);
});

test('script failure is not replaced with an empty extension or a successful load leg', () => {
  const f = fixture();
  f.start();
  f.callbacks.script(new Error('actual native require failed'));
  f.callbacks.internal(null);
  f.callbacks.resources(null);
  assert.equal(f.failures.length, 1);
  assert.match(f.failures[0].message, /native require failed/);
  assert.equal(f.callbacks.main, undefined);
  assert.equal(f.launched.length, 0);
});

test('missing real local integration and original remote bundles are refused before launch', () => {
  const f = fixture();
  assert.throws(() => f.window.Alloy2581Boot({}, () => {}, () => {}), /real local-mode/);
  f.settings.remoteBundles.push('remote-source');
  assert.throws(() => f.start(), /separately configured project service/);
  assert.equal(f.calls.some(([name]) => name === 'game.run'), false);
});

test('local-mode installation failure cannot run the original authenticated scene', () => {
  const f = fixture();
  f.integration.installLocalMode = () => { throw new Error('local identity is unavailable'); };
  f.start();
  f.callbacks.internal(null); f.callbacks.resources(null); f.callbacks.script(null); f.callbacks.main(null);
  assert.equal(f.failures.length, 1);
  assert.equal(f.calls.some(([name]) => name === 'game.run'), false);
});
