import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareReference, decodeHtmlEntities, effectiveField, markdownMatches, parseMarkdownPart,
  type JsonRecord, type ReferenceSource,
} from '../tools/data/reference-import';
import { attributeCurve, compareOriginalIds, inventoryDsl, selectPlayerRoles } from '../tools/data/reference-source-analysis';
import { parseReferenceSyntax, ReferenceSyntaxError } from '../tools/data/reference-syntax';

function fixture(row: JsonRecord, defaults: JsonRecord = {}): ReferenceSource {
  return { metadata: {}, tables: { Test: { keys: [...new Set([...Object.keys(row), ...Object.keys(defaults), 'absent'])], defaults, data: { '1': row } } } };
}
function part(rows: string[], blocks = '', defaults: JsonRecord = {}, title = 'sample'): string {
  return [
    '# test · Test', '', '本分表 1 条；整张 `Test` 表 1 条。按原始ID排列。', '',
    '**本表默认值（已排除资源字段）：**', '```json', JSON.stringify(defaults), '```', '',
    '<a id="id-1"></a>', `## 1 · ${title}`, '',
    '| 中文字段 | 原始字段 | 原值 |', '|---|---|---|', ...rows, '', blocks,
  ].join('\n');
}
const tinyExpected = { tables: 1, records: 1, markdownParts: 1 };

test('defaults apply only to absent keys; null, empty string and empty array survive', () => {
  const defaults = { missing: 7, explicitNull: 8, empty: 'fallback', array: [3] };
  const row = { name: 'sample', explicitNull: null, empty: '', array: [] };
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |', '| missing | `missing` | 7 **（默认）** |',
    '| null | `explicitNull` | `null` |', '| empty | `empty` | `""` |', '| array | `array` | &#91;&#93; |',
  ], '', defaults), '分表/Test.md');
  const result = compareReference(fixture(row, defaults), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  const fields = result.records[0].fields;
  assert.equal(fields.missing.presence, 'default');
  assert.equal(fields.missing.hasRawValue, false);
  assert.equal(fields.missing.value, 7);
  assert.equal(fields.explicitNull.presence, 'explicit');
  assert.equal(fields.explicitNull.usedDefault, false);
  assert.equal(fields.explicitNull.hasRawValue, true);
  assert.equal(fields.explicitNull.rawValue, null);
  assert.equal(fields.empty.rawValue, '');
  assert.deepEqual(fields.array.rawValue, []);
  assert.equal(fields.absent.presence, 'absent');
  assert.equal(fields.absent.hasRawValue, false);
  assert.equal(fields.absent.sourceFile, '分表/Test.md');
  assert.equal(fields.absent.sourceId, '1');
});

test('bare numeric strings retain JSON authority and expose Markdown ambiguity', () => {
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |', '| numeric string | `stringNumber` | 295 |',
    '| number | `number` | 295 |', '| unsafe string | `large` | 10000000000000000000 |',
    '| expression | `formula` | if(getLv:) &lt;= 50;mathPow:2,3 |',
  ]), '分表/Test.md');
  const result = compareReference(fixture({ name: 'sample', stringNumber: '295', number: 295, large: '10000000000000000000', formula: 'if(getLv:) <= 50;mathPow:2,3' }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  assert.equal(typeof result.records[0].fields.stringNumber.rawValue, 'string');
  assert.equal(typeof result.records[0].fields.number.rawValue, 'number');
  assert.equal(result.records[0].fields.large.rawValue, '10000000000000000000');
  assert.equal(result.report.ambiguities.length, 3);
});

test('HTML entities decode after GFM columns and exactly once', () => {
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |', '| text | `value` | A&#124;B &amp; C &#91;x&#93; &lt;color=red&gt; |',
    '| encoded literal | `literal` | &amp;#124; |',
  ]), '分表/Test.md');
  assert.equal(parsed.records[0].fields.length, 3);
  assert.equal(parsed.records[0].fields[1].displayValue, 'A|B & C [x] <color=red>');
  assert.equal(parsed.records[0].fields[2].displayValue, '&#124;');
  assert.equal(decodeHtmlEntities('&amp;#124; &quot; &apos; &#x1F680; &copy;'), '&#124; " \' 🚀 ©');
});

test('arrays retain order, duplicate elements, zero, null and numeric-string element types', () => {
  const array = [0, '2', 2, null, [3, 3], []];
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |', '| array | `values` | &#91;0,"2",2,null,&#91;3,3&#93;,&#91;&#93;&#93; |',
  ]), '分表/Test.md');
  const result = compareReference(fixture({ name: 'sample', values: array }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  assert.deepEqual(result.records[0].fields.values.rawValue, array);
  assert.equal(markdownMatches(parsed.records[0].fields[1], [0, 2, '2', null, [3, 3], []]), false);
});

