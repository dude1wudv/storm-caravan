/** Pure data compiler: no Node imports, external parser, dynamic evaluation or battle API execution. */
export type ReferenceExpression =
  | { kind: 'number'; decimal: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'omitted' }
  | { kind: 'identifier'; name: string }
  | { kind: 'array'; elements: ReferenceExpression[] }
  | { kind: 'index'; target: ReferenceExpression; index: ReferenceExpression }
  | { kind: 'call'; command: string; arguments: ReferenceExpression[] }
  | { kind: 'unary'; operator: string; operand: ReferenceExpression }
  | { kind: 'binary'; operator: string; left: ReferenceExpression; right: ReferenceExpression };
export type ReferenceStatement =
  | { kind: 'assignment'; target: ReferenceExpression; value: ReferenceExpression }
  | { kind: 'expression'; expression: ReferenceExpression }
  | { kind: 'directive'; name: string }
  | { kind: 'source-annotation'; text: string; designDecision?: string }
  | { kind: 'break' }
  | { kind: 'while'; condition: ReferenceExpression; statements: ReferenceStatement[] }
  | { kind: 'if'; branches: { condition: ReferenceExpression; statements: ReferenceStatement[] }[]; otherwise: ReferenceStatement[] };
export interface SyntaxDesignDecision { rule: string; offset: number; detail: string }
export interface ReferenceSyntaxProgram {
  kind: 'reference-syntax-program';
  grammarVersion: 2;
  semantics: 'syntax-only';
  designDecisions: SyntaxDesignDecision[];
  statements: ReferenceStatement[];
}
export interface ReferenceSyntaxOptions { recoverSourceDefects?: boolean }
export class ReferenceSyntaxError extends Error {
  constructor(message: string, readonly offset: number) { super(`${message} at offset ${offset}`); this.name = 'ReferenceSyntaxError'; }
}

export const REFERENCE_GRAMMAR_EVIDENCE = {
  sourceConfirmed: [
    'Original c_work uses colon calls, positional comma-separated operands, arrays, indexed variables and assignments.',
    'Original c_work contains if/elseif/else/endif, while/end, break, @directives, and/or/not and empty positional parameters.',
    'Numeric literal text, including unsafe integer decimals, is preserved instead of being coerced by the compiler.',
    'Story scripts also contain parenthesized function wrappers and switch(selector);literal?(body) cases.',
  ],
  designed: [
    'Pratt precedence, low to high: or, and, comparisons, +/-, */%, exponent; exponent is right associative. Unary signs/not bind above binary operations.',
    'Colon calls consume complete argument expressions up to comma, closing delimiter or statement separator; parenthesized calls disambiguate nesting.',
    'Empty argument slots become an omitted node, not null, zero or a removed array element; the business dispatcher supplies its own defaults.',
    'The <> spelling is canonicalized to !=. Recovery mode also treats malformed >< as != and single = inside conditions as ==.',
    'Recovery mode joins whitespace-separated comparison tokens such as < = into <=, preserving original source offsets and all operands.',
    'Recovery mode folds full-width punctuation, closes incomplete blocks at EOF, ignores unmatched closing controls and treats conditionless elseif as else.',
    'Recovery mode treats the isolated original note and inline Chinese commentary as inert source-annotation nodes. A bare Chinese call operand remains a string.',
    'Recovery mode repairs the single observed */ arithmetic typo to division; every source repair has an offset and named design decision.',
    'Orphan elseif/else after prematurely closed blocks attach to the preceding if where possible; otherwise an independent conditional is constructed with an explicit design decision.',
    'Recovery mode preserves unquoted full-width-colon card labels as exact string values and records the missing quotation marks.',
    'Switch cases lower to one ordered if with equality branches and no fallthrough; only side-effect-free selectors are supported. Missing endswitch is recovered only at the end of contiguous literal?(body) cases.',
    'Recovery mode repairs esleif to elseif and the observed showFlopStory interrupted/missing argument delimiters without changing any operand.',
  ],
} as const;

interface Token { kind: 'number' | 'string' | 'identifier' | 'operator' | 'directive' | 'text' | 'eof'; value: string; offset: number }
const PRECEDENCE: Record<string, number> = { or: 1, '||': 1, and: 2, '&&': 2, '==': 3, '!=': 3, '~=': 3, '<': 3, '>': 3, '<=': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, '^': 6 };
const CONTROL_WORDS = ['if', 'elseif', 'else', 'endif', 'while', 'end', 'break', 'switch', 'endswitch'];

