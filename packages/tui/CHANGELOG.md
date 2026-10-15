# Changelog

## [Unreleased]

### Added

- Added Vim `W`, `B`, and `E` motions for navigating whitespace-delimited WORDs ([#13099](https://github.com/can1357/oh-my-pi/pull/13099) by [@Scott-Simmons](https://github.com/Scott-Simmons)).
- Added Vim `s`/`S` (substitute characters / lines, Visual `S` changes whole lines) and the linewise line motions `-`, `+`, and `_` ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim redo (`Ctrl+R`) and counted undo (`3u`); undo and redo return the cursor to where the change began, as in Vim ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim registers: named `"a`–`"z` (uppercase appends), `"0` for yanks, `"1`–`"9` and `"-` for deletes, and the `"_` black hole ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `X`, `Y`, `~`, the case operators `g~`/`gu`/`gU` (with `g~~`/`guu`/`gUU`), `gJ`, `ge`/`gE`, `gp`/`gP`, `gv`, and `gi` ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim counted inserts (`3ix`, `2ofoo`), Visual `p`/`P`/`r`/`u`/`U`/`~`, and Visual `X`/`D`/`Y`/`C`/`R` on whole lines ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `gj`/`gk` to move by screen row through wrapped lines ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `Editor.onHistorySearch`, which Vim's Normal-mode `/` and `?` call so the host can open its prompt-history search ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `:` in Normal mode on an empty prompt: it types `/` in Insert mode, so the slash-command menu opens ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added Vim `"+p`/`"*p` to put the system clipboard; `Editor.onYank` now also gets the register name ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `vimMode` and `configureEditor` options to `HtmlFormDialog` and `HookEditorComponent`: with `vimMode` their text boxes are Vim-mode editors (a form's one-line fields and "Other" answers too; passwords stay plain), `j`/`k` step between a form's option rows, and `Escape` leaves Insert mode before it closes or cancels anything ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `Editor.vimStartMode` and `Editor.resetVimMode()`: each prompt (on enabling Vim mode, after a submit, on reset) starts in the start mode; Normal-mode `k`/`j`/`-`/`+` past the first or last line step through prompt history ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- Added `Editor.captureHistoryState()`, which hosts override so a remembered draft (and Vim's `k`/`j` history steps) brings back the attachments they keep beside the text; `CustomEditor` implements it ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- `SettingsList` rows can be marked `declared` for values that come from the machine's declarative config layer; they render in `DECLARED_SETTING_COLOR` (overridable with `SettingsListTheme.declared`), and `SettingsHost.declared(path)` reports which rows those are.

### Changed

- `Editor` re-announces its Vim mode through `onVimModeChange` when it gains focus, so a host's cursor shape follows the editor holding the keys ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))
- The `vim` status-line segment shows a pending command even with `display: "none"`, which now hides only the mode ([#20037](https://github.com/can1357/oh-my-pi/pull/20037) by [@lericson](https://github.com/lericson))

### Fixed

- Code blocks in a streaming reply now reach scrollback line by line as they scroll off screen, instead of staying out of reach until the block ends ([#13676](https://github.com/can1357/oh-my-pi/issues/13676), [#20561](https://github.com/can1357/oh-my-pi/pull/20561) by [@Frexxis](https://github.com/Frexxis))
- Reduced idle CPU use on Windows after `/restart` ([#20518](https://github.com/can1357/oh-my-pi/pull/20518) by [@ethancawse](https://github.com/ethancawse)).
- Reopened lost Tern surfaces on an `unknown surface` reply, stopped frames if the reopen was rejected, and kept recognizable broken TSP replies out of the editor ([#20550](https://github.com/can1357/oh-my-pi/issues/20550)).
- Typing in a Tern composer keeps echoing while an agent streams, instead of stalling for seconds when Tern is slow to acknowledge frames. ([#20463](https://github.com/can1357/oh-my-pi/pull/20463) by [@Xytronix](https://github.com/Xytronix))

## [19.2.1] - 2026-11-25

### Breaking Changes

- Removed the public `oneLine` export from `@oh-my-pi/pi-tui/term/painters/picker`; use `flattenLine` from `@oh-my-pi/pi-tui/text/sanitize` instead.

### Added

- Added the `change` UI event for annotated images, delivered to the node’s `onChange` handler without an associated item.

### Fixed

- Panes in a background Tern tab no longer log frame-acknowledgment stall warnings.

## [19.2.0] - 2026-11-25

### Added

- Added `@oh-my-pi/pi-tui`, a terminal UI with a unified Tern Surface Protocol node tree, native and terminal rendering, reactive signals, compiler-free JSX, role-based painters and widgets, terminal input and capability support, multiplexer and image handling, resize policies, notifications, Markdown and text utilities, themes, and terminal testing utilities.
- Added checkout event support to TSP connections and hosts.
- Added `label` to editor terminal decoration ranges: replacement text drawn in place of a range on rows where it fits and the caret is outside it.

### Changed

- Hosts now report when the terminal displays the checkout itself through `checkoutShown`.
- Theme files are polled for changes, keeping live reload working when editors replace files during save.
- Terminal animations now skip unchanged frames and share redraws with streaming content; shimmer motion runs at 20 fps.

### Fixed

- Fixed streaming Tern content being unnecessarily redrawn as newly inserted when content above it changes.
- Fixed keyboard events used to open a page from being delivered to the newly opened page as well.
- Fixed detection of LaTeX blocks beginning with `\begin`.
- Fixed Cmd+A selection in terminal-forwarded editors and inputs so typing, deletion, and paste replace the selected text.
- Fixed native overlays losing alignment with their anchored fields when the fields move or share local keys.
- Fixed native menu and tree interactions being delivered to the wrong control or branch, and prevented clicks behind modal sheets from moving focus outside the modal.
- Fixed terminal-row modal sheets allowing interaction with the content behind them, incorrect click and hover targets after scrolling, and mouse settings not being restored after closing fullscreen views.
- Fixed terminal replies leaking into the shell prompt after returning from a native session, including after fatal errors.
- Improved handling of large Tern transcript redraws when resuming sessions or returning from a subagent view.
