# Network-Fetched Assets

Inventory of everything `omp` and its sibling packages pull off the network at runtime, with the exact call sites, pinning state, and the hardening work that is still open. Written as a handoff: the audit is complete, **no code was changed**.

Scope: runtime fetches of binaries, weights, and package graphs by the shipped product. Out of scope: LLM provider endpoints (those are the product), CI workflows, and `bun install` of the workspace itself.

## TL;DR

- Tree-sitter grammars are **not** network assets. Every grammar is a Cargo dependency compiled into `@oh-my-pi/pi-natives`; the one exception is a vendored local patch (`crates/vendor/tree-sitter-go`). Nothing about grammars needs hardening.
- Runtime fetches live in five families: **tool binaries** (GitHub releases), **model weights** (Hugging Face), **on-demand npm side runtimes** (`bun install` into cache dirs), **Chromium** (Chrome for Testing), and **`omp update`** (GitHub releases / npm registry).
- Verification is inconsistent. Only three paths verify bytes today: `omp update` (sha256 from the release asset digest), SmolLM2 weights (commit revision + per-file sha256), and Skillshare installs (SRI sha512 before unpack). Everything else trusts the transport and a mutable head (`releases/latest`, `resolve/main`).
- Two dead constants are worth deleting on sight: `mnemopi/src/config.ts:21` (`FASTEMBED_CACHE_DIR` → `~/.hermes/...`) and the `DEFAULT_LLM_MODEL_REPO`/`DEFAULT_LLM_MODEL_FILE` pair with no in-repo consumer.

## How this was audited

Re-runnable with `rg` from the repo root:

```bash
# All non-test runtime fetch call sites in the agent package
rg -l --type ts 'fetch\(' packages/coding-agent/src | grep -v /test/

# Every external host referenced from shipped sources
rg -oh --type ts 'https?://[a-zA-Z0-9._-]+' packages/*/src crates/*/src python/*/src \
  | sed 's|https\?://||' | sort | uniq -c | sort -rn

# Download/install machinery
rg -n 'downloadFile|ensureRuntimeInstalled|withDownload|trackDownload' packages/*/src
```

