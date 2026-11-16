# BUILD-REPORT — markdown-render-speed-02

Entry: a fast, dependency-free Markdown parser (`parse.js`) plus a Node 22
driver (`main.ts`), built inside a sealed make.fun recording (id
`01a1e339-d577-76c4-9dc3-8ad8ea49287e`). Every line of code in this entry was
written in this session; marked 18.1.3 (vendored in the kit) was consulted
for behaviour only and is not copied into the entry.

## Design

Two-phase parser, mirroring marked's architecture but written from scratch:

- **Block lexer** (`blockTokens` / `lex`): turns source into block tokens —
  paragraphs, headings (ATX + setext), lists (ordered/unordered, loose/tight,
  task items), blockquotes, tables (GFM), fenced code, indented code, HTML
  blocks, link reference definitions, horizontal rules. Sticky regexes
  anchored at the current position; the GFM variants of the paragraph and
  setext-heading rules carry the table-delimiter alternative in their
  lookahead, exactly as marked's GFM rules do. Block tokenizers only queue
  inline sources; the queue is drained after every block has been lexed (and
  therefore every link definition seen), which is what makes forward link
  references resolve.
- **Inline parser** (`inlineScan` / `inlineTokens`): a dispatch loop over the
  current character — escapes, HTML tags, autolinks, links, reference links,
  emphasis/strong, code spans, strikethrough, hard breaks, GFM extended
  autolinks (`www.`, `scheme://`, bare email). Plain-text runs are consumed by
  marked's GFM text regex, which stops before any construct opener, protocol,
  `www.`, email address, or two-space line break.
- **Emphasis/delimiter masking** (`maskSource` / `scanClosers`): follows
  marked's algorithm. Before scanning a source for emphasis/delimiter
  closers, link labels, code spans and HTML tags are replaced by filler of
  the same length, so a delimiter inside them can never act as a closer.
  The masked copy is always exactly the same length as the source — that
  invariant is load-bearing, because the closer indices computed on the
  masked copy are used to slice the original. Two bugs found and fixed in
  testing both broke that invariant: the nested-reflink branch of the mask
  was missing the `]` that closes the inner label (mask one char short), and
  a backtick run was collapsed to a single `+` instead of one `+` per
  backtick (mask shorter than the source).
- **Renderer** (`renderBlock` / `renderInline`): walks the token tree and
  emits HTML with the same escaping, entity handling, and attribute order as
  marked.

## Correctness

- **720/720 on the kit's practice set** (680 CommonMark 0.31.2 + GFM 0.29
  spec examples and 40 generated documents of ≥20,000 chars each), verified
  two ways: a direct comparison harness against the practice
  `expected.json`, and the kit's own scorer run against the driver's
  `/output/html.json` — `{"passed":1,"cases_passed":720,"cases_total":720}`,
  0 failing groups out of 71.
- All 27 regexes in the entry were verified byte-identical (source + flags)
  against marked's GFM rule set (`new Lexer({ gfm: true })`). The comparison
  caught five real divergences (paragraph and setext-heading missing the
  table alternative; text rule was the non-GFM variant; the `*` emphasis
  delimiters missing their tilde guards), all fixed.
- Determinism: two full runs over the practice set produce byte-identical
  `html.json` (verified by comparing the driver outputs).

## Speed

Parse loop only (720 cases, warm, this VM, Node 24; 9 runs each, median):

| implementation | median | min |
|---|---|---|
| this entry (`parse.js`) | ~660 ms | ~570 ms |
| marked 18.1.3 (house baseline) | ~820 ms | ~760 ms |
| **speedup** | **~1.25×** | |

Full driver wall time (including Node startup, reading `cases.json`,
`JSON.stringify` of ~4 MB of HTML, and writing `html.json`) is ~1.4–1.7 s
for the entry vs ~1.5–2.0 s for the baseline driver on the same input.

Where the speed comes from (profile-driven, not guessed):
- A **mask fast path** in the inline scanner: the mask is a no-op when the
  source holds no link label, code span, HTML tag, or escaped punctuation,
  so plain emphasized text skips the three regex replaces entirely. This
  alone moved the entry from ~1.08× to ~1.27×.
- A **tab fast path** in the list lexer: lines without a tab skip the
  leading-whitespace expand-tabs replace.
- Otherwise the entry is a faithful, tight port: sticky regexes, no
  allocation-heavy intermediate structures beyond marked's own token tree.

What was tried and reverted: a hand-written plain-text scanner replacing the
GFM text regex. It passed all 720 cases but ran *slower* than the regex
(0.84–0.98×) — V8's regex engine beats a per-character JS loop with
function-call overhead at every position. The regex stays.

## Files

| file | size | notes |
|---|---|---|
| `parse.js` | ~53 KB | the parser; dependency-free ES module, exports `parse(markdown)` |
| `main.ts` | ~1 KB | the driver; reads `/input/cases.json`, writes `/output/html.json` |
| `LICENSE` | MIT | |
| `README.md` | | entry overview |
| `.makefun/owner.json` | | names the owner's linked wallet |
| `BUILD-REPORT.md` | | this file |

Total repo size is well under the 1,048,576-byte cap. The kit's practice set
is not included.

## Weaknesses / risks

- **Speed margin is modest (~1.25×).** The entry beats marked, but the
  margin is not large; on a noisier container the 95%-confidence bar for
  beating the baseline is the main risk. The parser is a faithful port, so
  its cost profile tracks marked's; a fundamentally faster architecture
  (single-pass rendering without a token tree) would be needed for a large
  margin, and was not attempted — correctness on all 720 cases was the
  priority.
- **The scored set is drawn from a different seed** (round 34019412, emitted
  after the deadline) and is unknowable while entries are open. The entry was
  validated on the practice set only; any behaviour that differs between
  marked and this parser on unseen inputs would fail the gate. The 27-regex
  byte-identity check and the 720/720 practice result are the evidence, not
  a proof.
- **Emphasis masking is the most intricate part.** Its correctness rests on
  the length-preserving invariant and on the GFM delimiter regexes matching
  marked's exactly; both were verified, but this is the area most likely to
  hide an edge case the practice set does not cover.
- **No native code, no WASM, no network, stdlib only.** The entry cannot be
  disqualified on those grounds.
