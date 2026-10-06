import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';

// This file parses original JavaScript. It never imports/evaluates that JavaScript.
const root = path.resolve(process.argv[2]);
const hash = text => createHash('sha256').update(text).digest('hex');
const load = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const writeNew = (relative, value) => {
  const data = JSON.stringify(value, null, 2) + '\n';
  const filename = path.join(root, relative);
  if (fs.existsSync(filename)) {
    if (fs.readFileSync(filename, 'utf8') !== data) throw new Error(`Existing output differs: ${relative}`);
  } else fs.writeFileSync(filename, data);
};
function walk(node, fn) {
  fn(node);
  for (const value of Object.values(node)) {
    if (value?.type) walk(value, fn);
    else if (Array.isArray(value)) for (const item of value) if (item?.type) walk(item, fn);
  }
}
function member(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'ThisExpression') return 'this';
  if (node?.type !== 'MemberExpression') return null;
  const object = member(node.object);
  const property = node.computed ? node.property.type === 'Literal' ? node.property.value : null : node.property.name;
  return object && property !== null ? `${object}.${property}` : null;
}
function evidence(source, text, node) {
  return { source, sourceSha256: hash(text), byteRange: [Buffer.byteLength(text.slice(0, node.start)), Buffer.byteLength(text.slice(0, node.end))], rangeSha256: hash(text.slice(node.start, node.end)), offsets: 'UTF-8 bytes; end exclusive' };
}
function decodedSafe(text) {
  const ast = parse(text, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
  const replacements = [];
  walk(ast, n => {
    if (n.type === 'Literal' && typeof n.value === 'string') replacements.push({ start: n.start, end: n.end, value: JSON.stringify(n.value) });
    else if (n.type === 'BinaryExpression' && n.operator === '^' && n.left.type === 'Literal' && n.right.type === 'Literal' && typeof n.left.value === 'number' && typeof n.right.value === 'number') replacements.push({ start: n.start, end: n.end, value: String(n.left.value ^ n.right.value) });
  });
  let output = '', cursor = 0;
  for (const replacement of replacements.sort((a, b) => a.start - b.start)) {
    if (replacement.start < cursor) continue;
    output += text.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return output + text.slice(cursor);
}
const startupPath = 'decoded/startup.main.js';
const startup = load(startupPath);
if (hash(startup) !== '9ec778dcda12bf49f043e1ab3e3279c6f380315c12b28646bf61ae201b267adc') {
  throw new Error('Wrong pinned startup source');
}
const ast = parse(startup, { ecmaVersion: 'latest' });
let boot;
walk(ast, n => { if (n.type === 'AssignmentExpression' && member(n.left) === 'window.boot') boot = n.right; });
if (!boot || boot.type !== 'FunctionExpression') throw new Error('Original boot function missing');
const bootNodes = boot.body.body;
const transportStart = bootNodes.findIndex(n => n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === '_0x155f55'));
const intervalIndex = bootNodes.findIndex(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' && member(n.expression.callee) === 'window.setInterval');
if (transportStart < 0 || intervalIndex < transportStart) throw new Error('Unrecognized adapter boundary');
const safeNodes = [...bootNodes.slice(0, transportStart), ...bootNodes.slice(intervalIndex + 1), ast.body.at(-1)];
const safeFragments = safeNodes.map(n => ({ ...evidence(startupPath, startup, n), decodedStaticSource: decodedSafe(startup.slice(n.start, n.end)) }));
const adapterNodes = bootNodes.slice(transportStart, intervalIndex + 1);
const adapterEvidence = adapterNodes.map(n => ({ ...evidence(startupPath, startup, n), kind: n.type, literalValuesEmitted: false }));
const index = JSON.parse(load('module-index.json'));
const modules = new Map();
for (const bundle of index.bundles) {
  const text = load(bundle.expanded);
  if (hash(text) !== bundle.outputHash) throw new Error(`Wrong expanded source: ${bundle.bundle}`);
  for (const item of bundle.modules) {
    const code = text.slice(item.start, item.end);
    if (hash(code) !== item.sha256) throw new Error(`Wrong module range: ${item.name}`);
    const moduleAst = parse(`(${code})`, { ecmaVersion: 'latest' }).body[0].expression;
    // Wrapped parse adds one character. Shift the AST back to the containing source.
    walk(moduleAst, n => { n.start += item.start - 1; n.end += item.start - 1; });
    modules.set(`${bundle.bundle}:${item.name}`, { bundle, item, text, ast: moduleAst });
  }
}
function moduleRecord(key) {
  const m = modules.get(key);
  if (!m) throw new Error(`Missing source module: ${key}`);
  return { module: key, ...evidence(m.bundle.expanded, m.text, m.ast), originalContainer: m.bundle.source, originalContainerSha256: m.bundle.sourceHash, dependencies: m.item.dependencies };
}
function assignments(key, wanted) {
  const m = modules.get(key), result = {};
  walk(m.ast, n => {
    const name = n.type === 'AssignmentExpression' ? member(n.left) : null;
    if (wanted.includes(name)) result[name] = { ...evidence(m.bundle.expanded, m.text, n), parameterNames: ['FunctionExpression', 'ArrowFunctionExpression'].includes(n.right.type) ? n.right.params.map(p => p.name) : undefined };
  });
  for (const name of wanted) if (!result[name]) throw new Error(`Missing interface ${key} ${name}`);
  return result;
}
function properties(key, wanted) {
  const m = modules.get(key), result = {};
  walk(m.ast, n => {
    if (n.type === 'Property' && !n.computed && wanted.includes(n.key.name ?? n.key.value) && n.value.type === 'FunctionExpression') {
      const name = n.key.name ?? n.key.value;
      (result[name] ??= []).push({ ...evidence(m.bundle.expanded, m.text, n), parameterNames: n.value.params.map(p => p.name) });
    }
  });
  for (const name of wanted) if (!result[name]) throw new Error(`Missing property ${key} ${name}`);
  return result;
}
// Both bundles eagerly execute their entry arrays, and fts.require also resolves
// computed class names. Preserve evidence for every registered module rather
// than incorrectly treating nested Browserify dependency maps as missing files.
const selected = new Set(modules.keys());
const globals = [];
for (const key of ['main:baseconfig','main:config','main:basesconfig','main:sconfig','resources:basecconfig','resources:cconfig']) {
  const m = modules.get(key);
  walk(m.ast, n => {
    if (n.type === 'AssignmentExpression' && ['window.ft','window.fts','window.ftc','window.ftsdk'].includes(member(n.left))) globals.push({ owner: key, target: member(n.left), rightShape: n.right.type, ...evidence(m.bundle.expanded,m.text,n) });
  });
}
const entryOrders = index.bundles.map(b => {
  const text = load(b.expanded), a = parse(text, { ecmaVersion: 'latest' });
  let entry;
  walk(a, n => { if (n.type === 'CallExpression' && n.arguments[0]?.type === 'ObjectExpression' && n.arguments[0].properties.length > 100 && n.arguments[2]?.type === 'ArrayExpression') entry = n.arguments[2]; });
  if (!entry || !entry.elements.every(n => n.type === 'Literal' && typeof n.value === 'string')) throw new Error('Unknown entry module array');
  return { bundle: b.bundle, ...evidence(b.expanded, text, entry), modules: entry.elements.map(n => n.value) };
});
const loaderPath = 'decoded/jsb-adapter.jsb-engine.js';
const loaderText = load(loaderPath), loaderAst = parse(loaderText, { ecmaVersion: 'latest' });
const loaderFunctions = [];
walk(loaderAst, n => { if (n.type === 'FunctionDeclaration' && ['downloadScript','download','transformUrl'].includes(n.id.name)) loaderFunctions.push({ name: n.id.name, ...evidence(loaderPath,loaderText,n), decodedStaticSource: loaderText.slice(n.start,n.end) }); });
const interfaces = {
  ftClassLoader: assignments('main:basesconfig', ['fts.require','fts.apply','fts.newClass','fts.loadMemoryValues']),
  scene: properties('resources:SceneMain', ['onLoad','createPlayer','loading','_openFirstLayout']),
  clientConfig: assignments('resources:basecconfig', ['ftc._init','ftc._load','ftc._loadCoreData','ftc._checkSign']),
  data: properties('resources:managerdata', ['init','load','clean','startGame','setPassportInfo']),
  player: assignments('main:baseplayer', ['this.init','this.initFromDBFile','this.initManagers','this._newManager','this.defineVar','this.allowRunCode','this.createSid','this._checkStart']),
  playerOverrides: assignments('main:player', ['this.playerLoadOver','this.playerInit','this.playerStart']),
  database: assignments('main:dbfile', ['this.init','this._read','this._write']),
  http: assignments('main:basehttp', ['this.init','this.setPassportInfo','this._post']),
  firstRunItems: assignments('main:manageritem', ['this.init','this.start']),
  firstRunWorld: assignments('main:managerworld', ['this.init','this.start','this.newWorlds']),
};
const report = {
  schemaVersion: 1, versionCode: 2581, originalJsExecuted: false, originalEvalExecuted: false, credentialLiteralValuesEmitted: false,
  method: 'Acorn AST parsing of pinned recovered plaintext. Decode only safe boot literal expressions; all credential/network interval ranges are hashed but their literal values are not emitted. Existing container/table outputs are read-only.',
  startup: { source: startupPath, sha256: hash(startup), boot: evidence(startupPath,startup,boot), safeFragments, adapterEvidence },
  normalJsbBoot: {
    requireOrder: ['src/settings.js','src/cocos2d-jsb.js','jsb-adapter/jsb-engine.js'],
    branch: 'window.jsb truthy and typeof loadRuntime !== "function". Physics conditional exists but both pinned engine flags are false (startup-dependency-supplement.json). Runtime branch requests cocos2d-runtime.js and jsb-adapter/engine/index.js; these are not requirements for normal JSB.',
    sequence: ['window.ftaroHotUpdate = "v" + version; require settings, engine, native adapter; cc.macro.CLEANUP_IMAGE_CACHE=true; window.boot()', 'boot captures window._CCSettings then clears it; cc.assetManager.init({bundleVers,remoteBundles,server})', 'boot installs ft transport wrapper, then schedules a 100ms interval; this precedes the parallel loadScript/loadBundle calls and cannot be silently inherited by an offline host', 'cc.assetManager.loadScript(settings.jsList.map(path => "src/"+path), callback) runs in parallel with internal and resources bundle loads; successful callbacks must total bundle-count+1', 'After all three successes load main bundle; on its success cc.game.run(options,onStart)', 'onStart enables retina and resizing; finds bundle with getSceneInfo(settings.launchScene), calls bundle.loadScene(launchScene,null,progress,callback), then cc.director.runSceneImmediate(scene)'],
    options: { id: 'GameCanvas', frameRate: 60, debugMode: 'settings.debug ? INFO : ERROR', showFPS: 'settings.debug', groupList: 'settings.groupList', collisionMatrix: 'settings.collisionMatrix' },
    launchScene: JSON.parse(load('settings.json')).launchScene,
    loadBarrierErrorBehavior: 'Original script reports error and does not increment successful load counter. Main bundle/game run also requires no error. Do not skip the jsList completion leg.',
  },
  adapterBoundary: {
    transport: 'Original captures window.XMLHttpRequest, replaces cc.loader.getXMLHttpRequest with ftc.sysEnd(), nulls window.XMLHttpRequest/window.ActiveXObject, initializes window.ft={} and ft.httpConnect(method,url,body,callback,binary). Domain rejection clears ftc.scene and calls ftc.sysEnd(). Wrapper callback is (success, responseOrError, status, readyState), timeout 15000ms.',
    periodicRemoteExecution: 'Original setInterval runs every 100ms; counter threshold is 6000 (first request after 6001 ticks). It uses ft.httpConnect, fts.Md5.check, fts.Aes.decrypt and ftc.player.code. This remote-code channel is not necessary to reproduce the cc.assetManager/launchScene boot and must remain outside independent local identity.',
    localIdentityInsertion: 'Explicit independent-local adapter may be installed after original ft/fts globals and class-loader modules are registered, but before SceneMain.createPlayer calls player.init. Preserve original Managers/default initializers; never invent a passport or login/Touch response to reach them.',
  },
  globals, entryOrders, loaderFunctions, interfaces,
  sourceClosure: [...selected].sort().map(moduleRecord),
  sourceClosureScope: 'All 1020 original registered main/resources modules. Entry-array order is exact. Dynamic fts class names resolve through this same registry; nested third-party Browserify maps are not independent APK file requirements.',
  nativeInactiveDependency: { module: 'main:basehttp', dependency: 'iconv-lite', indexedTarget: null, evidenceKey: 'interfaces.http.this._post', branch: 'Only the ftc-false Node/server arm calls iconv-lite.encode and Node HTTP APIs. The ftc-truthy native client arm calls ft.httpConnect. No missing iconv-lite claim for normal JSB.' },
  localManagerInitialization: {
    evidenceKeys: ['interfaces.scene.createPlayer','interfaces.player.this.init','interfaces.player.this.initFromDBFile','interfaces.player.this.initManagers','interfaces.player.this._newManager','interfaces.player.this.allowRunCode','interfaces.database.this.init','interfaces.http.this.init'],
    originalSequence: ['SceneMain.onLoad sets ftc.scene, calls ftc._checkSign when fts truthy, schedules ftc._init(callback) with setTimeout(0)', 'ftc._init calls optional ftc.init, fts.loadMemoryValues(ft,"value") and fts.loadMemoryValues(fts,"value"), ManagerLan.init, ManagerData.init, native ft_c_init if native, then ftr.init(callback) or callback', 'callback calls scene.loading: ManagerData.clean -> ftc._load -> stopPlayer -> ManagerRes.newLayout(ftc.firstViewName="LayoutLoading")', 'scene.createPlayer requires player, constructs it, calls ftc._loadCoreData, then player.init(identity/environment); original supplied identity fields come from ManagerData.passport', 'player constructor fts.apply(this,"BasePlayer") creates system/dbHeader/dbFile/http/serverLog; installs 22 ManagerOrderKeys', 'baseplayer.init sets environment + ManagerKeys, loads form tables, initializes system/serverLog, dbHeader.readHeader(identity.id), dbFile.init(selectedId,identity.data,callback)', 'dbFile reads selected namespace; absent save uses original {syn:1,data:{},d1:{},d2:{}}; initFromDBFile applies each original SaveKeys default; _newManager constructs each original class and calls init(getManagerSaveIds)', 'playerLoadOver and initManagers precede playerInit; then http.init(service,addrlogic,notices,gameData) and _checkStart'],
    closestIndependentInterface: 'baseplayer.init(identity,onReady) is the existing full default-state entry. At the client side SceneMain.createPlayer is its caller and owns tick setup. Supply a separately labeled local identity/local storage namespace, not a ManagerData.passport server claim. The concrete boundary that must be adapted is player.http.setPassportInfo and player.http.init (the latter otherwise invokes msg.getPreloadData). No original all-offline initializer was found.',
    managerStartBoundary: 'baseplayer.allowRunCode() sets system.isStart, may read/execute hot code, and calls every Manager.start(). ManagerItem.start and ManagerWorld.start add original first-run state. Construction/init alone is NOT equivalent to a playable first-run economy. An independent local mode needs an explicit separation of hot-code/auth gates from original Manager.start; do not set ste=0 or forge Touch/Login to invoke it.',
    prohibitedShortcuts: ['No synthesized Login, Touch, preloadData or ManagerData.msg.init success', 'No manufactured passport/token/password/signature', 'No forced ste authentication state', 'No hand-built starting currency/items/roles/map', 'No evaluation of downloaded hot-code or original whole startup script during extraction'],
    unknowns: ['No native ft_c_init/ft_c_call_core/sign getter implementations extracted here; their public entry calls are identified, not replaced.', '[推断] Native core injection may influence system methods/default save encryption. Static manager source is present but runtime closure must be integrated/observed by the main agent.', 'No guarantee that Manager.start alone yields a complete first scene: original playerStart, messages, UI listeners and authenticated timing must be separately adapted for local semantics.', 'Browser/loadRuntime SkeletonExt content is not in this normal-JSB APK; absence in this snapshot is not a universal impossibility result.'],
  },
};
writeNew('startup-interfaces.json', report);
console.log(JSON.stringify({ output: 'startup-interfaces.json', sourceClosureModules: selected.size, safeStartupFragments: safeFragments.length, originalJsExecuted: false, credentialLiteralValuesEmitted: false }));
