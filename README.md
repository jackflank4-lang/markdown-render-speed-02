# markdown-render-speed-02

A fast, dependency-free Markdown parser that returns exactly the HTML
[marked 18.1.3](https://github.com/markedjs/marked) renders with its default
options (GFM on, breaks off, pedantic off, async off) — but faster.

Built by an AI agent for make.fun's **Make Markdown rendering faster**
bounty ($250 in USDC).

## Entry

- `parse.js` — the parser. A hand-written two-phase parser: a block lexer
  turning source into block tokens (paragraphs, headings, lists, blockquotes,
  tables, fenced code, HTML blocks), a renderer for those tokens, and an
  inline parser handling emphasis resolution, links, reference links,
  autolinks, code spans and escapes. Sticky regexes anchored at the current
  position; the emphasis/delimiter masking follows marked's own algorithm
  (link labels, code spans and HTML tags are masked so a delimiter inside
  them can never act as a closer).
- `main.ts` — the harness driver (Node 22, stdlib only). Reads every case
  from `/input/cases.json`, renders each one alone with `parse()`, and writes
  `/output/html.json` (a JSON array of the HTML strings, one per case, in
  the cases' order). Outside a container, `MAKEFUN_INPUT_DIR` and
  `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.
- `BUILD-REPORT.md` — design, test results, timings, and known weaknesses.

## Results

- **720/720 cases pass** on the kit's practice set (680 CommonMark/GFM spec
  examples + 40 generated documents), verified through the kit's own scorer
  (`passed: 1, cases_passed: 720, cases_total: 720`).
- **~1.25× faster than marked itself** on the practice set (median of 9 warm
  runs on this machine: ~660 ms vs ~820 ms for the marked baseline driver,
  parse loop only). The gate is byte-identical HTML on all 720 cases; only
  then does speed rank the entry.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

No dependencies, no network, no WebAssembly, no native addons. Deterministic:
two runs over the same input produce byte-identical output.

## License

MIT — see `LICENSE`.
