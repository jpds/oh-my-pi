# Branch Structure (jpds/oh-my-pi fork)

Date: 2026-10-16. Living doc — update it whenever the topology changes.

## Remotes

| Remote | URL | Role |
|---|---|---|
| `origin` | `github.com/can1357/oh-my-pi` | Upstream. `main` is the integration trunk. Not pushed to. |
| `jpds` | `github.com/jpds/oh-my-pi.git` | This fork. Feature branches and `main` are pushed here; **`deploy` is not pushed** (the stale `jpds/deploy` at `c257351161` is a leftover copy — do not push local deploy over it). |
| `szavadsky` | `github.com/szavadsky/oh-my-pi.git` | Unrelated third-party fork, occasionally fetched for cross-reading. Not merged. |

## Topology

`deploy` is the fork's integration branch. It tracks upstream `main` and
stitches topic branches on top of it with merge commits. Upstream never sees
`deploy`; topics merge locally into `deploy`, never into `main` (they ride to
upstream later, if ever, via proper upstream PRs).

```mermaid
gitGraph
   commit id: "main (= origin/main)"
   branch deploy
   commit id: "main-anchored topics (squash copies)"
   merge feat/mnemopi-embedding-cache-dir
   merge feat/judge-harness-plus-providers
   commit id: "declarative settings layer"
   cherry-pick id: "feat/tiny-model-nix-preseed"
   commit id: "deploy tip (local)"
```

Merge commits on `deploy` carry the standardized subject
`Merge <topic>: <why>`, e.g. `Merge feat/judge-harness-plus-providers:
restored lost prelude transport block`. Single-commit topics may land on
`deploy` by **cherry-pick** instead of merge (example:
`feat/tiny-model-nix-preseed` → `360b70f9a5`); the topic branch is then
disposable — record the deploy-side hash in the inventory so the copy is
findable, and prefer tree-diff over `git cherry` to confirm containment.

## Branches inventory (checked 2026-10-16)

