import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

type RawLoader = () => Promise<string>

type ChatModuleMap = Record<string, RawLoader>

type SessionMeta = {
  id?: string
  timestamp?: string
  cwd?: string
  originator?: string
  cliVersion?: string
  git?: {
    commit?: string
    branch?: string
    repositoryUrl?: string
  }
  raw: unknown
}

type MessageEntry = {
  id: string
  kind: 'message'
  role: string
  timestamp?: string
  text: string
}

type EventEntry = {
  id: string
  kind: 'event'
  label: string
  details?: string
  timestamp?: string
  severity: 'info' | 'warning'
}

type ErrorEntry = {
  id: string
  kind: 'error'
  message: string
  rawLine: string
}

type ChatEntry = MessageEntry | EventEntry | ErrorEntry

type ParsedChat = {
  entries: ChatEntry[]
  meta?: SessionMeta
}

type ChatFile = {
  id: string
  fileName: string
  title: string
  loader: RawLoader
}

const humanizeFileName = (fileName: string): string => {
  const withoutExt = fileName.replace(/\.jsonl$/i, '')
  if (!withoutExt) return fileName
  return withoutExt
    .replace(/[\-_.]+/g, ' ')
    .replace(/\b\w/g, (token) => token.toUpperCase())
}

const chatModules = import.meta.glob('../*.jsonl', {
  query: '?raw',
  import: 'default',
}) as ChatModuleMap

const chatFiles: ChatFile[] = Object.entries(chatModules)
  .map(([path, loader]) => {
    const fileName = path.split('/').pop() ?? path
    return {
      id: fileName,
      fileName,
      title: humanizeFileName(fileName),
      loader,
    }
  })
  .sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }))

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
})

const formatTimestamp = (value?: string): string | undefined => {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return undefined
  }
  return dateFormatter.format(parsed)
}

const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2)
  } catch (error) {
    return String(error)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

const toStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null
  return value.map((item) => (typeof item === 'string' ? item : item == null ? '' : String(item)))
}

const formatShellCommandMarkdown = (args: unknown): string => {
  if (!isRecord(args)) {
    const serialized = typeof args === 'string' ? args : toJson(args)
    return `\`\`\`shell\n${serialized}\n\`\`\``
  }

  const commandParts = toStringArray(args.command)
  const commandText = commandParts?.length ? commandParts.join(' ') : undefined
  const lines: string[] = []

  if (commandText) {
    lines.push('```shell', commandText, '```')
  } else {
    lines.push('```json', toJson(args), '```')
  }

  const meta: string[] = []
  if (typeof args.workdir === 'string' && args.workdir) {
    meta.push(`cwd: ${args.workdir}`)
  }
  if (typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)) {
    meta.push(`timeout: ${(args.timeout_ms / 1000).toFixed(1)}s`)
  }

  if (meta.length > 0) {
    lines.push('', meta.join(' · '))
  }

  return lines.join('\n')
}

const formatShellResultMarkdown = (
  data: unknown,
): { markdown: string; exitCode?: number } => {
  let outputText = ''
  let metadata: Record<string, unknown> | undefined

  if (isRecord(data) && 'output' in data) {
    const record = data as Record<string, unknown>
    const rawOutput = record.output
    outputText = typeof rawOutput === 'string' ? rawOutput : toJson(rawOutput)
    metadata = isRecord(record.metadata) ? (record.metadata as Record<string, unknown>) : undefined
  } else if (typeof data === 'string') {
    outputText = data
  } else {
    outputText = toJson(data)
  }

  const normalizedOutput = outputText.replace(/\r\n/g, '\n')
  const lines: string[] = []
  lines.push('```shell', normalizedOutput.trimEnd(), '```')

  const metaLines: string[] = []
  let exitCode: number | undefined

  if (metadata) {
    const rawExit = metadata.exit_code
    if (typeof rawExit === 'number' && Number.isFinite(rawExit)) {
      exitCode = rawExit
    } else if (typeof rawExit === 'string') {
      const parsed = Number(rawExit)
      if (Number.isFinite(parsed)) {
        exitCode = parsed
      }
    }

    const rawDuration = metadata.duration_seconds
    if (typeof rawDuration === 'number' && Number.isFinite(rawDuration)) {
      metaLines.push(`duration: ${rawDuration.toFixed(1)}s`)
    }

    if (exitCode !== undefined) {
      metaLines.unshift(`exit code: ${exitCode}`)
    }
  }

  if (metaLines.length > 0) {
    lines.push('', metaLines.join(' · '))
  }

  return {
    markdown: lines.join('\n'),
    exitCode,
  }
}

