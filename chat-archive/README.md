# Chat Archive Viewer

A small React + Vite application that renders `.jsonl` transcripts (Codex CLI chat exports) as a chat-style conversation viewer.

## Getting started

```bash
npm install
npm run dev
```

Open the printed URL (default: `http://localhost:5173`).

## Adding transcripts

Place one or more `.jsonl` files alongside this project (e.g. `chat-archive/chat2.jsonl`). The sidebar lists every available transcript; pick one to view its parsed messages. When a new file is added while the dev server is running, trigger a refresh to pick it up.

Each transcript is lazy-loaded, so large logs only load once selected. Use the “Show events” toggle to expose tool calls and other non-message items that were captured in the log.

## Build

```bash
npm run build
npm run preview
```

This compiles the static site into `dist/` and serves it locally with the same file listing behaviour.
