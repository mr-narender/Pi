# Chat loading performance

This change preserves runtime warmup and existing live chat controllers. It
reduces repeated session reads and defers optional rendering engines; it does
not change Pi's SDK hydration or session-file format.

## Measurements

Baseline: `c458f80`, before these source changes. Measurements use Node
`v26.11.1`, macOS arm64, synthetic session data, and the same installed
dependencies. No private chat contents were read. Times are component
measurements, not end-to-end VS Code or remote-server startup times.

| Workload                                                         | Before                  | After                   |
| ---------------------------------------------------------------- | ----------------------- | ----------------------- |
| Initial chat JavaScript                                          | 12,802,195 bytes        | 179,373 bytes           |
| V8 compilation proxy, median of 15 unique-source samples         | 108.64 ms               | 1.70 ms                 |
| Metadata scan, 700 files, first pass                             | 1,249.76 ms / 700 opens | 1,205.36 ms / 700 opens |
| Same metadata scan, repeat 1                                     | 1,182.74 ms / 700 opens | 19.67 ms / 0 opens      |
| Same metadata scan, repeat 2                                     | 1,203.73 ms / 700 opens | 18.55 ms / 0 opens      |
| 96.83 MiB history, median of three reads                         | 101.36 ms               | 92.69 ms                |
| Main event-loop maximum delay during those history reads, median | 4.77 ms                 | 1.33 ms                 |

The history benchmark includes worker message delivery and uses a resident
worker; startup plus the first small read separately took 49.07 ms. Large
histories are deliberately not retained in the cache. Tiny repeated reads
changed only marginally (0.39 ms to 0.26 ms median). A concurrent extension-test
run made the worker history benchmark slower than the baseline (138.44 ms
versus 118.34 ms median); the table uses a later run without those concurrent
checks. Total read latency depends on workload and contention. The reliable
architectural benefit is that history JSON parsing no longer occupies the
extension-host thread.

Optional bundle sizes are 12,298,446 bytes for Mermaid, 325,974 for highlighting,
and 143,584 for QR generation. Deferral reduces initial work, not total package
size. The Node compilation proxy does not measure browser paint or SDK startup.

## Reproduce

Run a non-clean production build, then:

```sh
node scripts/build.mjs
node scripts/benchmark-webview.mjs
node --import tsx scripts/benchmark-sessions.mjs --files 700
node --import tsx scripts/benchmark-history.mjs
```

For session-list comparison, prepare a checkout of the baseline with the same
dependencies, then run the current harness against that source:

```sh
node --import tsx scripts/benchmark-sessions.mjs --source-root /path/to/baseline --files 700
```

The webview harness accepts a built checkout path as its first argument. Its
baseline should use the same build settings and path layout; dependency symlinks
can change generated source-comment lengths. The history harness contains the
pre-change parser and compares it with the actual bundled session worker on
identical generated data. Fixtures live beneath the system temporary directory
and are removed afterward. No timing thresholds run in CI.

## Streaming assessment

Session history already uses `createReadStream` and async line iteration. The
RPC transport already receives incremental JSONL events and waits for writable
`drain` when applying backpressure. Live replies already update the webview as
they arrive. This change keeps those paths and moves extension-side JSON parsing
to the existing resident worker.

Streaming physical session records directly into the visible transcript before
selecting the authoritative branch would expose abandoned forks. Compaction
records must also remain available when resolving the full display history.
The parser therefore streams bytes, retains branch fields, and selects the
correct branch before publishing. Webview history paging remains intact.

VS Code `Memento.update` stores serializable values; it has no streaming-write
API. Replacing persisted draft/tab state with partial streamed writes would
introduce recovery and ordering changes without evidence of a loading benefit.
That persistence protocol is unchanged.

References: [Node streams](https://nodejs.org/api/stream.html),
[worker message cloning](https://nodejs.org/api/worker_threads.html#portpostmessagevalue-transferlist),
and [VS Code Memento](https://code.visualstudio.com/api/references/vscode-api#Memento).

## Limits and preservation

- Metadata cache: at most 1,024 lightweight records, validated against file
  identity, size, mtime and ctime. Missing or changed files are re-evaluated.
- Metadata scans: 16 concurrent file reads and 800 lines per file. A single
  oversized JSONL record is still parsed completely to preserve prompt previews.
  Names after the window in sessions without prompts are now outside the index;
  ordinary sessions already used this window. Transcript history is not capped.
- History cache: at most eight entries and 8 MiB of source, with individual
  files capped at 2 MiB; active leaf identity is part of the key. Forks,
  compaction history, images, truncation and replacement remain authoritative.
- Mermaid/highlighting load from versioned local webview URIs with the existing
  nonce CSP. QR generation loads a packaged sibling module only for pairing.
  No CDN or relaxed security policy is introduced. Mermaid's existing temporary
  rendering emits inline-style CSP warnings in both baseline and updated
  Chromium checks; SVG rendering and fullscreen still work.
- SDK hydration and actual remote-server performance were not benchmarked.