The host histogram is dominated by LLM provider base URLs from `packages/catalog/src/compat/rules/*.kdl` and by `packages/coding-agent/src/web/scrapers/*` targets (the `fetch` tool's normal function). Both are excluded from the tables below.

## 1. Not fetched at runtime

| Artifact | How it ships | Evidence |
|---|---|---|
| ~50 `tree-sitter-*` grammars | Cargo deps linked into the native addon | `Cargo.toml:431-489`, `crates/pi-ast/Cargo.toml:20-41` |
| Patched `tree-sitter-go` (Go 1.26 `new(expr)`) | Local path dependency | `Cargo.toml:42-44`, `crates/vendor/tree-sitter-go/` |
| `.lark` edit grammars (`apply_patch`, `hashline`, `sloppy`) | `include_str!` | `crates/pi-edit/src/lib.rs:62-64` |
| `kitty-vt.wasm` | npm dependency (`kitty-vt-wasm`) | `packages/tui/test/virtual-terminal.ts:25` |
| Theme JSON, `models.json`, `rules.json`, `assets/*.webp` | Committed | `packages/tui/src/theme/defaults/`, `packages/catalog/src/models.json` |
| Playwright aria snapshot bundle | Generated at build time from `raw.githubusercontent.com/microsoft/playwright@v1.61.0`, output committed | `packages/coding-agent/scripts/generate-aria-snapshot.ts:24-27` |

Runtime *installation* of the npm/Rust graph (including the optional `@oh-my-pi/pi-natives-<tag>` platform package and `onnxruntime-node`'s postinstall) is a separate, install-time concern — see §4 for the same packages re-installed at runtime.

## 2. Tool binaries

`packages/coding-agent/src/utils/tools-manager.ts` — downloaded on first use via `ensureTool()` (`:378`), resolved by `getToolPath()` (`:155`).

| Tool | Source | Version resolution | Verification |
|---|---|---|---|
| `sd` (chmln/sd) | `github.com/chmln/sd/releases/download/<latest>/…tar.gz` | `api.github.com/repos/<repo>/releases/latest` (`:176`) | none |
| `sg` / ast-grep | `github.com/ast-grep/ast-grep/releases/download/<latest>/…zip` | same | none |
| `yt-dlp` | `github.com/yt-dlp/yt-dlp/releases/download/<latest>/<direct binary>` | same | none |
| `trafilatura` | PyPI via `uv tool install` → `pip install` fallback (`:329`) | latest | inherited from uv/pip |

- Config table: `TOOLS` (`:79`), `PYTHON_TOOLS` (`:144`); asset-name builders are per platform/arch.
- `downloadFile()` (`:208`) streams to a `.part`-less temp path with a 120 s deadline, and deletes partial output on failure — but has **no digest parameter**, so adding verification means extending `DownloadFileOptions` and hashing inside the `writeResponseBody` loop.
- URL construction: `:266`. Callers: `web/scrapers/youtube.ts:151` (yt-dlp), `tools/fetch.ts:620` (trafilatura), `sd`/`sg` through the tool paths.
- Termux hosts get package-manager names instead of downloads (`TERMUX_PACKAGES`, `:365`).

## 3. Model weights

| Artifact | Repo / source | Pin state | Cache | Code |
|---|---|---|---|---|
| SmolLM2-135M (word completion) | `HuggingFaceTB/SmolLM2-135M`, `QuantFactory/SmolLM2-135M-GGUF` | **commit revision + per-file size + sha256** | `<tiny-models>/predict/<org>--<name>/` | `predict/smollm-weights.ts:35-38`, `SMOLLM_FILES` at `:53` |
| Tiny models: title, memory, judge (LFM2.5-230M/350M, Falcon-H1-90M, Qwen3-1.7B, Llama-3.2-3B, Gemma-3-1B, Qwen2.5-1.5B) | ONNX repos via transformers.js; MLX 4-bit repos via `mlx-lm` | repo + dtype pinned; **`resolve/main`**, no digest | `~/.omp/agent/cache/tiny-models` | `tiny/models.ts:20`, `:71`; `tiny/mlx-server.py:138` |
| STT Whisper base / small / large-v3-turbo | `onnx-community/whisper-*` via transformers.js | `resolve/main`, no digest | `~/.omp/agent/cache/tiny-models` | `stt/models.ts:57-87` |
| STT Parakeet TDT 0.6B v3 (**default**) | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`, four files | **`resolve/main`, no digest** | `<tiny-models>/../stt-runtime/…` + model dir | `stt/models.ts:88-100`, `stt/asr-worker.ts:268` |
| TTS Kokoro-82M | `onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js` | `resolve/main`, no digest | transformers cache dir | `tts/models.ts:66-76` |
| Mnemopi embeddings (default `BAAI/bge-small-en-v1.5`) | fastembed's own model registry | fastembed-managed | `~/.omp/cache/fastembed` | `mnemopi/src/config.ts:24`, `mnemopi/src/core/embeddings.ts:379-387`, `coding-agent/src/mnemopi/embed-client.ts:160-166` |
| MLX (Apple Silicon) tiny models | same HF repos, `mlxRepo` field, streamed by a spawned `mlx-server.py` | repo pinned, revision not | `<tiny-models>/mlx/` | `tiny/mlx-runtime.ts`, `tiny/mlx-server.py:138` |

Notes:

- transformers.js is configured with `env.cacheDir = getTinyModelsCacheDir()` and `env.allowLocalModels = false` (`subprocess/worker-runtime.ts:413-417`); `HF_HUB_*`, `HF_ENDPOINT`, `HTTPS_PROXY` are honored by the library and inherited by the workers.
- SmolLM is the only model path that writes a ready-marker listing pinned digests and re-downloads files that fail the check.
- Tool-facing commands: `omp tiny-models list|download`, `omp setup speech`; progress flows through the download HUD (`downloads/activity.ts`). See `docs/local-models.md` for the user-facing picture.
- `FASTEMBED_CACHE_DIR` (`mnemopi/src/config.ts:21`) points at a legacy `~/.hermes/cache/fastembed` path and has **no consumers**; the live path is `getFastembedCacheDir()` (`packages/utils/src/dirs.ts:812`).

## 4. On-demand npm side runtimes

`ensureRuntimeInstalled()` writes a pinned `package.json` and runs `bun install --production` into a cache dir (`packages/utils/src/runtime-install.ts:402`, `:419`, `:450`). There is **no lockfile and no integrity pinning** — only exact version strings.

| Package | Version spec | Cache dir | Trigger |
|---|---|---|---|
| `@huggingface/transformers` | `catalog:` → installed version | `tiny-title-runtime/transformers-<version>` | compiled binary, first tiny-model use (`subprocess/worker-runtime.ts:461-465`) |
| `kokoro-js` | `1.2.1` (+ `onnxruntime-node` 1.26.0) | `tts-runtime/kokoro-1.2.1` | first local TTS (`tts/runtime.ts:4-7`, `tts/tts-worker.ts:137-139`) |
| `sherpa-onnx-node` | `1.13.2` | `stt-runtime/sherpa-1.13.2` | first Parakeet transcription (`stt/asr-worker.ts:125`, `:153`; version from `packages/coding-agent/package.json:568`) |
| `fastembed` | `2.1.0` (+ `onnxruntime-node` peer `1.21.0`) | `fastembed-runtime/…` | compiled binary, first memory embed (`mnemopi/package.json:47-49`, `mnemopi/src/core/fastembed-runtime.ts:37-47`, `:148-163`) |

- `trustedDependencies: ["onnxruntime-node"]` runs that package's postinstall, which fetches ORT binaries from **nuget.org**; the compiled path repairs a skipped CUDA install explicitly (`worker-runtime.ts:231-254`, hint text at `:357`).
- PyPI egress on the MLX path: `uv pip install mlx-lm==<pinned>` / `pip install` (`tiny/mlx-runtime.ts:46`, `:60`). Installs into a venv, not the runtime cache.
- `installRuntimeModuleResolver()` (`runtime-install.ts:251`) patches `node:module` resolution so compiled binaries can load these graphs. Keep it confined to the dedicated workers — the doc comment explains the Bun 1.3.14 `createRequire` limitation that breaks the main agent process.

## 5. Browser

- Chrome for Testing from `https://storage.googleapis.com/chrome-for-testing-public` (`packages/utils/src/browsers.ts:8`), driven by puppeteer's `PUPPETEER_REVISIONS.chrome` build id.
- Trigger: first browser use, only when neither `PUPPETEER_EXECUTABLE_PATH` nor a usable system Chrome/Chromium is found; macOS prefers managed Chrome for Testing deliberately (`tools/browser/launch.ts:253-278`, rationale at `:207-231`).
- Cache: `~/.omp/puppeteer` (`getPuppeteerDir`, `dirs.ts:729`). omp pins no digest here; the build id is pinned by the `puppeteer-core` version.
- The relay extension assets under `src/tools/browser/relay/extension-assets/` are bundled, not downloaded.

## 6. Self-update

`packages/coding-agent/src/cli/update-cli.ts`:

- Binary installs: `github.com/can1357/oh-my-pi/releases/download/v<version>/omp-<plat>-<arch>` (`:274`), with the download URL matched exactly, `state === "uploaded"`, positive size, and a **sha256 digest from the release asset metadata** (`:268-273`).
- Package-manager installs: npm registry resolved from the user's `.npmrc` / `bunfig.toml`, defaulting to `https://registry.npmjs.org/` (`cli/npm-registry.ts:23`, metadata fetch at `update-cli.ts:836`), then `bun install -g` / `npm install -g` (`:1691`, `:1717`).

## 7. Registry- and service-hosted content

| Surface | Endpoint | Write/read | Verification |
|---|---|---|---|
| Skillshare: `omp skill install/search/publish` | `https://skills.omp.sh` (`packages/wire/src/skillshare.ts:18`; default at `skillshare/client.ts:110`) | tarball `.tgz` both ways | **install verifies registry SRI sha512 before unpack** (`skillshare/installer.ts:92-133`); publish sends its own SRI (`client.ts:163`) |
| Collab relay | `wss://my.omp.sh` (`packages/wire/src/index.ts:425`) | encrypted room frames | E2E room key |
| Share upload | `https://my.omp.sh/s` (`wire/src/index.ts:427`, `export/share.ts:515`) | uploads transcript bundle | n/a |
| Live stream + clip upload | `https://live.omp.sh` (`wire/src/stream.ts:17`, `stream/clip-upload.ts:5`) | publishes terminal deltas, uploads clips | n/a |
| Codex Security cloud | `https://chatgpt.com/backend-api/aardvark` (`security/cloud.ts:30`) | scan submit/read | provider auth |
| MCP: Smithery registry + OAuth | `https://registry.smithery.ai` (`mcp/smithery-registry.ts:5`, `mcp/smithery-connect.ts`, `mcp/oauth-flow.ts`) | server discovery, OAuth | third-party |
| MCP: Exa | `https://mcp.exa.ai/mcp`, `https://websetsmcp.exa.ai/mcp` (`exa/mcp-client.ts:92,105,126`) | tool calls | API key |
| MCP: user-configured servers | arbitrary URLs (`mcp/transports/http.ts`, `sse.ts`) | JSON-RPC | user's own |
| Plugin marketplace installs | git clone / npm (`extensibility/plugins/marketplace/fetcher.ts:58`, `:265`; `source-resolver.ts:6-8`) | plugin trees | git/npm only |
| GitHub: PR checkout, worktree sync, avatars | `api.github.com`, `github.com`, `avatars.githubusercontent.com`, `gravatar.com` (`tools/gh-pr-checkout.ts:446`, `task/worktree.ts:914`, `cli/git-tui/avatar.ts:28,116`) | git refs, images | GitHub token |
| Model discovery | provider `/v1/models` (incl. default Ollama at `config/model-discovery.ts:125`) | model roster refresh | provider auth |
| Web scrapers (the `fetch` tool) | arbitrary user-targeted URLs (`web/scrapers/*`) | documents | n/a |
| Metaharness dev UI | `https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4` (`metaharness/src/web/index.html:7`), npm tarballs (`metaharness/src/tb/agent.ts:34`), terminal-bench dataset (`tb/cli.ts:96`) | dev-only | n/a |

## 8. Where bytes land

| Path | Helper | Contents |
|---|---|---|
| `~/.omp/tools` | `getToolsDir()` (`dirs.ts:915`) | `sd`, `sg`, `yt-dlp` |
| `~/.omp/agent/cache/tiny-models` | `getTinyModelsCacheDir()` (`dirs.ts:886`) | tiny/title/memory/judge ONNX, Whisper, Kokoro, SmolLM, MLX |
| `~/.omp/cache/fastembed` | `getFastembedCacheDir()` (`dirs.ts:812`) | fastembed embedding models |
| `~/.omp/cache/fastembed-runtime/<key>` | `getFastembedRuntimeDir()` (`dirs.ts:817`) | fastembed npm graph |
| `~/.omp/agent/cache/…/{tiny-title,tts,stt}-runtime/<pkg>-<version>` | `runtime-install.ts` call sites | transformers / kokoro / sherpa npm graphs |
| `~/.omp/puppeteer` | `getPuppeteerDir()` (`dirs.ts:729`) | Chrome for Testing |

`dirs.rootSubdir(name, xdg)` / `agentSubdir(...)` honor `$XDG_CACHE_HOME` (falling back to `~/.omp/…`), so support tickets may show XDG paths instead.

## 9. Findings, ranked

1. **Unverified tool binaries.** `sd`, `sg`, `yt-dlp` are fetched from whatever `releases/latest` returns, with no digest and no signature (`tools-manager.ts:176`, `:266`). This is the highest-value gap: the binaries are executed.
2. **`resolve/main` for HF model files.** Sherpa Parakeet files are fetched from a mutable branch (`stt/asr-worker.ts:268`); transformers.js/kokoro downloads default the same way. A force-push upstream silently changes bytes for every future install, and nothing validates them.
3. **Runtime npm installs are version-pinned but not integrity-pinned.** No lockfile is written into the runtime dir (`writeRuntimeManifest`, `runtime-install.ts:402`), so transitive resolution happens fresh per machine, and `onnxruntime-node`'s postinstall adds nuget.org to the egress surface.
4. **Chromium has no digest.** The build id is pinned by puppeteer-core, but the archive is not checksummed by omp before launch (`tools/browser/launch.ts:253`). Lower risk: puppeteer's own installer, and the binary is not run as root.
5. **Dead code misleads auditors.** `FASTEMBED_CACHE_DIR` (`mnemopi/src/config.ts:21`) names a `~/.hermes` path that is never used; `DEFAULT_LLM_MODEL_REPO`/`DEFAULT_LLM_MODEL_FILE` plus `llmRepo`/`llmFile`/`llmModelFiles` (`:26-27`, `:330-340`) have no consumer in-repo (mnemopi's live LLM path is an OpenAI-compatible HTTP client, `core/local-llm.ts:350-365`).
6. **Positive controls exist and should be copied.** `omp update` (release digest), SmolLM (`SMOLLM_FILES`), and Skillshare (`installer.ts:92-133`) all show the house pattern for verified downloads.

## 10. Open work

- **W1 — verify tool binaries.** Extend `DownloadFileOptions` with an expected sha256 and hash inside the `writeResponseBody` loop (the failure path already `rm`s the destination). Resolution options: (a) pin `{version, sha256}` per platform in the `TOOLS` table, matching `SMOLLM_FILES`; or (b) keep `releases/latest` but read `asset.digest` from the release API — the exact field `update-cli.ts:268-273` already validates.
- **W2 — pin HF revisions.** Replace `resolve/main` in `stt/asr-worker.ts:268` with a commit revision per model in `STT_MODELS`, and record size + sha256 per file the way `SMOLLM_FILES` does. Pass `revision` through the transformers.js/kokoro/fastembed init options where the library supports it.
- **W3 — pin the runtime installs.** Commit a lock/manifest per plan (or add per-package integrity enforcement) and run the install with the lock. Decide explicitly whether nuget.org egress on the `onnxruntime-node` postinstall is acceptable; if not, pre-populate the side runtime in the release artifacts.
- **W4 — Chromium digest.** Either pin the chrome-for-testing archive digest, or document the deliberate omission in `docs/` next to the browser tool.
- **W5 — docs.** Cross-link this file from `docs/local-models.md` (it already owns the user-facing download story) and `docs/lsp-config.md` is *not* affected: LSP/DAP servers are resolved locally only — there is no auto-install (see `dap/session.ts:184`, which tells the user to `pip install debugpy` themselves).
- **W6 — cleanup.** Delete the dead constants from finding 5.

## 11. Verification

Existing tests that already exercise the download machinery (run before/after any W1-W3 change):

```bash
bun test packages/coding-agent/test/tools-manager-download.test.ts   # downloadFile streaming, abort, timeout
bun test packages/coding-agent/test/update-cli.test.ts               # release asset digest + URL matching
bun test packages/coding-agent/test/tiny-runtime-install.test.ts     # runtime install, CUDA repair
bun test packages/utils/test/runtime-install.test.ts                 # resolver + ensureRuntimeInstalled
bun test packages/mnemopi/test/corrupt-model-retry.test.ts           # fastembed cache heal
bun test packages/mnemopi/test/truncated-model-cache-recovery.test.ts
```

Manual smoke for a fresh-machine path: remove `~/.omp/tools`, `~/.omp/agent/cache/tiny-models`, and `~/.omp/cache/*-runtime/*`, then trigger the matching feature (`omp tiny-models download lfm2.5-230m`, `omp setup speech`, a `tts` tool call, a memory recall) and confirm the download HUD reports progress and the cache populates.

## Appendix: key files

| Concern | File |
|---|---|
| Tool binaries | `packages/coding-agent/src/utils/tools-manager.ts` |
| Runtime npm installs | `packages/utils/src/runtime-install.ts` |
| Download HUD registry | `packages/coding-agent/src/downloads/activity.ts`, `model-downloads.ts` |
| Tiny/MLX models | `packages/coding-agent/src/tiny/{models,runtime,mlx-runtime,title-client}.ts`, `packages/coding-agent/src/tiny/mlx-server.py`, `packages/coding-agent/src/subprocess/worker-runtime.ts` |
| STT | `packages/coding-agent/src/stt/{models,asr-worker,downloader}.ts` |
| TTS | `packages/coding-agent/src/tts/{models,runtime,tts-worker,downloader}.ts` |
| Word-completion weights | `packages/coding-agent/src/predict/smollm-weights.ts` |
| Embeddings | `packages/mnemopi/src/core/{fastembed-runtime,embeddings}.ts` |
| Browser | `packages/utils/src/browsers.ts`, `packages/coding-agent/src/tools/browser/launch.ts` |
| Self-update | `packages/coding-agent/src/cli/{update-cli,npm-registry}.ts` |
| Skills registry | `packages/wire/src/skillshare.ts`, `packages/coding-agent/src/skillshare/{client,installer}.ts` |
| Cache locations | `packages/utils/src/dirs.ts` |
| User-facing model docs | `docs/local-models.md` |
