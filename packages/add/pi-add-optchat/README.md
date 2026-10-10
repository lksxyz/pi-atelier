# @lukisxyz/pi-add-optchat

Persistent project chat memory for Pi, based on Victor Taelin's [OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449).

Each project gets an append-only message log and a binary summary tree. A bounded view becomes context on each turn; `zoom` opens summaries down to original messages. Shared notes live separately under `~/.pi/agent/optchat/global`.

## Install

```sh
pi install npm:@lukisxyz/pi-add-optchat
```

## Commands and tools

- `/optchat` — status and memory storage paths
- `/optchat note <text>` — append a cross-project note
- `zoom(id, count, scope?)` — open a historical message or aligned summary range
- `date(id, scope?)` — retrieve original message date
- `search_memory(query, limit?, scope?)` — find likely message IDs, then inspect them with `zoom`

`scope` defaults to `project`; use `global` for shared notes. Project logs are stored under `~/.pi/agent/optchat/projects/<encoded-absolute-project-path>/`. They are not checked into project repositories. Each store takes an exclusive writer lock.

## Design

The view retains chronological context while merging old adjacent summaries first, ranked by how long ago the pair ended in units of its own line size. The view is persisted and never rebuilt when logs exist, to preserve prompt-cache stability. Messages and summaries append to daily JSONL files; each line flushes before continuing. Message chunks are capped at 30 KB. Summaries target 512 UTF-8 bytes. The view grows toward 128 KB and batches merges toward 64 KB.

This implementation uses Pi's active model for bounded background summaries and adds the bounded view to each request without replaying older transcript messages. That preserves configured authentication and avoids imposing a provider choice; choose a cheap model before using the extension. Effect v4 wraps I/O and model requests.

A separate project/global store and `/optchat note` follow the gist comments' suggestion for split memory. Gist comments flag topic saturation/scatter. This version adds a lightweight keyword search pointer tool; it is not a semantic topic index. It does not yet import old sessions or provide a profile system. Pi continues to own its session transcript; OptChat memory is an additional persistent recall view, not a replacement for Pi's normal context/compaction.

## Development

```sh
pnpm --filter @lukisxyz/pi-add-optchat typecheck
pnpm --filter @lukisxyz/pi-add-optchat test
```