| Branch | Tip | Base (merge-base with main) | Contained on deploy? | Notes |
|---|---|---|---|---|
| `main` | 96894a6147 | — | ancestor of deploy | Upstream trunk (= `origin/main`), 18.11.3. Local `main` leads `jpds/main` (`6a796cf926`, 2026-09-27) by ~6000 commits; push `main` to the fork when convenient. |
| `deploy` | d6a0575548 | — | self | Local integration branch, **not pushed**. Rebuilt 2026-10-16 from `origin/main` (`a536558dc2`): merged judge topic (`b286dd71ec`), mnemopi (`fd7b9820e7`), cherry-picks `a5e83973c4` (tiny-model) + `3acb84e5e9`/`407e606c4d` (declarative settings re-applied), munito (`bf358923d5`), config-defaults (`358dfec331`). Synced to `origin/main` `96894a6147` (18.11.3) via merge `d6a0575548`: both-sides union in `judgment/{wire,native,systemone}.ts` (Jev image-asset transport + judgment endpoint-override decoration, `decode(payload, questions?)` widened), `gen:compat`+`gen:models` regenerated (munito/Jev rows folded back; gen idempotent). Pre-sync snapshot: `backup/deploy-pre-main-sync2-2026-10-16` (`9cc5c357fb`). 266 tests across judgment/catalog/tui/coding-agent-config scopes pass. Old deploy: `backup/deploy-pre-rebuild-2026-10-16` (`360b70f9a5`). |
| `feat/judge-harness-plus-providers` | 527247a668 | a536558dc2 (= main tip, 2026-10-16) | merged | Judgment/judge-harness topic, rebased onto current main 2026-10-16 with both-sides conflict resolution. Re-restored the twice-dropped `_judge_direct_descriptor` + `_JUDGE_*` constants block (`527247a668`); stringify `judge_batch` image dict keys; dual-spelling judge docs. Merged into rebuilt deploy. Old copies: `backup/judge-harness-pre-rebase3` (content verified superseded-only). |
| `feat/mnemopi-embedding-cache-dir` | 35872a27b6 | 2026-10-14 | merged | Pinned model stores / `mnemopi.embeddingCacheDir`. Commit landed in deploy via the 0640787baf merge; topic is done and clean. |
| `feat/tiny-model-nix-preseed` | 67e8a9b019 | a536558dc2 (= main tip, 2026-10-16) | **merged** | `PI_TINY_MODELS_CACHE` override in `getTinyModelsCacheDir()` with tests/docs. Rebased onto current main (`67e8a9b019`), then merged into deploy as `9cc5c357fb` (content was already tree-identical via cherry-pick `a5e83973c4`; merge is a no-op delta). |
| `feat/lsp-taplo-toml` | acc4e13f21 | 2026-09-28 | **stale, not merged** | Taplo LS addition. Forks from a branch point 2026-09-28 — 3.6k files of drift to upstream. Rebase onto current `main` before resuming. Not part of the 2026-10-16 deploy rebuild. |
| `feat/munito-provider` | a9640e6af4 | 2026-10-14 | **merged** | Branch tip merged into deploy as `bf358923d5` after the rebuild. Both-sides resolution: deploy's regional-endpoint router (`MUNITO_BASE_URL`, per-endpoint cache id) + branch's wire pins (`supports-store #false`, `thinking-format "openai"`, `reasoning-content-field "reasoning"`), effort ladder (`priority=11` glob + no-effort lanes + gemma `thinking-upgrade-neutral`), and seed roster. Canonical-thinking propagation deliberately dropped per branch's host-policy ownership model; deploy test expectation updated to match. Tests: 16 munito-provider + 6 base-url pass; `gen:compat` no-op parity. |
| `feat/munito-provider-full` | e0d5c820b3 | 2026-10-13 | superseded | Antecedent of `feat/munito-provider`; its content is carried by the merged tip. Do not re-merge. |
| `feat/munito-provider-pre-rebase` | 2fbf5f7981 | 2026-10-15 | superseded | Older Munito offline working copy; superseded by the merged `feat/munito-provider` tip (`a9640e6af4`, merge `bf358923d5`). |
| `feat/munito-provider-wip` | 3e50af6aa2 | 2026-10-15 | superseded | WIP Munito stack; content superseded by deploy's merged copy. |
| `feat/config-defaults-layer` | dd4a29fa92 | 0105f57b3c (2026-10-13 main) | **merged** | Branch tip merged into deploy as `358dfec331` (content was already tree-identical via cherry-picks `3acb84e5e9` + `407e606c4d`; merge carried only CHANGELOG deltas). |
| `fix/dashboard-lists-configured-extensions` | 5cab88a188 | d6a0575548 (deploy tip, 2026-10-16) | **merged** (`2696b791d6`, 2026-10-17) | `/extensions` dashboard fix: the native extension-module provider read `extensions` only from legacy `settings.json`, so YAML/declarative-lane entries loaded but never listed. Provider now resolves the effective value (bound Settings via `cfgExtensions.isConfigured` → session extension roots → persisted config chain; `readConfiguredExtensions` exported); ACP `_omp/extensions` binds its Settings. Commit `5cab88a188` carries the fix + regression tests (:5) + CHANGELOG + docs/extension-loading.md. Pre-existing-failure baselines preserved: 4 builtin-defaults rule tests, 14 modes tests. |
| `fix/dashboard-configured-ext-on-declarative` | fc977af705 | dd4a29fa92 (feat/config-defaults-layer tip) | not merged | Cherry-pick copy of the same fix rebased onto the declarative-settings branch; cherry-pick was clean. Keep in sync with the deploy-based branch until one side lands; both tips must then carry identical content. |
| `fix/tiny-model-runtime-under-cache` | aee7b882c6 | 5cab88a188 (deploy-based stack on top of the dashboard fix) | **merged** (`81d3b13d61`, 2026-10-17) | Side runtimes (`tiny-title/stt/tts/tiny-mlx-runtime`) moved from `dirname(getTinyModelsCacheDir())` to `<cache>/runtimes/` via new `getTinyModelsRuntimesDir()`, so `PI_TINY_MODELS_CACHE` relocates runtimes with the weights (nix-store tmpfs wipe per boot fixed). Single commit, 9 files. Merged into deploy on top of the dashboard fix. Supersedes the runtime-dir half of HANDOFF-tiny-model-side-runtime.md option D; option A/B env choices remain a nix-templates-side change. |
| `feat/eval-kernel-direct-judge` | 59fee32819 | 2026-10-08 | superseded (375+/478- vs deploy) | Early judge arc, pre-dating the 2026-10-12 rewrite. Superseded by `feat/judge-harness-plus-providers`. Do not merge. |
| `feat/opencode-zen-jev-judges` | 40d397fe48 | 2026-10-08 | content-merged | One commit (`feat(models): route OpenCode Zen's Jev models to the System One API`); stacked ancestor of `feat/eval-kernel-direct-judge`, content present in the deploy judge span. |
| `fix/judge-harness-ergonomics` | 229de985ce | 2026-10-10 | content-merged | 14-commit earlier variant of the judge span; final content landed via feat/judge-harness-plus-providers. Superseded, do not merge. |
| `feat/lsp-taplo-toml` | acc4e13f21 | 2026-09-28 | **stale** | Taplo LS addition. Forks from a branch point 2026-09-28 — 3.6k files of drift to upstream. Rebase onto current `main` before resuming. |

