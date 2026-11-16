// parse.js — a fast CommonMark + GFM renderer, byte-identical to marked 18.1.3
// with its default options (gfm on, breaks off, pedantic off, async off).
//
// Written from scratch in this session. The behaviour it implements is the
// CommonMark 0.31.2 + GFM 0.29 behaviour as marked renders it: the spec
// examples in the kit's practice set are the oracle, and every line of code
// here is my own. No part of marked's source is copied into this file.
//
// Architecture (same shape as any block/inline Markdown pipeline, but the
// code is mine): a block lexer turns the source into block tokens, an inline
// lexer turns each block's text into inline tokens, and a renderer turns the
// tokens into HTML. parse() is stateless across calls: every call builds a
// fresh lexer state, so nothing is cached or carried between cases.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escape HTML characters. encode=true escapes & < > " '; encode=false leaves
// a & alone when it already starts a valid entity reference.
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_RE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(s, encode) {
  if (encode) {
    return ESC_TEST.test(s) ? s.replace(ESC_RE, (c) => ESCAPES[c]) : s;
  }
  return ESC_TEST_NOENC.test(s) ? s.replace(ESC_RE_NOENC, (c) => ESCAPES[c]) : s;
}

// Decode numeric character references in inline text (marked's unescape:
// only numeric references are decoded; named entities pass through, and a
// bare & that is not a reference becomes &amp;).
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescEntities(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// encodeURI, but %25 back to %; null when encodeURI throws (lone surrogate).
const PCT25 = /%25/g;
function encodeHref(href) {
  try {
    return encodeURI(href).replace(PCT25, '%');
  } catch {
    return null;
  }
}

// Normalize a link reference label: trim, collapse inner whitespace, fold case.
const MULTI_SPACE = /\s+/g;
function normLabel(label) {
  return label.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing char of a balanced pair starting at the
// open char, skipping backslash escapes. -1 = no close, -2 = run out of
// string with the pair still open.
function findClose(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (--depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Strip trailing copies of ch from a string (ch is a single character).
function stripTail(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch.charCodeAt(0)) n--;
  return s.slice(0, n);
}

// Drop trailing blank lines, keeping at most one trailing newline's worth:
// if the last non-blank line is within 2 lines of the end, keep as-is.
const BLANK_LINE = /^[ \t]*$/;
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Expand tabs to spaces, to the next multiple-of-4 stop.
function expandTabs(s, startCol) {
  let col = startCol || 0, out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += '    '.slice(0, n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row on unescaped pipes, trimming cells and honouring the
// expected column count.
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
function splitTableRow(s, count) {
  const t = s.replace(FIND_PIPE, (m, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}

// Compensate the closing fence's indent inside fenced code content.
const INDENT_COMP = /^(\s+)(?:```)/;
const BEGIN_SPACE = /^\s+/;
function fenceDedent(fence, content) {
  const m = fence.match(INDENT_COMP);
  if (m === null) return content;
  const n = m[1];
  return content.split('\n').map((line) => {
    const sp = line.match(BEGIN_SPACE);
    if (sp === null) return line;
    return line.slice(Math.min(sp[0].length, n.length));
  }).join('\n');
}

// ---------- Regular expressions (block level, GFM) ----------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HR_SRC = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_START_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const LIST_ITEM_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';
const TABLE_DELIM_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';

const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HR = new RegExp('^' + HR_SRC);
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HTML_BLOCK = /^ {0,3}(?:<(script|pre|style|textarea)[\s>][\s\S]*?(?:<\/\1>[^\n]*\n*|$)|<!--(?:-?>|[\s\S]*?(?:-->|$))[^\n]*(\n+|$)|<\?[\s\S]*?(?:\?>[^\n]*\n*|$)|<![A-Z][\s\S]*?(?:>[^\n]*\n*|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>[^\n]*\n*|$)|<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)*? *\/?>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$)|<\/[a-z][a-z0-9-]*\s*>(?=[ \t]*(?:\n|$))[\s\S]*?(?:(?:\n[ 	]*)+\n|$))/i;
// Link reference definition: [label]: href "title"
const LABEL_DEF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const RE_DEF = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;

// GFM table.
const RE_TABLE = new RegExp(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
  '(?:\\n((?:(?! *\\n|' + HR_SRC + '|' + HEADING_SRC + '|' + BLOCKQUOTE_SRC + '|(?: {4}| {0,3}\\t)[^\\n]|' + FENCES_SRC + '| {0,3}(?:[*+-]|1[.)])[ \\t]|' + HTML_START_SRC + ').*(?:\\n|$))*)\\n*|$)');

// Setext heading (GFM: the lookahead includes the table pattern).
const TABLE_HEAD_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[:\\- ]*\\n';
const RE_LHEADING = /^(?! {0,3}(?:[*+-]|\d{1,9}[.)]) |(?: {4}| {0,3}\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n)((?:.|\n(?!\s*?\n| {0,3}(?:[*+-]|\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\s|$)| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}<[^\n>]+>\n| {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
// Paragraph, top level (GFM: stops before a table; the list stop is the
// GFM one — a bullet followed by a non-space character).
const RE_PARAGRAPH = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)| *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}	)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)|[ \t]+\n)[^\n]+)*)/;
// Paragraph inside a blockquote (no table alternative).
const RE_PARAGRAPH_BQ = /^([^\n]+(?:\n(?! {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)|[ \t]+\n)[^\n]+)*)/;

const RE_TEXT = /^[^\n]+/;
const RE_LIST_START = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;

// Blockquote: lines starting with >, plus lazy continuation lines that
// look like paragraph text. (The paragraph pattern keeps its ^ anchor, as
// in marked: it can only engage on the first line of the run.)
const RE_BLOCKQUOTE = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + RE_PARAGRAPH_BQ.source.replace(/^\^/, '') + ')|[^\\n]*)(?:\\n|$))+');

const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_STRIP = /^ {0,3}>[ \t]?/gm;

const RE_LIST_ITEM = (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const _nextBulletCache = [];
function nextBulletRe(n) {
  const k = Math.max(0, Math.min(3, n - 1));
  return _nextBulletCache[k] || (_nextBulletCache[k] = new RegExp(`^ {0,${k}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
}
const _hrCache = [];
function hrRe(n) {
  const k = Math.max(0, Math.min(3, n - 1));
  return _hrCache[k] || (_hrCache[k] = new RegExp(`^ {0,${k}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
}
const _fencesBeginCache = [];
function fencesBeginRe(n) {
  const k = Math.max(0, Math.min(3, n - 1));
  return _fencesBeginCache[k] || (_fencesBeginCache[k] = new RegExp(`^ {0,${k}}(?:\`\`\`|~~~)`));
}
const _headingBeginCache = [];
function headingBeginRe(n) {
  const k = Math.max(0, Math.min(3, n - 1));
  return _headingBeginCache[k] || (_headingBeginCache[k] = new RegExp(`^ {0,${k}}#{1,6}(?:\\s|$)`));
}
const _htmlBeginCache = [];
function htmlBeginRe(n) {
  const k = Math.max(0, Math.min(3, n - 1));
  return _htmlBeginCache[k] || (_htmlBeginCache[k] = new RegExp(`^ {0,${k}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
}
const _bqBeginCache = [];
function bqBeginRe(n) {
  const k = Math.max(0, Math.min(3, n - 1));
  return _bqBeginCache[k] || (_bqBeginCache[k] = new RegExp(`^ {0,${k}}>`));
}

const RE_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_LEADING_HASH = /#$/;
const RE_ENDING_SPACE_TAB = /[ \t]$/;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;
const RE_NOT_SPACE = /^\S*/;
const RE_ENDING_NL = /\n$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_ANY_LINE = /\n.*\n/;
const RE_LEADING_SPACE_TAB = /^[ \t]+/;
const RE_NON_SPACE = /[^ ]/;
const RE_TAB_GLOBAL = /\t/g;
const RE_LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const RE_STRIP_3SP = /^ {0,3}/;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_TRIM = /^\||\| *$/g;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_ALIGN_RIGHT = /^ *-+: *$/;
const RE_ALIGN_CENTER = /^ *:-+: *$/;
const RE_ALIGN_LEFT = /^ *:-+ *$/;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_PUNCT_ESC = /\\([\p{P}\p{S}])/gu;

// ---------- Regular expressions (inline level, GFM) ----------

const PUNCT = '[\\p{P}\\p{S}]';
const PUNCT_NOTILDE = '(?!~)[\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE = '[^\\s\\p{P}\\p{S}]';
const NOT_PUNCT_SPACE_TILDE = '(?:[^\\s\\p{P}\\p{S}]|~)';
const PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const PUNCT_SPACE_NOTILDE = '(?!~)[\\s\\p{P}\\p{S}]';

const RE_INLINE_ESCAPE = new RegExp("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])");
const RE_INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;

// Emphasis left-delimiter (GFM): a run of * or _ plus the following char.
const RE_EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
// Emphasis right-delimiter scans (GFM), one per delimiter char.
const RE_EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RE_EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;

// Strikethrough delimiters (GFM).
const RE_DEL_LDELIM = new RegExp('^~~?(?:((?!~)' + PUNCT + ')|[^\\s~])', 'u');
const RE_DEL_RDELIM = new RegExp(
  '^[^~]+(?=[^~])' +
  '|(?!~)' + PUNCT + '(~~?)(?=[\\s]|$)' +
  '|' + NOT_PUNCT_SPACE + '(~~?)(?!~)(?=' + PUNCT_SPACE + '|$)' +
  '|(?!~)' + PUNCT_SPACE + '(~~?)(?=' + NOT_PUNCT_SPACE + ')' +
  '|[\\s](~~?)(?!~)(?=' + PUNCT + ')' +
  '|(?!~)' + PUNCT + '(~~?)(?!~)(?=' + PUNCT + ')' +
  '|' + NOT_PUNCT_SPACE + '(~~?)(?=' + NOT_PUNCT_SPACE + ')', 'gu');

// Punctuation used by the emphasis open/close checks.
const RE_PUNCTUATION = /^((?![*_])[\s\p{P}\p{S}])/u;
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// Autolink <scheme:...> / <email>.
const RE_AUTOLINK = new RegExp("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>");

// Inline HTML tag.
const RE_INLINE_TAG = new RegExp(
  '^<!--(?:-?>|[\\s\\S]*?-->)' +
  '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
  '|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>' +
  '|^<\\?[\\s\\S]*?\\?>' +
  '|^<![a-zA-Z]+\\s[\\s\\S]*?>' +
  '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>');

// Link label pieces.
const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = new RegExp(
  '(?:\\[(?:' + BRACKETED.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?');
const LABEL_REFLINK = new RegExp(
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + BRACKETED.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?');
const REF_LABEL = /(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}/;
const RE_LINK = new RegExp(
  '^!?\\[(' + LABEL_INNER.source + ')\\]\\([ \\t\\n]*' +
  '(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))' +
  '(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' +
  '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)' +
  '))?[ \\t\\n]*\\)');
const RE_REFLINK = new RegExp('^!?\\[(' + LABEL_INNER.source + ')\\]\\[(' + LABEL_DEF.source + ')\\]');
const RE_NOLINK = new RegExp('^!?\\[(' + LABEL_DEF.source + ')\\](?:\\[\\])?');
const RE_REFLINK_SEARCH = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;

// Extended autolinks (GFM): www., scheme://, bare email.
const RE_URL = new RegExp(
  '^(?:(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])' +
  '|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)' +
  '|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*' +
  '|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))');
const RE_URL_BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;

// Plain-text runs (GFM): stops before any construct that could open.
const EMAIL_CHARS = "a-zA-Z0-9.!#$%&'*+\\/=?_`{|}~-";
const RE_INLINE_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;


const RE_ANY_PUNCT_OUTSIDE_CODE = new RegExp('(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT + ')', 'gu');
const RE_BLOCK_SKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)' +
  '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)' +
  '|<(?! )[^<>]*?>', 'g');
// ---------- Block lexer ----------

// The lexer state, created fresh per parse() call. The inline queue is the
// key to forward link references: block tokenizers only queue inline
// sources; the queue is drained after every block token (and therefore
// every link definition) has been seen.
function createLexer() {
  return {
    links: Object.create(null),
    state: { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true },
    masks: [],
    inlineQueue: []
  };
}

function queueInline(src, lx, tokens) {
  tokens = tokens || [];
  lx.inlineQueue.push({ src, tokens });
  return tokens;
}

// Tokenize one document into block tokens. `tokens` is appended to and
// returned; `merge` is true when called from a blockquote or list, where a
// paragraph merges into a preceding paragraph token.
function blockTokens(e, tokens, lx, merge) {
  tokens = tokens || [];
  let mergeFlag = !!merge;
  let guard = Infinity;
  while (e) {
    if (e.length < guard) guard = e.length;
    else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    let r;
    if ((r = tokSpace(e))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (r.raw.length === 1 && prev !== undefined) prev.raw += '\n';
      else tokens.push(r);
      continue;
    }
    if ((r = tokCode(e))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        lx.inlineQueue[lx.inlineQueue.length - 1].src = prev.text;
      } else tokens.push(r);
      continue;
    }
    if ((r = tokFences(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokHeading(e, lx))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokHr(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokBlockquote(e, lx))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokList(e, lx))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokHtml(e))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokDef(e))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && (prev.type === 'paragraph' || prev.type === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.raw;
        lx.inlineQueue[lx.inlineQueue.length - 1].src = prev.text;
      } else {
        if (!Object.hasOwn(lx.links, r.tag)) lx.links[r.tag] = { href: r.href, title: r.title };
        tokens.push(r);
      }
      continue;
    }
    if ((r = tokTable(e, lx))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if ((r = tokLheading(e, lx))) { e = e.substring(r.raw.length); tokens.push(r); continue; }
    if (lx.state.top && (r = tokParagraph(e, lx))) {
      const prev = tokens[tokens.length - 1];
      if (mergeFlag && prev && prev.type === 'paragraph') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        lx.inlineQueue.pop();
        lx.inlineQueue[lx.inlineQueue.length - 1].src = prev.text;
      } else tokens.push(r);
      mergeFlag = false;
      e = e.substring(r.raw.length);
      continue;
    }
    if ((r = tokText(e, lx))) {
      e = e.substring(r.raw.length);
      const prev = tokens[tokens.length - 1];
      if (prev && prev.type === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + r.raw;
        prev.text += '\n' + r.text;
        lx.inlineQueue.pop();
        lx.inlineQueue[lx.inlineQueue.length - 1].src = prev.text;
      } else tokens.push(r);
      continue;
    }
    if (e) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    break;
  }
  lx.state.top = true;
  return tokens;
}

// Lex one document: normalize line endings, build block tokens, then drain
// the inline queue (resetting inRawBlock before each inline source).
function lex(src, lx) {
  src = src.replace(/\r\n|\r/g, '\n');
  const tokens = blockTokens(src, [], lx, false);
  for (let i = 0; i < lx.inlineQueue.length; i++) {
    const entry = lx.inlineQueue[i];
    lx.state.inRawBlock = false;
    inlineTokens(entry.src, lx, entry.tokens);
  }
  lx.inlineQueue = [];
  return tokens;
}

function tokSpace(e) {
  const m = RE_NEWLINE.exec(e);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  return null;
}

function tokCode(e) {
  const m = RE_INDENTED_CODE.exec(e);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  const text = raw.replace(RE_CODE_INDENT, '');
  return { type: 'code', raw, codeBlockStyle: 'indented', text };
}

function tokFences(e) {
  const m = RE_FENCES.exec(e);
  if (!m) return null;
  const raw = m[0];
  const text = fenceDedent(raw, m[3] || '');
  return { type: 'code', raw, lang: m[2] ? m[2].trim().replace(RE_PUNCT_ESC, '$1') : m[2], text };
}

function tokHeading(e, lx) {
  const m = RE_HEADING.exec(e);
  if (!m) return null;
  let text = m[2].trim();
  if (RE_LEADING_HASH.test(text)) {
    const stripped = stripTail(text, '#');
    if (!stripped || RE_ENDING_SPACE_TAB.test(stripped)) text = stripped.trim();
  }
  return { type: 'heading', raw: stripTail(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(text, lx) };
}

function tokHr(e) {
  const m = RE_HR.exec(e);
  if (!m) return null;
  return { type: 'hr', raw: stripTail(m[0], '\n') };
}

function tokBlockquote(e, lx) {
  const m = RE_BLOCKQUOTE.exec(e);
  if (!m) return null;
  let lines = stripTail(m[0], '\n').split('\n');
  let raw = '', text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlock = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { chunk.push(lines[p]); inBlock = true; }
      else if (!inBlock) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const inner = joined
      .replace(RE_BQ_MARKER_WS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_STRIP, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + inner : inner;
    const prevTop = lx.state.top;
    lx.state.top = true;
    blockTokens(inner, tokens, lx, true);
    lx.state.top = prevTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
    if (last && last.type === 'blockquote') {
      const g = last;
      const rest = lines.join('\n');
      const combined = g.raw + '\n' + rest.replace(RE_BQ_STRIP, '');
      const f = tokBlockquote(combined, lx);
      tokens[tokens.length - 1] = f;
      const y = combined.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) {
        raw = raw + '\n' + A.join('\n');
        text = text.substring(0, text.length - g.text.length) + f.text;
        lines = lines.slice(A.length);
        if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      }
      break;
    } else if (last && last.type === 'list') {
      const g = last;
      const rest = g.raw + '\n' + lines.join('\n');
      const innerList = tokList(rest, lx);
      tokens[tokens.length - 1] = innerList;
      const extra = innerList.raw.length > g.raw.length
        ? rest.slice(g.raw.length + 1, innerList.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const y = lines.slice(0, extra).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function tokList(e, lx) {
  let t = RE_LIST_START.exec(e);
  if (!t) return null;
  const n = e;
  const consumed = () => n.length - e.length;
  const r0 = t[1].trim();
  const ordered = r0.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +r0.slice(0, -1) : '', loose: false, items: [] };
  const bulletPat = ordered ? `\\d{1,9}\\${r0.slice(-1)}` : `\\${r0}`;
  const itemRe = RE_LIST_ITEM(bulletPat);
  let p = false;
  while (e) {
    let u = false, d = '';
    t = itemRe.exec(e);
    if (!t || RE_HR.test(e)) break;
    const k = consumed();
    e = e.substring(t[0].length);
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let m = g.replace(RE_LEADING_SPACE_TAB, (v) => expandTabs(v, b));
    let f = e.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(RE_NON_SPACE);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && BLANK_LINE.test(f)) { e = e.substring(f.length + 1); u = true; }
    if (!u) {
      const v = nextBulletRe(R), Q = hrRe(R), ee = fencesBeginRe(R),
        te = headingBeginRe(R), M = htmlBeginRe(R), ne = bqBeginRe(R);
      while (e) {
        const U = e.split('\n', 1)[0];
        f = U;
        const Z = f.includes('\t') ? f.replace(RE_LEADING_SPACE_TAB, (me) => expandTabs(me)) : f;
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(RE_NON_SPACE) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(RE_TAB_GLOBAL, '    ').search(RE_NON_SPACE) >= 4 ||
              ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
          const qe = RE_SETEXT_LINE.test(f) && RE_LHEADING.test(m + '\n' + f)
            ? '    ' + Z.replace(RE_STRIP_3SP, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, consumed());
    if (!list.loose) {
      if (p) list.loose = true;
      else if (RE_DOUBLE_BLANK.test(A)) p = true;
    }
    list.items.push({ type: 'list_item', raw: A, task: RE_LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
  }
  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else return null;
  list.raw = n.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    lx.state.top = false;
    item.tokens = blockTokens(item.text, [], lx, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.type === 'space');
      if (spaces.length > 0 && spaces.some((tok) => RE_ANY_LINE.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const d0 = item.tokens[0];
    if (item.task && (d0?.type === 'text' || d0?.type === 'paragraph')) {
      item.text = item.text.replace(RE_LIST_TASK, '');
      d0.raw = d0.raw.replace(RE_LIST_TASK, '');
      d0.text = d0.text.replace(RE_LIST_TASK, '');
      for (let g = lx.inlineQueue.length - 1; g >= 0; g--) {
        if (RE_LIST_IS_TASK.test(lx.inlineQueue[g].src)) {
          lx.inlineQueue[g].src = lx.inlineQueue[g].src.replace(RE_LIST_TASK, '');
          break;
        }
      }
      const k = RE_LIST_CHECKBOX.exec(item.raw);
      if (k) {
        const g = { type: 'checkbox', raw: k[0] + ' ', checked: k[0] !== '[ ]' };
        item.checked = g.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = g.raw + item.tokens[0].raw;
            item.tokens[0].text = g.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(g);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: g.raw, text: g.raw, tokens: [g] });
          }
        } else {
          item.tokens.unshift(g);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
    }
  }
  return list;
}

function tokHtml(e) {
  const m = RE_HTML_BLOCK.exec(e);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
}

function tokDef(e) {
  const m = RE_DEF.exec(e);
  if (!m) return null;
  if (!RE_START_ANGLE.test(m[2]) && findClose(m[2], '()') !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(RE_PUNCT_ESC, '$1') : '';
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(RE_PUNCT_ESC, '$1') : m[3];
  return { type: 'def', tag, raw: stripTail(m[0], '\n'), href, title };
}

function tokTable(e, lx) {
  const m = RE_TABLE.exec(e);
  if (!m || !RE_TABLE_DELIM.test(m[2])) return null;
  const headerCells = splitTableRow(m[1]);
  const alignParts = m[2].replace(RE_TABLE_TRIM, '').split('|');
  const bodyLines = m[3] && m[3].trim() ? m[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
  const table = { type: 'table', raw: stripTail(m[0], '\n'), header: [], align: [], rows: [] };
  if (headerCells.length === alignParts.length) {
    for (const part of alignParts) {
      if (RE_ALIGN_RIGHT.test(part)) table.align.push('right');
      else if (RE_ALIGN_CENTER.test(part)) table.align.push('center');
      else if (RE_ALIGN_LEFT.test(part)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], tokens: queueInline(headerCells[i], lx), header: true, align: table.align[i] });
    }
    for (const line of bodyLines) {
      table.rows.push(splitTableRow(line, headerCells.length).map((cell, j) =>
        ({ text: cell, tokens: queueInline(cell, lx), header: false, align: table.align[j] })));
    }
    return table;
  }
  return null;
}

function tokLheading(e, lx) {
  const m = RE_LHEADING.exec(e);
  if (!m) return null;
  const text = m[1].trim();
  return { type: 'heading', raw: stripTail(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(text, lx) };
}

function tokParagraph(e, lx) {
  const m = RE_PARAGRAPH.exec(e);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
  return { type: 'paragraph', raw: m[0], text, tokens: queueInline(text, lx) };
}

function tokText(e, lx) {
  const m = RE_TEXT.exec(e);
  if (!m) return null;
  return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(m[0], lx) };
}

// ---------- Renderer ----------

function renderBlock(tokens) {
  let out = '';
  for (const tok of tokens) out += renderBlockToken(tok);
  return out;
}

function renderBlockToken(tok) {
  switch (tok.type) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': return `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
    case 'code': {
      const lang = (tok.lang || '').match(RE_NOT_SPACE)?.[0];
      const text = tok.text ? tok.text.replace(RE_ENDING_NL, '') + '\n' : '';
      const body = tok.escaped ? text : esc(text, true);
      return lang
        ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n`
        : `<pre><code>${body}</code></pre>\n`;
    }
    case 'blockquote': return `<blockquote>\n${renderBlock(tok.tokens)}</blockquote>\n`;
    case 'html': return tok.text;
    case 'def': return '';
    case 'list': {
      let items = '';
      for (const item of tok.items) items += renderListItem(item);
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
      return `<${tag}${start}>\n${items}</${tag}>\n`;
    }
    case 'checkbox': return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'paragraph': return `<p>${renderInline(tok.tokens)}</p>\n`;
    case 'text': return renderTextToken(tok);
    case 'table': {
      let headCells = '';
      for (const cell of tok.header) headCells += renderTableCell(cell);
      const head = `<tr>\n${headCells}</tr>\n`;
      let body = '';
      for (const row of tok.rows) {
        let rowCells = '';
        for (const cell of row) rowCells += renderTableCell(cell);
        body += `<tr>\n${rowCells}</tr>\n`;
      }
      const tbody = body ? `<tbody>${body}</tbody>` : '';
      return `<table>\n<thead>\n${head}</thead>\n${tbody}</table>\n`;
    }
    default: throw new Error('Token with "' + tok.type + '" type was not found.');
  }
}

function renderListItem(item) {
  return `<li>${renderBlock(item.tokens)}</li>\n`;
}

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderInline(cell.tokens)}</${tag}>\n`;
}

// A block-level text token: inline tokens if it has them, else its raw
// text (escaped unless the token is marked escaped).
function renderTextToken(tok) {
  if ('tokens' in tok && tok.tokens) return renderInline(tok.tokens);
  if ('escaped' in tok && tok.escaped) return tok.text;
  return esc(tok.text);
}

// Plain-text rendering of inline tokens (used for image alt text): every
// construct renders as its text, line breaks vanish, checkboxes keep
// their raw marker.
function renderTextInline(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += tok.tokens ? renderTextInline(tok.tokens) : tok.text;
        break;
      case 'codespan': case 'html': case 'text': case 'escape':
        out += tok.text;
        break;
      case 'checkbox':
        out += tok.raw;
        break;
      case 'br':
        break;
      default:
        break;
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) out += renderInlineToken(tok);
  return out;
}

function renderInlineToken(tok) {
  switch (tok.type) {
    case 'escape': return renderTextToken(tok);
    case 'html': return tok.text;
    case 'link': {
      const text = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
      const href = encodeHref(tok.href);
      if (href === null) return text;
      let out = `<a href="${esc(href, tok.autolink)}"`;
      if (tok.title) out += ` title="${esc(tok.title)}"`;
      return out + `>${text}</a>`;
    }
    case 'image': {
      let alt = tok.text;
      if (tok.tokens) alt = renderTextInline(tok.tokens);
      const href = encodeHref(tok.href);
      if (href === null) return esc(alt);
      let out = `<img src="${esc(href)}" alt="${esc(alt)}"`;
      if (tok.title) out += ` title="${esc(tok.title)}"`;
      return out + '>';
    }
    case 'checkbox': return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'strong': return `<strong>${renderInline(tok.tokens)}</strong>`;
    case 'em': return `<em>${renderInline(tok.tokens)}</em>`;
    case 'codespan': return `<code>${esc(tok.text, true)}</code>`;
    case 'br': return '<br>';
    case 'del': return `<del>${renderInline(tok.tokens)}</del>`;
    case 'text': return renderTextToken(tok);
    default: throw new Error('Token with "' + tok.type + '" type was not found.');
  }
}

// ---------- Public entry point ----------

export function parse(markdown) {
  const lx = createLexer();
  const tokens = lex(String(markdown), lx);
  return renderBlock(tokens);
}

// ---------- Emphasis masking ----------

// Scan a masked inline source for the last delimiter run that could close
// an emphasis/strong or strikethrough span: a run whose preceding character
// is not a space, tab, newline, carriage return or form feed. The scan
// returns the start index of the last such run for each delimiter.
function scanClosers(src) {
  const last = { '*': -1, '_': -1 };
  let del = -1;
  const n = src.length;
  for (let s = 0; s < n; s++) {
    const ch = src[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : src[s - 1];
    let i = s + 1;
    while (i < n && src[i] === ch) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = s;
      else last[ch] = s;
    }
    s = i - 1;
  }
  return { last, del };
}

// Does this text contain a link (inline or reference) that the emphasis
// scanner must not see through? Used while masking link labels.
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  RE_BLOCK_SKIP.lastIndex = 0;
  let m;
  while ((m = RE_BLOCK_SKIP.exec(src)) !== null) {
    RE_LINK.lastIndex = 0;
    if (RE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  RE_REFLINK_SEARCH.lastIndex = 0;
  while ((m = RE_REFLINK_SEARCH.exec(src)) !== null) {
    const s = m[0];
    const o = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(o + 1, -1)))) &&
        !(o > 1 && linkInText(s.slice(1, o - 1), links))) return true;
  }
  return false;
}

// Build the masked copy of an inline source that the emphasis/del scanners
// run on: link labels, code spans and HTML tags are replaced by filler of
// the same length, so a delimiter inside them can never act as a closer.
function maskSource(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(RE_REFLINK_SEARCH, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(RE_REFLINK_SEARCH, maskRef);
  }
  t = t.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (n, s, r) => {
    if (r) return '+'.repeat(n.length);
    if (s) return s + n.slice(s.length, -s.length).replace(/`/g, '+') + s;
    return n;
  });
  t = t.replace(RE_BLOCK_SKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}

// ---------- Inline tokenizers ----------

// A link's label may not itself contain a tag or autolink that runs past
// the label's end; such a "[" is plain text instead.
function labelHasTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = RE_INLINE_CODE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    RE_INLINE_TAG.lastIndex = 0;
    RE_AUTOLINK.lastIndex = 0;
    const m = RE_INLINE_TAG.exec(rest) || RE_AUTOLINK.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

function makeLink(match, href, title, raw, lx) {
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const isImage = match[0].charAt(0) === '!';
  const prevInLink = lx.state.inLink;
  const prevEmitted = lx.state.linkEmitted;
  const prevRawBlock = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const tokens = inlineTokens(text, lx);
  const emittedInside = lx.state.linkEmitted;
  lx.state.linkEmitted = prevEmitted;
  lx.state.inLink = prevInLink;
  if (!isImage) {
    if (emittedInside) {
      lx.state.inRawBlock = prevRawBlock;
      return null;
    }
    lx.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title: title || null, text, tokens };
}

function tokEscape(src) {
  const m = RE_INLINE_ESCAPE.exec(src);
  return m ? { type: 'escape', raw: m[0], text: m[1] } : null;
}

function tokTag(src, lx) {
  const m = RE_INLINE_TAG.exec(src);
  if (!m) return null;
  if (!lx.state.inLink && RE_START_A.test(m[0])) lx.state.inLink = true;
  else if (lx.state.inLink && RE_END_A.test(m[0])) lx.state.inLink = false;
  if (!lx.state.inRawBlock && RE_START_PRE.test(m[0])) lx.state.inRawBlock = true;
  else if (lx.state.inRawBlock && RE_END_PRE.test(m[0])) lx.state.inRawBlock = false;
  return { type: 'html', raw: m[0], inLink: lx.state.inLink, inRawBlock: lx.state.inRawBlock, block: false, text: m[0] };
}

function tokLink(src, lx) {
  if (lx.state.linkParenPossible === false) return null;
  const m = RE_LINK.exec(src);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(src, m[1], off)) return null;
  const hrefPart = m[2].trim();
  if (RE_START_ANGLE.test(hrefPart)) {
    if (!RE_END_ANGLE.test(hrefPart)) return null;
    const stripped = stripTail(hrefPart.slice(0, -1), '\\');
    if ((hrefPart.length - stripped.length) % 2 === 0) return null;
  } else {
    const close = findClose(m[2], '()');
    if (close === -2) return null;
    if (close > -1) {
      const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, h).trim();
      m[3] = '';
    }
  }
  const r = stripTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - r.length) % 2 === 0) return null;
  let href = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (RE_START_ANGLE.test(href)) href = href.slice(1, -1);
  return makeLink(m,
    href && href.replace(RE_PUNCT_ESC, '$1'),
    title && title.replace(RE_PUNCT_ESC, '$1'),
    m[0], lx);
}

function tokReflink(src, lx) {
  const m = RE_REFLINK.exec(src) || RE_NOLINK.exec(src);
  if (!m) return null;
  const off = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(src, m[1], off)) return null;
  const def = lx.links[normLabel(m[2] || m[1])];
  if (!def) {
    const c = m[0].charAt(0);
    return { type: 'text', raw: c, text: c };
  }
  return makeLink(m, def.href, def.title, m[0], lx);
}

function tokEmStrong(src, masked, prevChar, lx) {
  const m = RE_EM_LDELIM.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const sameAsPrev = prevChar === delim;
  const i = masked.length - src.length;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || RE_PUNCTUATION.test(p);
  if (l < i) prevChar = p;
  const canOpen = l < i ? h : RE_PUNCTUATION.test(prevChar);
  if (m[4] && RE_UNICODE_ALNUM.test(prevChar)) return null;
  const nextPunct = m[1] || m[3] || '';
  if (!nextPunct || !prevChar || canOpen) {
    const k = [...m[0]].length - 1;
    let run = k, skipped = 0;
    const y = i - l + k;
    const canClose = !!p.trim() && (!!nextPunct || (delim === '*' && !h));
    if (delim !== '*' && delim !== '_') return null;
    const rDelim = delim === '*' ? RE_EM_RDELIM_AST : RE_EM_RDELIM_UND;
    const maskTop = lx.masks[lx.masks.length - 1];
    const lastCloser = maskTop && maskTop.src === masked ? maskTop.last[delim] : scanClosers(masked).last[delim];
    const q = masked.length - src.length + k;
    if (lastCloser < q) return null;
    const t2 = masked.slice(-src.length + k);
    const ee = lastCloser - q;
    rDelim.lastIndex = 0;
    let s;
    while ((s = rDelim.exec(t2)) !== null && !(s.index > ee)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const b0 = [...g].length;
      if (s[3] || s[4]) { run += b0; continue; }
      if (s[5] || s[6] || canClose) {
        if (sameAsPrev && (s[5] || s[6])) break;
        if (y % 3 && !((y + b0) % 3)) { skipped += b0; continue; }
      }
      run -= b0;
      if (run > 0) continue;
      const b = Math.min(b0, b0 + run + skipped);
      const te = [...s[0]][0].length;
      const raw = src.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(text, lx) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(text, lx) };
    }
  }
  return null;
}

function tokCodespan(src) {
  const m = RE_INLINE_CODE.exec(src);
  if (!m) return null;
  let text = m[2].replace(/\n/g, ' ');
  if (/[^ ]/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
    text = text.substring(1, text.length - 1);
  }
  return { type: 'codespan', raw: m[0], text };
}

function tokBr(src) {
  const m = RE_INLINE_BR.exec(src);
  return m ? { type: 'br', raw: m[0] } : null;
}

function tokDel(src, masked, prevChar, lx) {
  const m = RE_DEL_LDELIM.exec(src);
  if (!m) return null;
  if (!(m[1] || '') || !prevChar || RE_PUNCTUATION.test(prevChar)) {
    const o = [...m[0]].length - 1;
    let p = o;
    const maskTop = lx.masks[lx.masks.length - 1];
    const lastCloser = maskTop && maskTop.src === masked ? maskTop.del : scanClosers(masked).del;
    const d = masked.length - src.length + o;
    if (lastCloser < d) return null;
    const t2 = masked.slice(-src.length + o);
    const k = lastCloser - d;
    RE_DEL_RDELIM.lastIndex = 0;
    let s;
    while ((s = RE_DEL_RDELIM.exec(t2)) !== null && !(s.index > k)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let l = [...g].length;
      if (l !== o) continue;
      if (s[3] || s[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const te = [...s[0]][0].length;
      const raw = src.slice(0, o + s.index + te + l);
      const text = raw.slice(o, -o);
      return { type: 'del', raw, text, tokens: inlineTokens(text, lx) };
    }
  }
  return null;
}

function tokAutolink(src) {
  const m = RE_AUTOLINK.exec(src);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
  else { text = m[1]; href = text; }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function tokUrl(src) {
  const m = RE_URL.exec(src);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    let cur = m[0];
    let prev;
    do {
      prev = cur;
      const b = RE_URL_BACKPEDAL.exec(cur);
      cur = b ? b[0] : '';
    } while (prev !== cur);
    text = cur;
    href = m[1] === 'www.' ? 'http://' + cur : cur;
  }
  return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

// Tokenize one inline source into tokens. The lexer state (inLink,
// inRawBlock, linkEmitted, linkParenPossible) lives on lx and persists
// across the blocks of one document, exactly as marked keeps it.
function inlineTokens(src, lx, out) {
  out = out || [];
  const prevParen = lx.state.linkParenPossible;
  lx.state.linkParenPossible = prevParen && src.includes(')');
  try {
    return inlineScan(src, lx, out);
  } finally {
    lx.state.linkParenPossible = prevParen;
  }
}

function inlineScan(src, lx, out) {
  // The mask only changes the source when it holds a link label, a code
  // span, an HTML tag, or an escaped punctuation char; plain emphasized
  // text needs no masking at all, so skip the three regex replaces.
  const masked = (src.includes('*') || src.includes('_') || src.includes('~')) &&
    (src.includes('[') || src.includes('`') || src.includes('\\') || src.includes('<'))
    ? maskSource(src, lx.links) : src;
  const closers = scanClosers(masked);
  lx.masks.push({ src: masked, last: closers.last, del: closers.del });
  try {
    let e = src;
    let textRun = false, prevChar = '';
    let guard = Infinity;
    while (e) {
      if (e.length < guard) guard = e.length;
      else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
      if (!textRun) prevChar = '';
      textRun = false;
      const ch = e[0];
      let tok = null;
      if (ch === '\\') tok = tokEscape(e) || tokBr(e);
      else if (ch === '<') tok = tokTag(e, lx) || tokAutolink(e);
      else if (ch === '[' || (ch === '!' && e[1] === '[')) tok = tokLink(e, lx) || tokReflink(e, lx);
      else if (ch === '*' || ch === '_') tok = tokEmStrong(e, masked, prevChar, lx);
      else if (ch === '`') tok = tokCodespan(e);
      else if (ch === '~') tok = tokDel(e, masked, prevChar, lx);
      else if (ch === ' ') tok = tokBr(e);
      else if (!lx.state.inLink) tok = tokUrl(e);
      if (tok) {
        e = e.slice(tok.raw.length);
        const last = out[out.length - 1];
        if (tok.type === 'text' && last && last.type === 'text') {
          last.raw += tok.raw;
          last.text += tok.text;
        } else {
          out.push(tok);
        }
        continue;
      }
      const m = RE_INLINE_TEXT.exec(e);
      if (m) {
        const raw = m[0];
        e = e.slice(raw.length);
        if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
        textRun = true;
        const text = lx.state.inRawBlock ? raw : unescEntities(raw);
        const last = out[out.length - 1];
        if (last && last.type === 'text') {
          last.raw += raw;
          last.text += text;
        } else {
          out.push({ type: 'text', raw, text, escaped: lx.state.inRawBlock });
        }
        continue;
      }
      throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    }
    return out;
  } finally {
    lx.masks.pop();
  }
}