test('JSON array structure blocks are bound to the second-column field', () => {
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |', '| array | `values` | 见下方结构 |',
  ], '**`values` 数组结构：**\n```json\n[0, [1, "2"], null, []]\n```'), '分表/Test.md');
  const result = compareReference(fixture({ name: 'sample', values: [0, [1, '2'], null, []] }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  assert.equal(parsed.records[0].fields[1].block?.lang, 'json');
});

test('c_work remains full opaque code, including nested calls, operators and entities', () => {
  const work = 'ATK=(getValue:0,1);if(getBuffLv:0,[61])>0;subBuff:0,[61,11],1;else;hp=ATK*5/100;subHp:0,hp,1;endif\n&amp;\n  untouched';
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |', '| text | `c_work` | 见下方文本 |',
  ], `**\`c_work\` 原始文本：**\n\`\`\`text\n${work}\n\`\`\``), '分表/Test.md');
  assert.equal(parsed.records[0].fields[1].block?.rawValue, work);
  const result = compareReference(fixture({ name: 'sample', c_work: work }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  const inventory = inventoryDsl(result);
  assert.deepEqual(inventory.candidates.map(candidate => candidate.name), ['getBuffLv', 'getValue', 'subBuff', 'subHp']);
  assert.equal(inventory.execution, 'never');
});

test('empty c_work and empty name do not require a text block or become a title value', () => {
  const parsed = parseMarkdownPart(part([
    '| name | `name` | `""` |', '| text | `c_work` | `""` |',
  ], '', {}, '（空名称）'), '分表/Test.md');
  const result = compareReference(fixture({ name: '', c_work: '' }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  assert.equal(result.records[0].fields.name.rawValue, '');
  assert.equal(result.records[0].fields.c_work.rawValue, '');
});

test('missing blocks, conflicting defaults and duplicate IDs are findings, not padded/dropped rows', () => {
  const source = fixture({ name: 'sample', c_work: 'attack:100,0,0' }, { type: 1 });
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |', '| text | `c_work` | 见下方文本 |', '| type | `type` | 2 **（默认）** |',
  ], '', { type: 2 }), '分表/Test.md');
  const result = compareReference(source, [parsed, { ...parsed, sourceFile: '分表/duplicate.md', records: parsed.records.map(record => ({ ...record, sourceFile: '分表/duplicate.md' })) }], tinyExpected);
  const kinds = result.report.issues.map(issue => issue.kind);
  assert.equal(result.report.ok, false);
  assert.ok(kinds.includes('missing-code-block'));
  assert.ok(kinds.includes('defaults-conflict'));
  assert.ok(kinds.includes('duplicate-record'));
  assert.ok(kinds.includes('field-conflict'));
  assert.equal(result.report.observed.markdownRecords, 2);
  assert.equal(result.report.observed.uniqueMarkdownRecords, 1);
  assert.equal(result.records.length, 1);
});

test('explicit null profession is never defaulted; tests remain in exact stable ID selection', () => {
  const source: ReferenceSource = { metadata: {}, tables: { Role: { keys: ['profession', 'value2', 'growth1'], defaults: { profession: 31 }, data: {
    '10': { profession: 11, value2: '2', growth1: null },
    '2': { profession: 11, value2: '1', growth1: 0 },
    '999989': { profession: 11, value2: '10000000000000000000', growth1: null },
    '999997': { profession: 25 }, '5': { profession: null }, '6': {},
    '7': { profession: 20 }, '8': { profession: 30 },
  } } } };
  assert.deepEqual(selectPlayerRoles(source), { vehicles: ['2', '10', '999989'], pilots: ['999997'], unclassified: ['5'] });
  const curve = attributeCurve(source, ['2', '10', '999989'], 'value2');
  assert.deepEqual(curve.sorted.map(point => point.rawValue), ['1', '2', '10000000000000000000']);
  assert.equal(curve.quantiles['1']?.rawValue, '10000000000000000000');
  const growth = attributeCurve(source, ['2', '10', '999989'], 'growth1');
  assert.equal(growth.eligibleCount, 1);
  assert.equal(growth.sorted[0].rawValue, 0);
  assert.equal(growth.excluded.length, 2);
  assert.equal(compareOriginalIds('9007199254740993', '9007199254740992'), 1);
  assert.equal(effectiveField({ profession: null }, { profession: 31 }, 'profession').value, null);
});