Backups (pre-rebase/pre-squash snapshots, kept for history only):

| Backup | Tip | Why it exists |
|---|---|---|
| `backup/deploy-pre-rebuild-2026-10-16` | 360b70f9a5 | Old deploy before the 2026-10-16 rebuild from origin/main. (The later `backup/deploy-pre-main-sync-2026-10-16` duplicate was deleted 2026-10-16; today's pre-sync snapshot is `backup/deploy-pre-main-sync2-2026-10-16`.) |
| `backup/judge-harness-pre-rebase3` + `-old` | b021c6ad07 | Judge topic before the 2026-10-16 rebase loop. Post-rebase tip is `527247a668`. |
| `backup/deploy-pre-main-sync2-2026-10-16` | 9cc5c357fb | Deploy tip (all five topics stitched) right before merging origin/main `96894a6147` (18.11.3). |
| `backup/feat-tiny-model-nix-preseed-pre-rebase` | 91c7364881 | Tiny-model topic before its 2026-10-16 rebase onto main. |
| `backup/judge-harness-plus-providers-pre-rebase2` | 1990ceeed9 | Pre-rebase copy before the 2026-10-13 rebases of the judge topic. |
| `backup/judge-harness-plus-providers-pre-sync` | 1ba0c952b7 | Before the 2026-10-08 sync. |
| `feat/judge-harness-plus-providers-backup` | 7278df26b2 | Pre-2026-10-14 state of the judge topic (retained despite the backup/* rename pattern). |
| `backup/judge-harness-presquash` | c3d8d36952 | State before the judge topic was squashed. |
| `backup-munito-pre-rebase` | 600ddbd24f | Munito topic before its 2026-10-13 rebase. |
| `backup/feat-munito-provider-pre-merge-resolve` | 5bb284f7cb | Munito topic before its merge-resolution pass. (Added 2026-10-16; tip verified.) |
| `backup/munito-conflict-snapshot` | 5bb284f7cb | Duplicate of the above (same commit); one of the two can go. |

## Rebase recipe

**Principle: rebase the topic onto the newest base, keep the topic sliced thin,
verify tree-equality with the migrated equivalent, then replace the merge —
don't stack edit fixes on the topic.**

0. Take a backup ref, always: `git branch backup/<topic>-pre-rebase <topic>`.
1. Identify the true base of the topic: `git merge-base <topic> main`.
2. Rebase: `git rebase main <topic>`. Recovery: `git reflog` + the
   `backup/*` snapshot from step 0.
3. **Pre-commit check: re-run `bun test` scopes for the files touched.** Never
   leave a topic without a passing test scope — a sweep that drops a
   referenced block (`_bridge_call` in prelude.py) looks completely normal at
   commit time because the file compiles; only the runtime scope fails. The
   2026-10-15 deploy sweep lost a 509-line block this way while the commit
   surface itself passed compile and `bun check`.
4. Merge the rebased topic into `deploy` (merge commit, not cherry-pick).
   `git cherry` detects squash-equivalent commits (marked with `-`), but it is
   unreliable on squash-merged topics:

```sh
# detect old copies: `git cherry` masks squash-equivalent patches with a '-'
git cherry main <competing-branch>
# compare topic tree vs a deploy span:
git diff <topic> deploy --stat
```

5. If a rebase span drops content, restore it from either the pre-rebase
   `backup/*` ref or the equivalent pre-rebase commit on the fork branch, and
   always rebuild the tree spanning `git diff` against the honest parent
   rather than trusting the intermediate commit visually.

## Known traps

- **Hidden duplicates in the judge span** (`feat/judge-harness-plus-providers`):
  this topic was rebased in-branch, carrying both the pre-rebase copies
  (`d34e6ecc6a`-side) and post-rebase copies (`f925758d2c`-side) of ~9
  judge commits. Cherry-picks must derive from the post-rebase side;
  the old copies are merged into deploy too, but do not feed a fresh
  topic from them. When in doubt, re-merge from the branch tip (the
  2026-10-15 fold: `84ecc129fc` → merge `654e6a1a01`).
- **`git cherry` and squash merges**: patch-id equality is the mechanism —
  squashed-and-slightly-amended topics give false negatives (e.g. munito,
  ergonomics branches). Prefer `git diff --stat` tree comparisons for
  truth; use `git cherry` only to detect obvious duplicates.
- **Rebase-sweep content loss** (the 2026-10-15 prelude incident): a
  sweep dropped a whole definition block while all 16 call sites
  survived, so the file compiled and looked normal; only runtime calls
  failed. After any rebase sweep touching Python source:
  `python3 -m py_compile` every touched file, then `bun test` its
  consumer surface. Compile alone is insufficient proof.
- **Not pushed**: deploy and its merges exist only locally, and merges of
  local topics into deploy are the only way deploy is extended. Avoid
  interactive history surgery above a pushed commit unless you can push
  with force-with-lease to `jpds/<topic>`.
- **Unrelated remotes never merge**: `szavadsky` is for cross-referencing
  other people's parallel fixes; merging from it — or any fork — into
  deploy is forbidden without re-authoring the commits (authorship must be
  jpds).

## Housekeeping candidates (as of 2026-10-16)

Deleted: `work/generic-judge-stack` (`8a0fa5b0a9`, 2026-10-16) — stale 2026-10-15
Vercel-judge working branch; code content byte-identical to the judge topic tip
(`feat/judge-harness-plus-providers`), which deploy contains.

Low-risk deletions once their content is confirmed contained on deploy:

- `feat/munito-provider`, `feat/munito-provider-full`,
  `feat/munito-provider-pre-rebase`, `feat/munito-provider-wip`,
  `fix/judge-harness-ergonomics`, `feat/eval-kernel-direct-judge`
  — all content-merged or superseded.
- **Keep** `feat/config-defaults-layer` and `feat/tiny-model-nix-preseed`
  for now: they are the canonical live topics (declarative settings,
  tiny-model cache), landed on deploy via cherry-pick
  (`3acb84e5e9`/`407e606c4d` and `a5e83973c4`). Under BRANCHES.md policy the
  topic branch is disposable once containment is visibly recorded — both
  are recorded above; deletion optional, not urgent, and the tiny-model
  deploy-copy hash in the earlier inventory (`360b70f9a5`) is now
  `a5e83973c4` after the rebuild.
- `feat/judge-harness-plus-providers-backup` — pre-rebase state already kept
  under `backup/judge-harness-plus-providers-pre-rebase2`.
- `backup/munito-conflict-snapshot` — duplicate of
  `backup/feat-munito-provider-pre-merge-resolve` (same commit `5bb284f7cb`).
- `feat/tiny-model-nix-preseed` — single-commit topic, cherry-picked onto
  deploy as `360b70f9a5` (2026-10-16); delete once that containment stays
  visible in the inventory/history.

Keep:

- `feat/judge-harness-plus-providers` — active integration with the
  prelude-restore fix (84ecc129fc).
- All `backup/*` under the naming discipline of the pre-rebase snapshot
  pattern: created with `git branch backup/<topic>-pre-rebase <tip>` right
  before any non-trivial rebase of that topic.
