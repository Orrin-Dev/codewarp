import type { Skin } from './spec';

export type TokenType = 'ident' | 'num' | 'str' | 'sym' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface Token {
  type: TokenType;
  text: string;
  line: number;
  col: number;
  len: number;
  /** Written in `backticks`, so never a keyword. */
  quoted?: boolean;
}

export class SyntaxFail extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
    readonly len = 1,
  ) {
    super(message);
  }
}

const SYMBOLS = ['&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '(', ')', '{', '}', '[', ']', ',', ';', ':', '.', '=', '<', '>', '+', '-', '*', '/', '%', '!', '@'];

const isIdentStart = (c: string): boolean => /[\p{L}_]/u.test(c);
const isIdentPart = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);

export interface Lexed {
  tokens: Token[];
  /** Ids from "kept:" comments, which keep scripts that the text cannot express. */
  kept: Set<string>;
}

export function lex(source: string, skin: Skin): Lexed {
  const tokens: Token[] = [];
  const kept = new Set<string>();
  const py = skin === 'python';
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let depth = 0; // brackets open (Python ignores line breaks inside them)
  const indents = [0];
  let atLineStart = true;

  const push = (type: TokenType, text: string, start: number, extra: Partial<Token> = {}): void => {
    tokens.push({ type, text, line, col: start - lineStart + 1, len: Math.max(1, i - start), ...extra });
  };
  const noteComment = (text: string): void => {
    const m = /kept:\s+(\S+)/.exec(text);
    if (m) kept.add(m[1]);
  };

  while (i < source.length) {
    if (py && atLineStart && depth > 0 && /[\p{L}@]/u.test(source[i] ?? '')) {
      // A line that starts at the left edge with an unclosed ( above it: the bracket was left open by mistake.
      depth = 0;
      if (tokens.length > 0 && tokens[tokens.length - 1].type !== 'newline') push('newline', '', i);
    }
    if (py && atLineStart && depth === 0) {
      // Measure indentation, skipping blank and comment-only lines.
      let j = i;
      let width = 0;
      while (j < source.length && (source[j] === ' ' || source[j] === '\t')) {
        width += source[j] === '\t' ? 4 : 1;
        j++;
      }
      if (j >= source.length) {
        i = j;
        break;
      }
      if (source[j] === '\n' || source[j] === '\r' || source[j] === '#') {
        if (source[j] === '#') {
          let k = j;
          while (k < source.length && source[k] !== '\n') k++;
          noteComment(source.slice(j, k));
          i = k;
        } else i = j;
        if (source[i] === '\r') i++;
        if (source[i] === '\n') {
          i++;
          line++;
          lineStart = i;
        }
        continue;
      }
      i = j;
      if (width > indents[indents.length - 1]) {
        indents.push(width);
        push('indent', '', j);
      } else {
        while (width < indents[indents.length - 1]) {
          indents.pop();
          push('dedent', '', j);
        }
        if (width !== indents[indents.length - 1]) throw new SyntaxFail('The indentation does not line up with an earlier line', line, 1, Math.max(1, width));
      }
      atLineStart = false;
    }

    const c = source[i];
    if (c === '\n') {
      if (py && depth === 0 && tokens.length > 0 && tokens[tokens.length - 1].type !== 'newline' && tokens[tokens.length - 1].type !== 'indent' && tokens[tokens.length - 1].type !== 'dedent') {
        i++;
        push('newline', '', i - 1);
        line++;
        lineStart = i;
        atLineStart = true;
        continue;
      }
      i++;
      line++;
      lineStart = i;
      atLineStart = true;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    // comments
    if (py ? c === '#' : c === '/' && source[i + 1] === '/') {
      let k = i;
      while (k < source.length && source[k] !== '\n') k++;
      noteComment(source.slice(i, k));
      i = k;
      continue;
    }
    if (!py && c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new SyntaxFail('This comment is never closed with */', line, i - lineStart + 1, 2);
      const text = source.slice(i, end + 2);
      noteComment(text);
      for (const ch of text) {
        if (ch === '\n') {
          line++;
        }
      }
      const lastBreak = text.lastIndexOf('\n');
      if (lastBreak >= 0) lineStart = i + lastBreak + 1;
      i = end + 2;
      continue;
    }
    const start = i;
    if (c === '"') {
      i++;
      let value = '';
      for (;;) {
        if (i >= source.length || source[i] === '\n') throw new SyntaxFail('This text is missing its closing quote', line, start - lineStart + 1, i - start);
        const ch = source[i];
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === '\\') {
          const next = source[i + 1];
          i += 2;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next ?? '';
          continue;
        }
        value += ch;
        i++;
      }
      push('str', value, start);
      continue;
    }
    if (c === '`') {
      i++;
      let value = '';
      for (;;) {
        if (i >= source.length || source[i] === '\n') throw new SyntaxFail('This name is missing its closing `', line, start - lineStart + 1, i - start);
        if (source[i] === '`') {
          i++;
          break;
        }
        if (source[i] === '\\' && i + 1 < source.length) {
          value += source[i + 1];
          i += 2;
          continue;
        }
        value += source[i++];
      }
      push('ident', value, start, { quoted: true });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      while (i < source.length && /[0-9]/.test(source[i])) i++;
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] ?? '')) {
        i++;
        while (i < source.length && /[0-9]/.test(source[i])) i++;
      }
      push('num', source.slice(start, i), start);
      continue;
    }
    if (isIdentStart(c)) {
      while (i < source.length && isIdentPart(source[i])) i++;
      push('ident', source.slice(start, i), start);
      continue;
    }
    const sym = SYMBOLS.find((s) => source.startsWith(s, i));
    if (sym) {
      i += sym.length;
      if (sym === '(' || sym === '[' || sym === '{') depth++;
      else if (sym === ')' || sym === ']' || sym === '}') depth = Math.max(0, depth - 1);
      push('sym', sym, start);
      continue;
    }
    throw new SyntaxFail(`Unexpected character "${c}"`, line, start - lineStart + 1, 1);
  }
  if (py) {
    if (tokens.length > 0 && !['newline', 'dedent', 'indent'].includes(tokens[tokens.length - 1].type)) push('newline', '', i);
    while (indents.length > 1) {
      indents.pop();
      push('dedent', '', i);
    }
  }
  push('eof', '', i);
  return { tokens, kept };
}