test('typed old DSL syntax preserves exact decimal literals, nested calls and conditional structure without execution', () => {
  const program = parseReferenceSyntax('ATK=(getValue:0,1);if(getBuffLv:0,[61])>0;subBuff:0,[61,11],1;else;hp=(getHp:0,1)*5/100;subHp:0,hp,1;endif');
  assert.equal(program.semantics, 'syntax-only');
  assert.equal(program.statements[0].kind, 'assignment');
  const conditional = program.statements[1];
  assert.equal(conditional.kind, 'if');
  if (conditional.kind !== 'if') throw new Error('Expected static if syntax.');
  assert.equal(conditional.branches[0].condition.kind, 'binary');
  assert.equal(conditional.otherwise.length, 2);
  const numeric = parseReferenceSyntax('HP=10000000000000000000');
  const assignment = numeric.statements[0];
  assert.equal(assignment.kind, 'assignment');
  if (assignment.kind !== 'assignment') throw new Error('Expected assignment syntax.');
  assert.deepEqual(assignment.value, { kind: 'number', decimal: '10000000000000000000' });
});

test('unknown old DSL syntax is a precise error, not silently accepted or evaluated', () => {
  assert.throws(() => parseReferenceSyntax('if(getRound:)>1;attack:100,0,0'), ReferenceSyntaxError);
  assert.throws(() => parseReferenceSyntax('value={not-a-supported-array}'), ReferenceSyntaxError);
  assert.throws(() => parseReferenceSyntax('attack:100,0,0 unexpected'), /offset/);
  const empty = parseReferenceSyntax('');
  assert.deepEqual(empty.statements, []);
  assert.equal(empty.semantics, 'syntax-only');
});

test('inline-HTML paragraph anchors are recognized without accepting a mismatched ID', () => {
  const markdown = part(['| name | `name` | sample |']);
  const parsed = parseMarkdownPart(markdown, '分表/Test.md');
  assert.equal(parsed.records[0].anchorId, '1');
  assert.equal(parsed.issues.some(issue => issue.kind === 'record-anchor'), false);
  const mismatch = parseMarkdownPart(markdown.replace('<a id="id-1">', '<a id="id-2">'), '分表/Test.md');
  assert.equal(mismatch.records[0].anchorId, '2');
  assert.equal(mismatch.issues.some(issue => issue.kind === 'record-anchor'), true);
  const blankLine = parseMarkdownPart(markdown.replace('</a>\n##', '</a>\n\n##'), '分表/Test.md');
  assert.equal(blankLine.records[0].anchorId, '1');
});

test('source while/end and break compile with positional omissions intact', () => {
  const program = parseReferenceSyntax('i=0;while i<(arrLen:pos);getValue:0,2,,1;i=i+1;if i>2;break;endif;end');
  const loop = program.statements[1];
  if (loop.kind !== 'while') throw new Error('Expected while syntax.');
  const call = loop.statements[0];
  if (call.kind !== 'expression' || call.expression.kind !== 'call') throw new Error('Expected call syntax.');
  assert.deepEqual(call.expression.arguments[2], { kind: 'omitted' });
  assert.equal(call.expression.arguments.length, 4);
  const guardedBreak = loop.statements[2];
  if (guardedBreak.kind !== 'if') throw new Error('Expected break guard.');
  assert.deepEqual(guardedBreak.branches[0].statements[0], { kind: 'break' });
  const trailing = parseReferenceSyntax('setRoleVariable:,126,1;subBuff:0,[10005],;');
  const first = trailing.statements[0];
  const second = trailing.statements[1];
  if (first.kind !== 'expression' || first.expression.kind !== 'call' || second.kind !== 'expression' || second.expression.kind !== 'call') throw new Error('Expected source calls.');
  assert.deepEqual(first.expression.arguments[0], { kind: 'omitted' });
  assert.deepEqual(second.expression.arguments[2], { kind: 'omitted' });
});

test('authorized recovery preserves exact values and records source-defect design separately', () => {
  const program = parseReferenceSyntax('if（getRound:）><1;hp=(getValue:0,2)*/2;elseif;showTip:获得50积分', { recoverSourceDefects: true });
  const conditional = program.statements[0];
  if (conditional.kind !== 'if') throw new Error('Expected recovered conditional.');
  assert.equal(conditional.branches[0].condition.kind, 'binary');
  assert.ok(program.designDecisions.some(decision => decision.rule === 'reversed-inequality'));
  assert.ok(program.designDecisions.some(decision => decision.rule === 'multiply-divide-typo'));
  assert.ok(program.designDecisions.some(decision => decision.rule === 'conditionless-elseif'));
  assert.ok(program.designDecisions.some(decision => decision.rule === 'missing-endif'));
  const assignment = conditional.branches[0].statements[0];
  if (assignment.kind !== 'assignment' || assignment.value.kind !== 'binary') throw new Error('Expected preserved arithmetic.');
  assert.equal(assignment.value.operator, '/');
  assert.deepEqual(assignment.value.right, { kind: 'number', decimal: '2' });
  const note = parseReferenceSyntax('暂未处理', { recoverSourceDefects: true });
  assert.equal(note.statements[0].kind, 'source-annotation');
  assert.equal(note.designDecisions[0].rule, 'non-code-source-note');
});