const extractText = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]

  if (Array.isArray(content)) {
    return content.flatMap((piece) => extractText(piece))
  }

  if (content && typeof content === 'object') {
    if ('text' in content && typeof (content as { text: unknown }).text === 'string') {
      return [(content as { text: string }).text]
    }
    if ('content' in content && typeof (content as { content: unknown }).content === 'string') {
      return [(content as { content: string }).content]
    }
  }

  return []
}

const parseChatFile = (raw: string): ParsedChat => {
  const entries: ChatEntry[] = []
  let meta: SessionMeta | undefined
  const functionCallMetadata = new Map<string, { name?: string; args?: unknown }>()

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  lines.forEach((line, index) => {
    try {
      const data = JSON.parse(line) as Record<string, unknown>
      const timestamp = typeof data.timestamp === 'string' ? data.timestamp : undefined
      const baseId = `${index}-${timestamp ?? 'entry'}`

      switch (data.type) {
        case 'session_meta': {
          if (data.payload && typeof data.payload === 'object') {
            const payload = data.payload as Record<string, unknown>
            const git = payload.git && typeof payload.git === 'object' ? (payload.git as Record<string, unknown>) : null
            meta = {
              id: typeof payload.id === 'string' ? payload.id : undefined,
              timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
              cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
              originator: typeof payload.originator === 'string' ? payload.originator : undefined,
              cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : undefined,
              git: git
                ? {
                    commit: typeof git.commit_hash === 'string' ? git.commit_hash : undefined,
                    branch: typeof git.branch === 'string' ? git.branch : undefined,
                    repositoryUrl: typeof git.repository_url === 'string' ? git.repository_url : undefined,
                  }
                : undefined,
              raw: payload,
            }
          }
          break
        }
        case 'response_item': {
          if (!data.payload || typeof data.payload !== 'object') {
            entries.push({
              id: `malformed-${baseId}`,
              kind: 'event',
              label: 'Unknown response item',
              details: toJson(data.payload),
              timestamp,
              severity: 'warning',
            })
            break
          }

          const payload = data.payload as Record<string, unknown>
          const payloadType = typeof payload.type === 'string' ? payload.type : 'unknown'

          if (payloadType === 'message') {
            const role = typeof payload.role === 'string' ? payload.role : 'assistant'
            const textSegments = extractText(payload.content)
            entries.push({
              id: `message-${baseId}`,
              kind: 'message',
              role,
              timestamp,
              text: textSegments.join('\n\n') || '[empty message]',
            })
            break
          }

          if (payloadType === 'reasoning') {
            const summary = Array.isArray(payload.summary)
              ? (payload.summary as Array<{ text?: string }>)
                  .map((item) => item.text)
                  .filter((value): value is string => Boolean(value))
                  .join('\n\n')
              : undefined

            entries.push({
              id: `reasoning-${baseId}`,
              kind: 'event',
              label: 'Reasoning summary',
              details: summary ?? 'Reasoning content hidden.',
              timestamp,
              severity: 'info',
            })
            break
          }

          if (payloadType === 'function_call') {
            const name = typeof payload.name === 'string' ? payload.name : 'unknown function'
            const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined

            let parsedArguments: unknown = payload.arguments
            if (typeof payload.arguments === 'string') {
              parsedArguments = safeParseJson(payload.arguments) ?? payload.arguments
            }

            if (callId) {
              functionCallMetadata.set(callId, {
                name: typeof payload.name === 'string' ? payload.name : undefined,
                args: parsedArguments,
              })
            }

            let details: string | undefined
            if (name === 'shell') {
              details = formatShellCommandMarkdown(parsedArguments)
            } else if (parsedArguments !== undefined) {
              const serialized =
                typeof parsedArguments === 'string' ? parsedArguments : toJson(parsedArguments)
              details = `\`\`\`json\n${serialized}\n\`\`\``
            }

            entries.push({
              id: `function-${baseId}`,
              kind: 'event',
              label: name === 'shell' ? 'Shell command' : `Function call: ${name}`,
              details,
              timestamp,
              severity: 'info',
            })
            break
          }

          if (payloadType === 'function_call_output') {
            const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
            const linkedCall = callId ? functionCallMetadata.get(callId) : undefined
            if (callId) {
              functionCallMetadata.delete(callId)
            }

            const parsedOutput =
              typeof payload.output === 'string'
                ? safeParseJson(payload.output) ?? payload.output
                : payload.output

            const observationValue = (payload as { observation?: unknown }).observation
            const parsedObservation =
              typeof observationValue === 'string'
                ? safeParseJson(observationValue) ?? observationValue
                : observationValue

            const resultValue = parsedOutput ?? parsedObservation

            let details: string | undefined
            let severity: 'info' | 'warning' = 'info'

            if (linkedCall?.name === 'shell') {
              const { markdown, exitCode } = formatShellResultMarkdown(resultValue)
              details = markdown
              if (exitCode !== undefined && exitCode !== 0) {
                severity = 'warning'
              }
            } else if (typeof resultValue === 'string') {
              details = resultValue
            } else if (resultValue !== undefined) {
              details = `\`\`\`json\n${toJson(resultValue)}\n\`\`\``
            } else if (typeof payload.output === 'string') {
              details = payload.output
            } else if (payload.output !== undefined) {
              details = `\`\`\`json\n${toJson(payload.output)}\n\`\`\``
            }

            entries.push({
              id: `function-output-${baseId}`,
              kind: 'event',
              label: linkedCall?.name === 'shell' ? 'Shell result' : 'Function result',
              details,
              timestamp,
              severity,
            })
            break
          }

          entries.push({
            id: `response-${baseId}`,
            kind: 'event',
            label: `Response item: ${payloadType}`,
            details: toJson(payload),
            timestamp,
            severity: 'warning',
          })
          break
        }
        case 'event_msg': {
          if (data.payload && typeof data.payload === 'object') {
            const payload = data.payload as Record<string, unknown>
            const eventType = typeof payload.type === 'string' ? payload.type : 'event'
            const text =
              typeof payload.message === 'string'
                ? payload.message
                : typeof payload.text === 'string'
                  ? payload.text
                  : toJson(payload)

            entries.push({
              id: `event-${baseId}`,
              kind: 'event',
              label: eventType.replace(/_/g, ' '),
              details: text,
              timestamp,
              severity: 'info',
            })
            break
          }

          entries.push({
            id: `event-${baseId}`,
            kind: 'event',
            label: 'Event message',
            details: toJson(data.payload),
            timestamp,
            severity: 'warning',
          })
          break
        }
        default: {
          entries.push({
            id: `unknown-${baseId}`,
            kind: 'event',
            label: `Unhandled item: ${String(data.type ?? 'unknown')}`,
            details: toJson(data),
            timestamp,
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      entries.push({
        id: `parse-error-${index}`,
        kind: 'error',
        message: `Unable to parse line ${index + 1}: ${(error as Error).message}`,
        rawLine: line,
      })
    }
  })

  return { entries, meta }
}

const emptyMessage = 'Drop .jsonl files in this folder to see them listed here.'

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
}

function App(): ReactNode {
  const [activeFileId, setActiveFileId] = useState<string | null>(chatFiles[0]?.id ?? null)
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [meta, setMeta] = useState<SessionMeta | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showEvents, setShowEvents] = useState(false)

  const activeFile = useMemo(() => chatFiles.find((file) => file.id === activeFileId) ?? null, [activeFileId])

  useEffect(() => {
    let canceled = false

    if (!activeFile) {
      setEntries([])
      setMeta(undefined)
      setIsLoading(false)
      setLoadError(null)
      return undefined
    }

    setIsLoading(true)
    setLoadError(null)

    activeFile
      .loader()
      .then((raw) => {
        if (canceled) return
        const parsed = parseChatFile(raw)
        setEntries(parsed.entries)
        setMeta(parsed.meta)
        setIsLoading(false)
      })
      .catch((error) => {
        if (canceled) return
        setEntries([])
        setMeta(undefined)
        setIsLoading(false)
        setLoadError(error instanceof Error ? error.message : 'Failed to load transcript.')
      })

    return () => {
      canceled = true
    }
  }, [activeFile])

  const visibleEntries = useMemo(() => {
    if (showEvents) return entries
    return entries.filter((entry) => entry.kind !== 'event')
  }, [entries, showEvents])

  return (
    <div className="chat-app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Chat Archive</h1>
          <p>Transcripts: {chatFiles.length}</p>
        </div>

        <div className="file-list" role="navigation" aria-label="Chat transcripts">
          {chatFiles.length === 0 && <p className="empty-message">{emptyMessage}</p>}

          {chatFiles.map((file) => (
            <button
              key={file.id}
              type="button"
              className={file.id === activeFileId ? 'file-item active' : 'file-item'}
              onClick={() => setActiveFileId(file.id)}
            >
              <span className="file-title">{file.title}</span>
              <span className="file-name">{file.fileName}</span>
            </button>
          ))}
        </div>
      </aside>

      {activeFile ? (
        <section className="chat-view">
          <header className="chat-header">
            <div>
              <h2>{activeFile.title}</h2>
              <span className="chat-subtitle">{activeFile.fileName}</span>
            </div>

            <div className="chat-actions">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={showEvents}
                  onChange={(event) => setShowEvents(event.target.checked)}
                />
                <span>Show events</span>
              </label>
            </div>
          </header>

          {meta && (
            <div className="session-meta">
              <dl>
                {meta.timestamp && (
                  <div>
                    <dt>Session start</dt>
                    <dd>{formatTimestamp(meta.timestamp) ?? meta.timestamp}</dd>
                  </div>
                )}
                {meta.id && (
                  <div>
                    <dt>Session ID</dt>
                    <dd>{meta.id}</dd>
                  </div>
                )}
                {meta.originator && (
                  <div>
                    <dt>Originator</dt>
                    <dd>{meta.originator}</dd>
                  </div>
                )}
                {meta.cwd && (
                  <div>
                    <dt>Working directory</dt>
                    <dd>{meta.cwd}</dd>
                  </div>
                )}
                {meta.cliVersion && (
                  <div>
                    <dt>CLI version</dt>
                    <dd>{meta.cliVersion}</dd>
                  </div>
                )}
                {meta.git?.branch && (
                  <div>
                    <dt>Git branch</dt>
                    <dd>{meta.git.branch}</dd>
                  </div>
                )}
                {meta.git?.commit && (
                  <div>
                    <dt>Commit</dt>
                    <dd>{meta.git.commit}</dd>
                  </div>
                )}
                {meta.git?.repositoryUrl && (
                  <div>
                    <dt>Repository</dt>
                    <dd>{meta.git.repositoryUrl}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          <div className="chat-entries">
            {isLoading && <p className="status">Loading transcript…</p>}
            {loadError && <p className="status error">{loadError}</p>}
            {!isLoading && !loadError && visibleEntries.length === 0 && (
              <p className="status">No entries to show.</p>
            )}

            {visibleEntries.map((entry) => {
              if (entry.kind === 'message') {
                const roleClass = entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'other'
                return (
                  <article key={entry.id} className={`chat-bubble ${roleClass}`}>
                    <header>
                      <span className="bubble-role">{entry.role}</span>
                      {entry.timestamp && <time>{formatTimestamp(entry.timestamp) ?? entry.timestamp}</time>}
                    </header>
                    <ReactMarkdown
                      className="chat-markdown"
                      remarkPlugins={[remarkGfm]}
                      components={markdownComponents}
                    >
                      {entry.text}
                    </ReactMarkdown>
                  </article>
                )
              }

              if (entry.kind === 'event') {
                return (
                  <article key={entry.id} className={`chat-event ${entry.severity}`}>
                    <header>
                      <span>{entry.label}</span>
                      {entry.timestamp && <time>{formatTimestamp(entry.timestamp) ?? entry.timestamp}</time>}
                    </header>
                    {entry.details && (
                      <ReactMarkdown
                        className="event-markdown"
                        remarkPlugins={[remarkGfm]}
                        components={markdownComponents}
                      >
                        {entry.details}
                      </ReactMarkdown>
                    )}
                  </article>
                )
              }

              return (
                <article key={entry.id} className="chat-error">
                  <header>
                    <span>Parsing issue</span>
                  </header>
                  <p>{entry.message}</p>
                  <pre>{entry.rawLine}</pre>
                </article>
              )
            })}
          </div>
        </section>
      ) : (
        <section className="chat-view">
          <p className="status">Select a transcript to inspect.</p>
        </section>
      )}
    </div>
  )
}

export default App
