# 🐑 Fleece

[![CI](https://github.com/dmazlum/herdr-fleece/actions/workflows/ci.yml/badge.svg)](https://github.com/dmazlum/herdr-fleece/actions/workflows/ci.yml)

Frame your agent's last answer in [Herdr](https://herdr.dev), then copy, save, or send it.

A coding agent writes its best prose once and then scrolls it away. Fleece reads the
session transcript — not the pane — and hands the answer back as raw Markdown.

Requires **Node 20+**, **Herdr 0.8.0+**, and a **Claude Code** session. Codex is not
supported yet.

## Features

- **Frame.** Overlay the last answer on demand. `q` closes it. Copy, copy-code, or save
  without taking space from the agent pane.
- **Dock.** A narrow pane that lists files the agent edited, plus code, commands, paths,
  and links from the last few turns. One keystroke copies; `s` then a key sends.
- **Journal.** Optionally write every answer to disk as Markdown as it lands.
- **Clipboard.** Local tools (`pbcopy`, `wl-copy`, `xclip`, `xsel`) and OSC 52 over SSH.

## Install

```sh
herdr plugin install dmazlum/herdr-fleece
```

Or, while developing:

```sh
git clone https://github.com/dmazlum/herdr-fleece
cd herdr-fleece && npm ci && npm run build
herdr plugin link .
```

Herdr binds no keys by default. Add to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+f"
type = "plugin_action"
command = "fleece.frame"
description = "frame last answer"

[[keys.command]]
key = "prefix+shift+f"
type = "plugin_action"
command = "fleece.dock"
description = "toggle fleece dock"

[[keys.command]]
key = "prefix+y"
type = "plugin_action"
command = "fleece.copy"
description = "copy last answer"
```

After a rebuild, toggle the dock off and on — an open pane keeps the modules it loaded
at startup. Headless actions (`copy`, `save`, `journal`) always run the new build.

## Frame

`fleece.frame` opens the last answer in an overlay. It renders Markdown for reading;
`copy` and `save` always use the raw source.

| Key | Action |
| --- | --- |
| `y` | Copy the answer |
| `c` | Copy fenced code only |
| `m` | Save as Markdown |
| `j`/`k`, arrows, `PgUp`/`PgDn` | Scroll |
| `g`/`G` | Top / bottom |
| `q`, `Esc` | Close |

## Dock

`fleece.dock` splits a list beside the focused agent and never takes focus. It follows
pane focus and refreshes when that agent goes idle. Press `o` for the frame when the
list is not enough.

```
┌─ Fleece ── last 3 turns ────────────────┐
│ FILES                                   │
│  1 app/Models/Shipment.php           ×4 │
│  2 database/migrations/…_add_eta.php    │
│ CODE                                    │
│  3 public function up(): void     12 ln │
│ COMMANDS                                │
│  4 php artisan migrate                  │
│ LINKS                                   │
│  5 herdr.dev/docs/socket-api/           │
├─────────────────────────────────────────┤
│ key copy · s send             wC:p1 · live │
│ y all · m save · [ ] turn · q close     │
└─────────────────────────────────────────┘
```

What gets listed:

- **FILES** — from the agent's `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` calls.
  `Read` is omitted. The clipboard gets the absolute path.
- **CODE** — fenced blocks with a language tag, or contents that look like source.
- **PATH** — mentioned paths that exist on disk, after FILES has claimed the edited ones.
- **COMMAND** — runnable lines. A command shown with its result (`npm test → 70 passing`)
  is left out.

`[` / `]` walks that window back through the session. `y`, `m`, and `o` follow the
window. A new turn does not move a window you have paged away from.

| Key | Action |
| --- | --- |
| `1`–`9`, leftover letters | Copy that item |
| `s` then an item key | Send to the pane you came from (Esc cancels) |
| `y` | Copy the whole answer |
| `m` | Save as Markdown |
| `o` | Open the frame |
| `[` / `]` | Older / newer turns |
| `r` | Reload |
| `j`/`k` | Scroll |
| `q`, `Esc` | Close |

Send uses a bracketed paste and never presses Enter. Control bytes are stripped so a
payload cannot break the paste wrap.

## Commands

| Action | What it does |
| --- | --- |
| `fleece.frame` | Open the last answer in an overlay |
| `fleece.dock` | Toggle the dock beside the focused agent |
| `fleece.copy` | Copy the last answer |
| `fleece.copy-code` | Copy fenced code blocks only |
| `fleece.save` | Write the last answer to the export directory |
| `fleece.journal` | Write every unsaved answer in this session |
| `fleece.doctor` | Print what Fleece resolves from here |

From a shell, after `npm run build`:

```sh
node dist/cli.js frame --print
node dist/cli.js frame --json
node dist/cli.js copy --code
node dist/cli.js save --turn 12
node dist/cli.js doctor
```

## Configuration

`herdr plugin config-dir fleece` prints the directory. Create `config.toml` there:

```toml
export_dir       = "~/Documents/fleece"
include_prompt   = true
include_thinking = false
front_matter     = true
journal          = false
dock_turns       = 3
dock_width       = 46

[keys]
close       = "q"
down        = "j"
up          = "k"
page_down   = " "
top         = "g"
bottom      = "G"
reload      = "r"
send        = "s"
older       = "["
newer       = "]"
frame       = "o"
copy_answer = "y"
save        = "m"
```

A binding is one character. Hint rows and item-pick keys are derived from this table.
`fleece doctor` prints the bindings in force and anything it ignored. Escape, Ctrl+C,
arrows, and Page Up/Down are not bindable.

With `journal = true`, the dock writes new answers as they land. `fleece.journal`
backfills a session, including one the dock never saw. Files are named by project,
session, turn, and time; an existing file is left alone.

## License

MIT