test('raw field spans preserve multiplication, underscores and rich text instead of interpreting Markdown', () => {
  const formula = 'iniValue=(getLv:)*(2*(getLv:)+20);iniValue';
  const underscored = 'ini_value=_lhs_*_rhs_*2;__result__';
  const richText = '<color=red>[source_label]*5</color> & @X/@Y';
  const parsed = parseMarkdownPart(part([
    '| name | `name` | sample |',
    `| formula | \`formula\` | ${formula} |`,
    `| identifiers | \`underscored\` | ${underscored} |`,
    '| rich text | `richText` | &lt;color=red&gt;&#91;source_label&#93;*5&lt;/color&gt; &amp; @X/@Y |',
    '| literal Markdown | `markup` | *literal* **data** ~~keep~~ |',
  ]), '分表/Test.md');
  const result = compareReference(fixture({ name: 'sample', formula, underscored, richText, markup: '*literal* **data** ~~keep~~' }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  assert.equal(parsed.records[0].fields[1].displayValue, formula);
  assert.equal(parsed.records[0].fields[2].displayValue, underscored);
  assert.equal(parsed.records[0].fields[3].displayValue, richText);
  assert.ok(parsed.records[0].fields[1].rawCell.includes('*'));
});

test('record titles preserve original literal formatting, entities and closing hash characters', () => {
  const name = '倍率*5+护盾*2 _raw_ **literal** <color=red>[源|值]</color> &#124; #';
  const rendered = '倍率*5+护盾*2 _raw_ **literal** &lt;color=red&gt;&#91;源&#124;值&#93;&lt;/color&gt; &amp;#124; #';
  const parsed = parseMarkdownPart(part([`| name | \`name\` | ${rendered} |`], '', {}, rendered), '分表/Test.md');
  const result = compareReference(fixture({ name }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  assert.equal(parsed.records[0].title, `1 · ${name}`);
  assert.equal(result.records[0].fields.name.rawValue, name);
});

test('CRLF display blocks compare canonically while preserving both originals and auditing normalization', () => {
  const work = 'ATK=getValue:0,1;\naddHp:0,ATK*5/100';
  const markdown = part([
    '| name | `name` | sample |', '| text | `c_work` | 见下方文本 |',
  ], `**\`c_work\` 原始文本：**\n\`\`\`text\n${work}\n\`\`\``).replace(/\n/g, '\r\n');
  const parsed = parseMarkdownPart(markdown, '分表/Test.md');
  const result = compareReference(fixture({ name: 'sample', c_work: work }), [parsed], tinyExpected);
  assert.equal(result.report.ok, true, JSON.stringify(result.report.issues));
  assert.equal(parsed.records[0].fields[1].block?.rawValue, work.replace(/\n/g, '\r\n'));
  assert.equal(result.records[0].fields.c_work.rawValue, work);
  assert.equal(result.report.comparisonNormalizations.length, 1);
  assert.equal(result.report.comparisonNormalizations[0].field, 'c_work');
  assert.equal(result.report.comparisonNormalizations[0].kind, 'text-code-block-line-endings');
  assert.equal(markdownMatches(parsed.records[0].fields[1], work.replace('*5', '/5')), false);
});


test('Role source spaced comparison compiles full growth formula without changing constants', () => {
  const formula = 'iniValue=125;iniLevel=10;if(getLv:)< =iniLevel;Lv=0;else;Lv=(getLv:)-iniLevel;endif;iniValue=(mathFloor:(iniValue*(mathPow:10,(Lv/120))));iniValue';
  assert.throws(() => parseReferenceSyntax(formula), ReferenceSyntaxError);
  const program = parseReferenceSyntax(formula, { recoverSourceDefects: true });
  const initial = program.statements[0];
  if (initial.kind !== 'assignment') throw new Error('Expected original base assignment.');
  assert.deepEqual(initial.value, { kind: 'number', decimal: '125' });
  const conditional = program.statements[2];
  if (conditional.kind !== 'if' || conditional.branches[0].condition.kind !== 'binary') throw new Error('Expected level comparison.');
  assert.equal(conditional.branches[0].condition.operator, '<=');
  const growth = program.statements[3];
  if (growth.kind !== 'assignment' || growth.value.kind !== 'call') throw new Error('Expected real arithmetic AST.');
  assert.equal(growth.value.command, 'mathFloor');
  assert.ok(JSON.stringify(growth).includes('"command":"mathPow"'));
  assert.ok(JSON.stringify(growth).includes('"decimal":"120"'));
  assert.deepEqual(program.statements[4], { kind: 'expression', expression: { kind: 'identifier', name: 'iniValue' } });
  assert.equal(program.designDecisions.filter(decision => decision.rule === 'spaced-comparison').length, 1);
});