/** Compile syntax only. Explicit recovery is for the observed defective source records, never silent. */
export function parseReferenceSyntax(input: string, options: ReferenceSyntaxOptions = {}): ReferenceSyntaxProgram {
  const recover = options.recoverSourceDefects === true;
  const designDecisions: SyntaxDesignDecision[] = [];
  const record = (rule: string, offset: number, detail: string): void => { designDecisions.push({ rule, offset, detail }); };
  const tokens: Token[] = [];
  const punctuation: Record<string, string> = { '（': '(', '）': ')', '，': ',', '；': ';', '：': ':', '＝': '=', '＜': '<', '＞': '>', '［': '[', '］': ']' };
  let offset = 0;
  while (offset < input.length) {
    const character = input[offset];
    if (/\s/.test(character)) { offset++; continue; }
    const start = offset;
    const cardLabel = /^\d+：[^,\]；;\r\n]+/.exec(input.slice(offset));
    if (cardLabel && ['[', ','].includes(tokens.at(-1)?.value ?? '')) {
      if (!recover) throw new ReferenceSyntaxError('Unquoted card configuration requires explicit source recovery', offset);
      tokens.push({ kind: 'string', value: cardLabel[0], offset });
      record('unquoted-card-configuration', offset, 'Retained the complete number：label source spelling as a string, without normalizing its full-width colon.');
      offset += cardLabel[0].length;
      continue;
    }
    if (character in punctuation) {
      if (!recover) throw new ReferenceSyntaxError('Full-width syntax requires explicit source recovery', offset);
      tokens.push({ kind: 'operator', value: punctuation[character], offset });
      record('full-width-punctuation', offset, `Canonicalized ${character} to ${punctuation[character]}.`);
      offset++;
      continue;
    }
    if (character === '@') {
      offset++;
      while (offset < input.length && !/[;；\r\n]/.test(input[offset])) offset++;
      const name = input.slice(start + 1, offset).trim();
      if (!name) throw new ReferenceSyntaxError('Empty macro/directive', start);
      tokens.push({ kind: 'directive', value: name, offset: start });
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      offset++;
      let value = '';
      let closed = false;
      while (offset < input.length) {
        const next = input[offset++];
        if (next === quote) { closed = true; break; }
        if (next === '\\') {
          const escaped = input[offset++];
          if (escaped === undefined) throw new ReferenceSyntaxError('Unterminated escape', offset - 1);
          const escapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"', "'": "'" };
          if (escaped in escapes) value += escapes[escaped];
          else if (escaped === 'u' || escaped === 'x') {
            const length = escaped === 'u' ? 4 : 2;
            const hex = input.slice(offset, offset + length);
            if (hex.length !== length || !/^[\da-f]+$/i.test(hex)) throw new ReferenceSyntaxError('Malformed hexadecimal escape', offset - 2);
            value += String.fromCharCode(Number.parseInt(hex, 16));
            offset += length;
          } else throw new ReferenceSyntaxError(`Unsupported string escape \\${escaped}`, offset - 2);
        } else value += next;
      }
      if (!closed) throw new ReferenceSyntaxError('Unterminated string', start);
      tokens.push({ kind: 'string', value, offset: start });
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(input.slice(offset));
    if (number) { tokens.push({ kind: 'number', value: number[0], offset }); offset += number[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(offset));
    if (identifier) {
      let value = identifier[0];
      if (value === 'esleif' && recover) {
        record('misspelled-elseif', offset, 'Interpreted the observed esleif spelling as elseif; the original source remains unchanged.');
        value = 'elseif';
      }
      tokens.push({ kind: 'identifier', value, offset }); offset += identifier[0].length; continue;
    }
    const separatedComparison = /^(?:<[ \t\r\n]+[=>]|>[ \t\r\n]+[=<]|[=!~][ \t\r\n]+=)/.exec(input.slice(offset));
    if (separatedComparison) {
      if (!recover) throw new ReferenceSyntaxError('Whitespace-separated comparison requires explicit source recovery', offset);
      const spelling = separatedComparison[0].replace(/\s+/g, '');
      const value = spelling === '<>' || spelling === '><' ? '!=' : spelling;
      record('spaced-comparison', offset, `Joined source comparison ${JSON.stringify(separatedComparison[0])} into ${value}; operands and original text are unchanged.`);
      tokens.push({ kind: 'operator', value, offset });
      offset += separatedComparison[0].length;
      continue;
    }
    const operator = /^(?:==|!=|~=|<=|>=|<>|><|\*\/|&&|\|\||[+\-*/%^<>=!(),;:?\[\]])/.exec(input.slice(offset));
    if (operator) {
      let value = operator[0];
      if (value === '<>') value = '!=';
      else if (value === '><' || value === '*/') {
        if (!recover) throw new ReferenceSyntaxError(`Malformed operator ${value}`, offset);
        record(value === '><' ? 'reversed-inequality' : 'multiply-divide-typo', offset, value === '><' ? 'Designed != interpretation of ><.' : 'Designed division interpretation of the observed */ typo.');
        value = value === '><' ? '!=' : '/';
      }
      tokens.push({ kind: 'operator', value, offset }); offset += operator[0].length; continue;
    }
    if (character.charCodeAt(0) > 127) {
      offset++;
      while (offset < input.length && !/[\s;；(),，:：\[\]+\-*/%^<>=!（），]/.test(input[offset])) offset++;
      tokens.push({ kind: 'text', value: input.slice(start, offset), offset: start });
      continue;
    }
    throw new ReferenceSyntaxError(`Unsupported syntax character ${JSON.stringify(character)}`, offset);
  }
  tokens.push({ kind: 'eof', value: '', offset: input.length });
  let cursor = 0;
  const peek = (): Token => tokens[cursor];
  const take = (): Token => tokens[cursor++];
  const expect = (value: string): void => {
    if (peek().value !== value) throw new ReferenceSyntaxError(`Expected ${value}, found ${peek().value || 'end of input'}`, peek().offset);
    take();
  };
  const close = (value: string): void => {
    if (peek().value === value) { cursor++; return; }
    if (recover && (peek().kind === 'eof' || [';', 'else', 'elseif', 'endif', 'end', ')', ']'].includes(peek().value))) {
      record('missing-close', peek().offset, `Inserted missing ${value} before the next delimiter.`);
      return;
    }
    expect(value);
  };
  const callBoundary = (token: Token): boolean => token.kind === 'eof' || [';', ')', ']', '=', 'else', 'elseif', 'endif', 'end', 'endswitch'].includes(token.value);
  const zeroArgumentBoundary = (token: Token): boolean => callBoundary(token) || ['==', '!=', '~=', '<', '>', '<=', '>=', 'and', 'or', '&&', '||'].includes(token.value);
  const expression = (minimum = 0, condition = false): ReferenceExpression => {
    let left: ReferenceExpression;
    const token = take();
    if (token.kind === 'number') left = { kind: 'number', decimal: token.value };
    else if (token.kind === 'string' || token.kind === 'text') left = { kind: 'string', value: token.value };
    else if (token.value === '+' || token.value === '-' || token.value === 'not' || token.value === '!') left = { kind: 'unary', operator: token.value, operand: expression(7, condition) };
    else if (token.value === '(') { left = expression(0, condition); close(')'); }
    else if (token.value === '[') {
      const elements: ReferenceExpression[] = [];
      while (peek().value !== ']' && peek().kind !== 'eof') {
        if (peek().value === ',') elements.push({ kind: 'omitted' });
        else elements.push(expression(0, condition));
        if (peek().value !== ',') break;
        take();
        if (peek().value === ']') { elements.push({ kind: 'omitted' }); break; }
      }
      close(']'); left = { kind: 'array', elements };
    } else if (token.kind === 'identifier') {
      if (CONTROL_WORDS.includes(token.value) || token.value === 'and' || token.value === 'or') throw new ReferenceSyntaxError(`Unexpected control keyword ${token.value}`, token.offset);
      if (token.value === 'true' || token.value === 'false') left = { kind: 'boolean', value: token.value === 'true' };
      else if (token.value === 'null' || token.value === 'nil') left = { kind: 'null' };
      else if (peek().value === ':') {
        take();
        const args: ReferenceExpression[] = [];
        if (!zeroArgumentBoundary(peek())) {
          while (true) {
            if (peek().value === ',' || callBoundary(peek())) args.push({ kind: 'omitted' });
            else args.push(expression(0, condition));
            if (recover && token.value === 'showFlopStory' && args.length === 2 && peek().value === ';' && tokens[cursor + 1]?.value === ',' && tokens[cursor + 2]?.value === '[') {
              const interrupted = take();
              record('interrupted-story-call', interrupted.offset, 'Removed the stray semicolon before the existing comma and dialogue array within showFlopStory; every argument is retained.');
            }
            if (recover && token.value === 'showFlopStory' && args.length === 3 && args[2].kind === 'array' && peek().kind === 'number') {
              record('missing-story-argument-comma', peek().offset, 'Inserted the missing comma between the dialogue array and the existing numeric showFlopStory operand.');
              continue;
            }
            if (peek().value !== ',') break;
            take();
            if (callBoundary(peek())) { args.push({ kind: 'omitted' }); break; }
          }
        }
        left = { kind: 'call', command: token.value, arguments: args };
      } else if (peek().value === '(') {
        take();
        const args: ReferenceExpression[] = [];
        while (peek().value !== ')' && peek().kind !== 'eof') {
          if (peek().value === ',') args.push({ kind: 'omitted' });
          else args.push(expression(0, condition));
          if (peek().value !== ',') break;
          take();
          if (peek().value === ')') { args.push({ kind: 'omitted' }); break; }
        }
        close(')');
        left = { kind: 'call', command: token.value, arguments: args };
      } else left = { kind: 'identifier', name: token.value };
    } else throw new ReferenceSyntaxError(`Expected expression, found ${token.value || 'end of input'}`, token.offset);
    while (true) {
      if (peek().kind === 'text' && recover) {
        const note = take();
        record('inline-source-comment', note.offset, 'Chinese text after an expression is treated as an inert source comment.');
        continue;
      }
      if (peek().value === '[') { take(); const index = expression(0, condition); close(']'); left = { kind: 'index', target: left, index }; continue; }
      let operator = peek().value;
      let precedence = PRECEDENCE[operator];
      if (operator === '=' && recover && (condition || (left.kind !== 'identifier' && left.kind !== 'index'))) { precedence = 3; operator = '=='; }
      if (precedence === undefined || precedence < minimum) break;
      const sourceOperator = take();
      if (sourceOperator.value === '=') record('condition-equals', sourceOperator.offset, 'A single = in a condition or a non-assignable bare predicate is designed as equality, not assignment.');
      left = { kind: 'binary', operator, left, right: expression(precedence + (operator === '^' ? 0 : 1), condition) };
    }
    return left;
  };
  const sequence = (stops: string[] = []): ReferenceStatement[] => {
    const statements: ReferenceStatement[] = [];
    while (peek().kind !== 'eof' && !stops.includes(peek().value)) {
      if (peek().value === ';') { take(); continue; }
      const start = peek();
      if (start.kind === 'directive') statements.push({ kind: 'directive', name: take().value });
      else if (start.kind === 'text') {
        if (!recover) throw new ReferenceSyntaxError('Non-code source annotation requires explicit recovery', start.offset);
        statements.push({ kind: 'source-annotation', text: take().value });
        record('non-code-source-note', start.offset, 'An original non-code note is retained as an inert source annotation.');
      } else if (start.value === 'break') { take(); statements.push({ kind: 'break' }); }
      else if (start.value === 'switch') {
        take(); expect('(');
        const selector = expression();
        expect(')');
        if (!['identifier', 'number', 'string', 'boolean', 'null'].includes(selector.kind)) throw new ReferenceSyntaxError('Switch selector must be side-effect-free for if lowering', start.offset);
        expect(';');
        const branches: Extract<ReferenceStatement, { kind: 'if' }>['branches'] = [];
        while (peek().kind === 'number' || (['+', '-'].includes(peek().value) && tokens[cursor + 1]?.kind === 'number')) {
          const caseOffset = peek().offset;
          const value = expression(7);
          expect('?'); expect('(');
          const body = sequence([')']);
          expect(')');
          branches.push({ condition: { kind: 'binary', operator: '==', left: selector, right: value }, statements: body });
          if (peek().value === ';') take();
          else if (peek().value !== 'endswitch' && peek().kind !== 'eof') throw new ReferenceSyntaxError('Expected switch case separator', caseOffset);
        }
        if (branches.length === 0) throw new ReferenceSyntaxError('Switch requires at least one literal case', peek().offset);
        const hasEnd = peek().value === 'endswitch';
        if (hasEnd) take();
        else if (recover && (peek().kind === 'eof' || peek().kind === 'directive' || peek().kind === 'identifier')) record('missing-endswitch', peek().offset, 'Closed the observed switch at the end of its contiguous literal?(body) cases, before the following statement or EOF.');
        else throw new ReferenceSyntaxError('Expected endswitch', peek().offset);
        record('switch-to-if', start.offset, 'Preserved ordered equality cases in one if AST; only the first matching body executes, with no default or fallthrough.');
        statements.push({ kind: 'if', branches, otherwise: [] });
        if (!hasEnd) continue;
      } else if (start.value === 'while') {
        take(); const condition = expression(0, true);
        if (peek().value === ';') take();
        const body = sequence(['end']);
        if (peek().value === 'end') take();
        else if (recover && peek().kind === 'eof') record('missing-loop-end', peek().offset, 'Closed the original while block at EOF.');
        else throw new ReferenceSyntaxError('Expected end for while', peek().offset);
        statements.push({ kind: 'while', condition, statements: body });
      } else if (start.value === 'if' || (recover && start.value === 'elseif')) {
        take();
        if (start.value === 'elseif') record('orphan-elseif', start.offset, 'An orphan elseif is compiled as a new independent conditional.');
        const branches: Extract<ReferenceStatement, { kind: 'if' }>['branches'] = [];
        const condition = expression(0, true);
        if (peek().value === ';') take();
        branches.push({ condition, statements: sequence(['elseif', 'else', 'endif']) });
        let otherwise: ReferenceStatement[] = [];
        let usedConditionlessElseif = false;
        while (peek().value === 'elseif') {
          const branchToken = take();
          if (recover && (peek().value === ';' || peek().kind === 'eof')) {
            record('conditionless-elseif', branchToken.offset, 'Conditionless elseif is designed as else.');
            if (peek().value === ';') take();
            otherwise = sequence(['endif']);
            usedConditionlessElseif = true;
            break;
          }
          const nextCondition = expression(0, true);
          if (peek().value === ';') take();
          branches.push({ condition: nextCondition, statements: sequence(['elseif', 'else', 'endif']) });
        }
        if (!usedConditionlessElseif && peek().value === 'else') { take(); if (peek().value === ';') take(); otherwise = sequence(['endif']); }
        if (peek().value === 'endif') take();
        else if (recover && peek().kind === 'eof') record('missing-endif', peek().offset, 'Closed the original conditional at EOF.');
        else throw new ReferenceSyntaxError('Expected endif, found end of input', peek().offset);
        const conditional: Extract<ReferenceStatement, { kind: 'if' }> = { kind: 'if', branches, otherwise };
        const prior = statements.at(-1);
        if (start.value === 'elseif' && prior?.kind === 'if') { prior.branches.push(...branches); prior.otherwise = otherwise; }
        else statements.push(conditional);
      } else if (recover && ['endif', 'end', ')', ']'].includes(start.value)) {
        take(); record('unmatched-close', start.offset, `Ignored unmatched ${start.value}; source remains unchanged in private provenance.`);
      } else if (recover && start.value === 'else') {
        take(); if (peek().value === ';') take();
        const otherwise = sequence(['endif']);
        const prior = statements.at(-1);
        if (prior?.kind === 'if') prior.otherwise = otherwise;
        else statements.push({ kind: 'if', branches: [], otherwise });
        record('orphan-else', start.offset, 'Attached orphan else to the preceding conditional, or compiled an unconditional else block when no conditional exists.');
        if (peek().value === 'endif') take();
      } else {
        const target = expression();
        if (peek().value === '=') {
          if (target.kind !== 'identifier' && target.kind !== 'index') throw new ReferenceSyntaxError('Assignment target must be an identifier or index', peek().offset);
          take(); statements.push({ kind: 'assignment', target, value: expression() });
        } else statements.push({ kind: 'expression', expression: target });
      }
      if (peek().value === ';') take();
      else if (peek().kind !== 'eof' && !stops.includes(peek().value) && !(recover && ['endif', 'end', 'else', 'elseif', ')', ']'].includes(peek().value))) throw new ReferenceSyntaxError('Expected statement separator', peek().offset);
    }
    return statements;
  };
  const statements = sequence();
  if (peek().kind !== 'eof') throw new ReferenceSyntaxError('Unexpected trailing syntax', peek().offset);
  return { kind: 'reference-syntax-program', grammarVersion: 2, semantics: 'syntax-only', designDecisions, statements };
}
