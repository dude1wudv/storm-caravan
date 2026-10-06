import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse } = require('acorn');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../../..');
const dir = path.join(root, 'reports/private/reconstruction/2581/flow-recovery');
const tableFile = path.join(root, 'reports/private/reconstruction/2581/client-recovery/tables.decoded.json');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const tables = JSON.parse(fs.readFileSync(tableFile, 'utf8'));
const sha = source => crypto.createHash('sha256').update(source).digest('hex');
const rel = file => path.relative(root, file).replaceAll('\\', '/');
const save = (file, value) => {
  const content = JSON.stringify(value, null, 2) + '\n';
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.writeFileSync(file, content);
};
const member = n => {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'ThisExpression') return 'this';
  if (n.type === 'Literal') return String(n.value);
  if (n.type === 'MemberExpression') {
    const a = member(n.object), b = member(n.property);
    return a && b ? a + (n.computed ? '[' + b + ']' : '.' + b) : null;
  }
  return null;
};
function walk(node, callback, ancestors = []) {
  if (!node?.type) return;
  callback(node, ancestors);
  const next = [...ancestors, node];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, callback, next);
    else if (value && typeof value === 'object') walk(value, callback, next);
  }
}
function constant(n) {
  if (n.type === 'Literal') return n.value;
  if (n.type === 'ArrayExpression') return n.elements.map(constant);
  if (n.type === 'ObjectExpression') return Object.fromEntries(n.properties.map(p => [member(p.key), constant(p.value)]));
  if (n.type === 'UnaryExpression') {
    if (n.operator === '-') return -constant(n.argument);
    if (n.operator === '!') return !constant(n.argument);
    if (n.operator === 'void') return null;
  }
  throw new Error(`Nonliteral schema expression ${n.type}`);
}
function functionLabel(n, ancestors) {
  const p = ancestors.at(-1);
  if (p?.type === 'AssignmentExpression') return member(p.left);
  if (p?.type === 'VariableDeclarator') return member(p.id);
  if (p?.type === 'FunctionDeclaration') return p.id?.name;
  if (p?.type === 'Property') {
    const segments = [member(p.key)];
    for (let i = ancestors.length - 2; i >= 0; i--) {
      const a = ancestors[i];
      if (a.type === 'Property') segments.unshift(member(a.key));
      if (a.type === 'AssignmentExpression') { segments.unshift(member(a.left)); break; }
      if (/Function/.test(a.type)) break;
    }
    return segments.filter(Boolean).join('.');
  }
  return n.id?.name || null;
}
const symbols = {}, schemas = {};
for (const module of manifest.modules) {
  if (!module.expanded) throw new Error('Run extract.mjs after string-table recovery.');
  const source = fs.readFileSync(path.join(root, module.expanded.path), 'utf8');
  const ast = parse('(' + source + ')', { ecmaVersion: 'latest' });
  const key = `${module.bundle}/${module.key}`;
  symbols[key] = { path: module.expanded.path, sha256: sha(source), functions: [], tableAccesses: [] };
  const tableAccesses = [];
  walk(ast, (n, ancestors) => {
    if (n.type === 'AssignmentExpression' && member(n.left) === 'this.SaveKeys') {
      schemas[key] = { path: module.expanded.path, expressionRange: [n.right.start - 1, n.right.end - 1], expressionSha256: sha(source.slice(n.right.start - 1, n.right.end - 1)), fields: constant(n.right) };
    }
    if (n.type === 'AssignmentExpression' && member(n.left) === 'this.ManagerOrderKeys') {
      schemas.managerOrder = { path: module.expanded.path, expressionRange: [n.right.start - 1, n.right.end - 1], value: constant(n.right) };
    }
    if (n.type === 'CallExpression' && member(n.callee)?.startsWith('ftd.') && n.arguments[1]?.type === 'Literal') {
      tableAccesses.push({ call: member(n.callee), field: n.arguments[1].value, moduleRange: [n.start - 1, n.end - 1] });
    }
    if (['FunctionExpression', 'FunctionDeclaration', 'ArrowFunctionExpression'].includes(n.type)) {
      const label = functionLabel(n, ancestors);
      if (!label) return;
      const calls = new Set();
      walk(n.body, child => { if (child.type === 'CallExpression' && member(child.callee)) calls.add(member(child.callee)); });
      symbols[key].functions.push({ symbol: label, moduleRange: [n.start - 1, n.end - 1], sha256: sha(source.slice(n.start - 1, n.end - 1)), parameters: n.params.map(member), calls: [...calls] });
    }
  });
  symbols[key].tableAccesses = tableAccesses;
}
const ref = (key, symbol) => {
  const module = symbols[key];
  const f = module?.functions.find(f => f.symbol === symbol || f.symbol.endsWith('.' + symbol));
  if (!f) throw new Error(`Missing source function ${key}:${symbol}`);
  return { module: key, symbol: f.symbol, moduleRange: f.moduleRange };
};
const row = (table, id) => {
  if (!tables[table]?.data[id]) throw new Error(`Missing source record ${table}/${id}`);
  return { ...tables[table].defaults, ...tables[table].data[id] };
};
const tableRef = (table, id, field) => ({ table, id: String(id), field, source: rel(tableFile), pointer: `/${table}/data/${id}${field ? '/' + field : ''}`, defaultsPointer: `/${table}/defaults`, recordSha256: sha(JSON.stringify(tables[table].data[id])) });
const initialTables = {};
const include = (table, ids) => {
  initialTables[table] = { defaults: tables[table].defaults, data: Object.fromEntries(ids.map(id => [id, tables[table].data[id]])), sources: ids.map(id => tableRef(table, id)) };
};
include('World', [1]);
include('Task', [100, 101, 102, 103, 104]);
include('Event', Object.keys(tables.Event.data).filter(id => [100, 101, 102, 103, 104].includes(row('Event', id).task)));
include('Map', [2102, 2103, 2104]);
const mapnpcIds = Object.keys(tables.Mapnpc.data).filter(id => [2102, 2103, 2104].includes(row('Mapnpc', id).Map));
include('Mapnpc', mapnpcIds);
include('Npc', [...new Set(mapnpcIds.map(id => row('Mapnpc', id).Npc))].filter(id => tables.Npc.data[id]));
include('Item', [215, 102, 1, 3000, 5, 1619]);
include('Role', [215, 102, 1, 5]);
include('Battle', [2, 10101, 150101]);
include('Award', [121, 124]);
include('Code', [2]);
const sourceEvidence = { path: rel(tableFile), sha256: sha(fs.readFileSync(tableFile)), extraction: 'Read peer static recovered keys/defaults/data. Copy exact selected original sparse rows and defaults; merge defaults only for analysis; no game execution.' };
save(path.join(dir, 'initial-scenario.json'), { baseline: 2581, sourceEvidence, tables: initialTables });
save(path.join(dir, 'save-schema.json'), { baseline: 2581, method: 'AST literal extraction of original SaveKeys assignment: each field value [serializedShortKey, default]. No evaluation of constructors.', symbolEvidence: 'symbols-expanded.json holds full source path, function range and hash for each reference.', schemas, persistence: { header: 'DbHeader -> cc.sys.localStorage under header + ft.getAppId()', records: 'DbFile._dataBuffers.{syn,data,d1,d2,dt1}; entity/manager fields keyed by SaveKeys short keys. Raw in-memory property names are not the serialized schema.', writeBoundary: 'DbFile.tickSave -> _write -> player._readyWriteString; resources/basecconfig ftc._tickLocalStorage commits it to cc.sys.localStorage using dbFile._playerId.', refs: [ref('main/dbheader', 'this.readHeader'), ref('main/dbheader', 'this.createHeader'), ref('main/dbfile', 'this.init'), ref('main/baseplayer', 'this.initFromDBFile'), ref('main/baseplayer', 'this._defineSetAndGet'), ref('main/dbfile', 'this._read'), ref('main/dbfile', 'this._write'), ref('main/dbfile', 'this.tickSave'), ref('resources/basecconfig', 'ftc._tickLocalStorage')] } });
save(path.join(dir, 'symbols-expanded.json'), symbols);
const step = (id, boundary, refs, dependencies, facts) => ({ id, boundary, sourceFunctions: refs.map(([m, s]) => ref(m, s)), dependencies, facts });
const flow = {
  baseline: 2581,
  evidenceLevel: 'Original recovered 2581 code/data; static call/property/control-flow observation, not device/runtime acceptance.',
  symbolEvidence: 'symbols-expanded.json holds source path, module-relative UTF-16 function range, SHA-256 and calls; manifest.json maps complete modules to original decoded bundle ranges/hashes.',
  sourceEvidence,
  conclusion: {
    originalColdStartWithoutAccountOrServer: 'New local defaults can be constructed, and failed GetPreloadData still starts managers; original first-entry platform/account gate does not allow a fresh ste=2 save to enter on login/touch failure. Original offline success is not proven and must not be fabricated.',
    originalGameplayInitialState: 'Recovered locally: World 1, Task/Event 100, items/roles 215,102,1,3000, team placements, map 2102 point 33 dir 1, tutorial battle 2; after tutorial original Event100 grants role/item5. These are original Event.c_work statements, not server-provided starter assignments.',
    adaptationBoundary: 'User-authorized independent local identity/save bootstrap is a project adapter, not original login behavior. It may invoke the original default-manager/gameplay initialization without forged login payloads or pretending original ste=2 passed certification.',
    firstNormalPlayableLoop: 'Task101/Event101 -> crash NPC11105 on map2102 -> Battle10101 + Award121 (difficulty branch Battle150101/Award124) -> Code2 common settlement -> LayoutBattleResult callback -> Event101 continuation -> Task102. Tutorial battle2 is a separate special flow and must not receive invented generic rewards.'
  },
  starterInputs: {
    interpretation: 'Original literal defaults/calls below are statically observed; their full runtime outcome has not been executed.',
    localDefaults: { player: { lv: 1, exp: 0, world: 1 }, ManagerWorld: { cur: 1 }, World: { time: 0, ste: 0, isDifficulty: 0 }, Role: { lv: 1, star: 1, hp: 100, mp: 'Role.init -> resetMp -> getValue(danyao)', pos1: 0 } },
    initialRoleIds: [215, 102, 1],
    initialBagItemId: 3000,
    event100LiteralCalls: ['addItem:[215,102,1,3000],[1,1,1,1]', 'moveRole:215,2,1', 'moveRole:102,1,1', 'moveRole:1,1,1', 'delivery:2102,33,1', 'openBattle:2,0,0', 'addItem:5,1'],
    exactSources: [tableRef('Event',100,'c_work'), tableRef('Item',215,'itemType'), tableRef('Item',102,'itemType'), tableRef('Item',1,'itemType'), tableRef('Item',5,'itemType')],
    roleInitialization: [ref('main/managerrole','this.addRole'), ref('main/role','this.init'), ref('main/role','this.resetMp'), ref('main/extrole','ft.ExtRole.getOnlyEquipIds')],
    energyInitialization: { sourceFunctions: [ref('main/manageritem','this.start')], condition: 'Only if initially no items', itemId: 3003, amount: 120, sourceConstants: 'expanded/main/config.js: ft.value.item.power=3003; ft.value.item.powerAutoLimit=120' },
    firstRunConditionSources: [ref('main/method','l.isWorldFinishOnce'), ref('main/managerworld','this.getWorldStatus'), ref('main/method','l.isH5')]
  },
  steps: [
    step('entry', 'scene -> player constructor', [['resources/SceneMain','createPlayer']], ['ftc._loadCoreData', 'ManagerData.passport', 'device/source/language/zone/build/area adapters', 'fts class loader', 'cc scheduling/registration'], ['SceneMain constructs Player and passes account,pwd,uid,code,customerCode plus platform inputs to init; it does not provide starter roles or a fabricated world snapshot.']),
    step('local-save', 'player.init -> load header/file -> manager construction', [['main/baseplayer','this.init'],['main/dbheader','this.readHeader'],['main/dbfile','this.init'],['main/baseplayer','this.initFromDBFile'],['main/baseplayer','this.initManagers'],['main/baseplayer','this._newManager']], ['76 tables', 'SaveKeys defaults', 'localStorage/codec', 'ManagerOrderKeys (22 original managers)', 'playerLoadOver/playerInit'], ['Fresh DbFile uses {syn:1,data:{},d1:{},d2:{}}.', 'No-device fresh playerLoadOver assigns ste=2, independently of gameplay world/role initialization.', 'ManagerRole.init on an empty save creates no roles; gameplay starter roles are created later by Event100.']),
    step('preload-fallback', 'preload error -> original local manager.start', [['main/basehttp','this.init'],['main/basehttp','endJson'],['main/basehttp','this._initPreloadData'],['main/baseplayer','this.allowRunCode']], ['GetPreloadData request completion (success or error)', 'ft/fts/ftc global adapters', 'optional saved hotCode', 'all original Manager.start methods'], ['GetPreloadData result==0 consumes addr,addrlogic,notices,gamedata; failure calls _initPreloadData() with no success data.', '_initPreloadData calls allowRunCode then emits init with onLineOk false if ftc and no serviceUrl.', 'allowRunCode sets system.isStart and calls each manager.start once; this is genuine local initialization, not successful server login.']),
    step('account-gate', 'start button -> autoLogin -> login/register/touch -> getPlayer', [['resources/PartSysUserEnter','start0'],['resources/PartSysUserEnter','clickStartButton'],['resources/PartSysUserEnter','login'],['main/baseplayer','autoLogin'],['main/baseplayer','this.getPlayer'],['main/player','this.playerLoadOver'],['main/basehttp','this.handleTouch']], ['account/session/registration', 'certification/anti-addiction platform', 'remote time/day/holiday', 'ste state'], ['autoLogin invokes msg.login when account exists (or fts.TEST), else msg.autoRegist in ftc branch.', 'getPlayer rejects initial-touch error with nonzero ste; ste=2 error text explicitly requires first-entry network.', 'handleTouch consumes server info/syn/pay/buffer/time/ste; do not replace these with fake success or arbitrary ste=0.']),
    step('world-default', 'ManagerWorld.start -> newWorlds', [['main/managerworld','this.init'],['main/managerworld','this.start'],['main/managerworld','this.newWorlds'],['main/managerworld','this.findAvailableWorld']], ['World table', 'World SaveKeys', 'cur default=1'], ['findAvailableWorld selects table ids <=100; newWorlds constructs missing World entities with [id,0,0,0,0].', 'Default gameplay current world is 1; no remote starter world payload is used here.']),
    step('task-default', 'ManagerTask.start -> first Task -> first Event', [['main/managertask','this.start'],['main/managertask','this.newMainTask'],['main/managertask','this.findFirstTask'],['main/task','this.init'],['main/task','this.findNextEvent'],['main/task','this.addEventNpc']], ['Task.world/type/a_task', 'Event.task/a_event/c_open/npc', 'ManagerNpc', 'DSL interpreter'], ['In a fresh unfinished world and no tasks, ManagerTask.start also initializes wanted tasks, then newMainTask.', 'findFirstTask chooses main Task with a_task[0]==0 and world==ManagerWorld.cur; for world1 this is Task100.', 'Task.findNextEvent uses Event.task and predecessor a_event; Event100 has a_event=[0], c_open=1.']),
    step('start-game', 'client enter -> startGame -> checkTask', [['resources/managerdata','startGame'],['main/baseplayer','startGame'],['main/player','this.playerStart'],['main/managertask','this.checkTask'],['main/task','this.check'],['main/event','this.condition'],['main/event','this.work']], ['explicit independent-local entry adapter or original successful entry', 'system.isStart', 'Event.c_condition/c_work', 'ManagerMap/ManagerTask flags'], ['startGame invokes playerStart; playerStart checks tasks and updates map NPCs.', 'Task.check sets isWorking/isDoingTaskFlag and executes Event.work through player.code; Event100 c_condition=1.', 'Not an authorization to forge an original server entry result.']),
    step('starter-party', 'Event100 -> addItem -> original role/equip dispatch', [['main/method','l.addItem'],['main/manageritem','this.addItems'],['main/manageritem','this.addItem'],['main/managerrole','this.addRole'],['main/method','l.moveRole'],['main/managerrole','this.moveRole']], ['Event100.c_work', 'Item.itemType', 'Role/Equip/ExtRole/ExtEquip', 'first-world-finish/H5 condition'], ['Event100 first-world/non-H5 branch calls addItem:[215,102,1,3000],[1,1,1,1].', 'ManagerItem.addItem dispatches itemType==ft.value.item.role to ManagerRole.addRole; do not model all four as bag items.', 'Then moveRole:215,2,1; moveRole:102,1,1; moveRole:1,1,1. Original role defaults and exclusive equipment creation remain in Role/ManagerRole.']),
    step('first-map', 'Event100.delivery -> map state -> original mapmodel', [['main/method','l.delivery'],['main/managermap','this.delivery'],['main/map','this.reset'],['resources/LayoutMain','loadMap'],['resources/mapmodel','loadMapConfig'],['resources/mapmodel','loadMapFile0'],['resources/mapmodel','findPoint'],['resources/mapmodel','loadMapNpcs'],['resources/mapmodel','isCrashWall']], ['Map2102.mapfile=map_2102', 'Mapnpc Npc33 row98379 at X27/Y9', 'map/mapconfig', 'TMX/native textures', 'Mapnpc rows', 'original per-floor collision'], ['Both Event100 initial branch and its else call delivery:2102,33,1.', 'ManagerMap.delivery sends mapEnter; Map.reset stores point=33 with x/y=-1. MapModel.findPoint/loadMapNpcs choose matching map NPC id33 position if supplied position is blocked. This point is not Mappoint table33.', 'loadMapFile0 reads only dedicated pz,pz-1,pz1 layers: nonzero GID ->1, empty ->0, writes collisions[g][mapHeight-u-1][o]. isCrashWall uses floor+1, 2x2 four cells with odd masks and WJ obstacle checks.']),
    step('tutorial-battle', 'Event100 -> openBattle2 -> callback -> tutorial continuation', [['main/method','l.openBattle'],['main/managerbattle','this.startBattle'],['main/battle','this.startBattle'],['main/managerbattle','battleQuit']], ['Event100.c_work', 'Battle2', 'team/skill/effects/UI'], ['Original Event100 invokes openBattle:2,0,0 then get:, not Code2 standard settlement.', 'After this scripted tutorial branch, Event100 grants addItem:5,1 and presents original team/guide steps.', 'Do not attach Award121, normal exp formula, or generic victory rewards to Battle2 by assumption.']),
    step('npc-input', 'map movement/contact -> mapCrashNpc -> ManagerTask.checkTask', [['resources/mapmodel','sendMsgCrashNpc'],['main/managermap','mapCrashNpc'],['main/managermap','this.crashNpc'],['main/managertask','this.checkTask'],['main/event','isCrashNpc']], ['Mapnpc for map2102/Npc11105 (row94047)', 'npc visibility/work guards', 'Task101/Event101.c_condition'], ['MapModel emits mapCrashNpc with entityId,dir,out,x,y,on.', 'ManagerMap.crashNpc sets crashNpcId/eventMap/eventX/eventY/eventDir before ManagerTask.checkTask.', 'Event101 condition isCrashNpc:11105 triggers task event, rather than inventing a custom NPC handler or requiring Npc11105.c_work to contain the battle.']),
    step('normal-battle', 'Event101 -> original battle machinery/UI', [['main/method','l.openBattle'],['main/managerbattle','this.startBattle'],['main/battle','this.startBattle'],['main/battle','this.initBattle'],['main/battle','this.inputCmd'],['main/battle','this.end'],['resources/LayoutMain','openBattle']], ['Battle10101/Award121 or difficulty Battle150101/Award124', 'ManagerRole/Equip/Core/Copy/Msg', 'BattleRole/Skill/Skillbuff/Skilleffect', 'Code/Check tables', 'original animation/audio/UI'], ['openBattle requires at least3 power; on insufficiency thread battleSte.result=-2.', 'Event101 assigns battleId/awardId; openBattle stores these in original thread keys and starts battle with codeOnCallback openBattle.', 'Battle.end only records result actions; actual standard rewards are invoked by caller Code2, not globally for every battle.']),
    step('battle-quit', 'battleQuit -> DSL continuation', [['main/managerbattle','battleQuit'],['main/baseplayer','this.codeCallback'],['main/method','l.getResult'],['main/managerbattle','this.endBattle']], ['resultType', 'round', 'battleIndex', 'code callback registry', 'battle mode branch state'], ['battleQuit invokes codeCallback(openBattle,{result,round,battleIndex}), then mode-specific bookkeeping and endBattle.', 'Code2 examines result -2/-1/0/1 with different failure/retreat/defeat/victory paths.']),
    step('standard-rewards', 'Code2 -> addBattleExpGoldAward -> local inventories/experience', [['main/method','l.addBattleExpGoldAward'],['main/extaward','ft.ExtAward.getIdNums'],['main/manageritem','this.addItems'],['main/player','this.addExp']], ['Code2.code', 'thread battleSte and _battleAward', 'Award121/124 exact probabilities', 'world/achievement/core modifiers', 'role progression tables'], ['Code2 invokes addBattleExpGoldAward only after excluding insufficient-power, retreat and defeat.', 'addBattleExpGoldAward acts only if battleSte.result==1, consumes stored consumePower, resolves awards through original ExtAward, updates player/team exp, and stores battleAwards display data.', 'Task.finishTask itself is task progression, not a blanket reward issuer.']),
    step('result-ui-return', 'openResult -> LayoutBattleResult -> callback -> same map script', [['main/method','l.openResult'],['resources/LayoutMain','openResult'],['resources/LayoutBattleResult','onClick'],['resources/LayoutMain','c_quitBattle']], ['original result payload', 'codeOnCallback openResult', 'ManagerRes load/cancel', 'map remains loaded'], ['openResult packages win/awardIds/awardNums/awards/roleExp/playerExp/preTeamLvAndExp/endTeamLvAndExp and waits on callback.', 'LayoutMain loads LayoutBattleResult and passes a callback which sendCallback(openResult); result button invokes callback and cancels panel.', 'Normal victory resumes Event101 on map2102; not an unconditional invented delivery or replacement map screen.']),
    step('task-progress', 'Event101 completion -> Task102', [['main/task','this.check'],['main/task','this.findNextEvent'],['main/managertask','this.finishTask'],['main/managertask','this.findNextTasks']], ['Event101 continuation', 'Task102.a_task=[101]', 'NPC/task-item cleanup', 'original guide and equip grant1619'], ['After standard result callback Event101 continues original dialogue, deletes NPC11105/11106, first-time grants Item1619 and runs equipment guides.', 'On event completion Task.check locates next event by a_event; none causes finishTask. finishTask links following Task102 via a_task and deletes previous task NPCs/items.']),
    step('defeat-return', 'Code2 result0 -> result panel -> battle-break choice -> nearest delivery or break', [['main/method','l.openResult'],['main/method','l.showBattleBreak'],['main/method','l.deliveryToNearst'],['main/managermap','this.deliveryToNearst']], ['Code2.code', 'breakType', 'nearest-map/world state', 'Task.check interrupted callback'], ['Code2 defeated path shows result and battle-break UI; only breakType==0 calls deliveryToNearst then breaks.', 'Insufficient energy and retreat set distinct breakType values; Task.check restores map/guide state only under its original banback/breakType conditions.']),
    step('persist', 'property mutation -> DbFile -> queued localStorage write', [['main/baseplayer','this._defineSetAndGet'],['main/dbfile','this.setItem'],['main/dbfile','this.tickSave'],['main/dbfile','this._write'],['main/baseplayer','this.tick'],['resources/basecconfig','ftc._tickLocalStorage']], ['save-schema.json', 'DbFile codecs', 'ftc._tickLocalStorage', 'Local save identity adapter'], ['Original save keys/defaults and manager order are extracted exactly in save-schema.json.', 'tick saves only when system.tick<=0; DbFile prepares _readyWriteString, basecconfig commits asynchronously to localStorage.', 'Interrupted task/battle persistence and reward idempotence require runtime validation; static SaveKeys alone does not prove crash-safe replay.'])
  ],
  tableEvidence: [tableRef('World',1),tableRef('Task',100),tableRef('Event',100,'c_work'),tableRef('Task',101),tableRef('Event',101,'c_condition'),tableRef('Event',101,'c_work'),tableRef('Code',2,'code'),tableRef('Map',2102),tableRef('Mapnpc',94047),tableRef('Battle',2),tableRef('Battle',10101),tableRef('Award',121)],
  minimalPortBoundary: {
    reusableOriginal: ['SaveKeys defaults and ManagerOrderKeys', 'baseplayer/baseentity/basemanager constructors and state mutation', 'system/inspect/thread/method DSL runtime (not project story AST)', '22 original managers with their entities and extensions', '76 original tables including Code and Check', 'mapmodel and exact Map/Mapnpc/pz-layer collision inputs (Mappoint is unrelated to point33 spawn)', 'battle/battlerole/skill/skillbuff/skilleffect and caller-driven settlement'],
    projectAdaptersNeeded: ['Explicit local identity and new-save/load interface, separated from original platform account/authentication ste.', 'Module/class loader matching fts.require/newClass/apply and global ft/fts/ftd configuration.', 'Cocos registration/scheduling/UI/resource/native bridge migration; cc._RF is not game logic.', 'Message/callback/notify transport retaining original callback ordering and payload names.', 'LocalStorage/codec/time/random/resource inputs; independent local time must not masquerade as a server-authoritative time.', 'Native SDK calls, analytics, certification, network and commercial features retained as separate bounded interfaces, not fabricated successful calls.'],
    notStandalone: 'Extracted functions refer to shared globals, original cross-manager hooks, table loaders, renderer/assets, codecs and callbacks. Merely importing these 108 source fragments does not produce an executable game.',
    runtimeValidationStillRequired: ['Original initial branch and team creation through Event100', 'map2102 movement/collision/contact and tutorialBattle2', 'NPC11105 -> Battle10101 -> Award121 -> Task102', 'save/reload and interrupted reward/callback ordering', 'proper failures without fake network success']
  },
  remoteAuthorityNotReconstructed: {
    fieldsObserved: ['GetPreloadData: addr,addrlogic,notices,gamedata/update/feature switches', 'account registration/login/authentication: account,pwd,uid,token,customer code,certification', 'Touch: info,syn,upload,buffer,tick,day,holiday,ste,pay,rmb,giftmoneytotal,msg,excludeMsg'],
    missing: ['Actual authoritative account/session/certification records and remote route/service deployment.', 'Existing cloud saves and pending authoritative buffers/messages/pay/commercial state; no source account is read or modified.', 'Server clock/day/holiday and synchronization decisions; no fabricated authoritative values.'],
    coreStarterDataGap: 'No server-only starter role/map/task record is observed for the recovered new-game core. Starter gameplay assignments are in Event100; original authentication gate and runtime assets remain separate blockers.'
  },
  notVerified: ['No original business module executed, required, or evaluated.', 'No build/lint/test/formatter/device/network/account actions performed.', 'Static extraction does not establish full-game coverage, final APK acceptance, rendering fidelity, or runtime reward idempotence.']
};
save(path.join(dir, 'flow.json'), flow);
console.log(JSON.stringify({ steps: flow.steps.length, modules: manifest.modules.length, schemaModules: Object.keys(schemas).length - 1, sourceTableHash: sourceEvidence.sha256 }));
