# Harness Link protocol v1

ALPN: `dsh-mobile/1`. All peers authenticate using their persistent iroh EndpointId. A desktop checks its device allowlist before accepting business requests. A new connection may only call `pairing.request`, `pairing.status`, and `hello` until desktop approval. No DSH token or model/provider credential crosses this protocol.

## Framing and streams

Ordinary frames use a four-byte unsigned big-endian byte length followed by UTF-8 JSON, capped at 1 MiB. Phone requests always use this ordinary format. Raw file bytes never use base64 JSON.

Only **Host → Mobile** may send a larger logical JSON message: first an ordinary frame containing `{ "v": 1, "type": "json-chunks", "length": N }`, then exactly `N` raw UTF-8 JSON bytes, with no per-chunk headers. `N` is the encoded byte count and must be **greater than 1 MiB and at most 16 MiB**. Both writer and reader transfer this raw region in blocks no larger than 64 KiB, so a Unicode character may span blocks; JSON/UTF-8 is decoded only after the complete message arrives. The header and entire raw body occupy one serialized writer operation: other responses, notices and subscription events cannot interleave. The next ordinary frame begins immediately after byte `N`.

The host rejects a phone-sent `json-chunks` envelope before allocating its body. A logical message above 16 MiB produces a clear size-limit failure, not truncation. Receivers bound allocation before reading; EOF/cancellation mid-body discards the incomplete logical message and closes that connection. Reconnection obtains new subscription generations and complete snapshots rather than resuming a partial JSON body. Session history remains paginated to avoid unnecessarily large messages. Upload/download stream framing below is unchanged.

The phone opens the first bidirectional stream and sends `{ "v": 1, "type": "stream", "kind": "rpc" }`. Requests are `{ "v": 1, "id": "uuid", "method": "sessions.list", "params": {} }`. Responses are `{ "v": 1, "id": "uuid", "result": {} }` or `{ "v": 1, "id": "uuid", "error": { "code": "...", "message": "...", "retryable": false } }`.

After authorization, the desktop opens one event stream, beginning with `{ "v": 1, "type": "stream", "kind": "events" }`. Each event is `{ "v": 1, "type": "event", "subscriptionId": "uuid", "generation": "uuid", "event": {} }`. A subscription result supplies its id and generation. Consumers buffer events received before the corresponding subscribe response, then reject stale generations. Each topic keeps its own upstream ordering; there is no global durable cursor.

The same event stream may carry `{ "v": 1, "type": "notice", "name": "push-configuration-changed" }`. This is not a subscription event. The phone asynchronously refreshes public push configuration and registration without blocking its event reader. The notice never contains credentials.

Uploads use a separate phone-opened bidirectional stream: a framed `{ "v": 1, "type": "stream", "kind": "upload", "uploadId": "uuid", "offset": 0, "length": 65536 }`, then exactly `length` raw bytes (at most 64 KiB), then a framed result from the desktop. Downloads use a separate stream with a framed `{ "v": 1, "type": "stream", "kind": "download", "downloadId": "uuid", "offset": 0 }`; the desktop returns framed metadata `{ "length": 123, "sha256": "..." }` followed by raw bytes. Upload/download handles belong to the authenticated device and have bounded lifetimes.

## Pairing

QR text is `dsh-mobile://pair?data=<base64url UTF-8 JSON>`. Its payload is `{ "v": 1, "endpointId": "...", "ticket": "...", "pairingId": "uuid", "secret": "256-bit-base64url", "expiresAt": 0, "name": "My Mac" }` (timestamps are Unix milliseconds). Invitations expire after five minutes and are consumed atomically after desktop approval. The connection's authenticated remote id, not a request field, identifies the mobile device. A connection must match the desktop id in the QR. `pairing.request` takes `{ pairingId, secret, name, platform: "android"|"ios" }` and returns `{ status: "pending", requestId }`. `pairing.status` takes `{requestId}` and returns pending/approved/rejected/expired; approved includes desktop metadata. Approved devices reconnect with `hello` and no invitation.

`hello` returns `{ protocolVersion: 1, authorized, hostId, hostInstanceId, hostName, dshVersion, adapterVersion, capabilities: string[] }`; unpaired replies omit private host state. Revocation closes every connection for that device.

## Operations

### Composer permissions and statistics

The `permissions` capability enables `permissions.catalog` (read), `permissions.select {sessionId,preset,acknowledged,operationId}` (mutation), and the process-scoped `permissions` subscription. The catalog carries only `options`, `defaultOptions` and `defaultPreset`; option entries contain `value,name,description?`. The subscription attaches the shared authenticated event listener before reading its first `{type:"baseline",value:catalog}` and re-reads the whole catalog after `permission-presets/catalog-changed`. Reconnect discards the prior generation's catalog.

Selection validates the value against a fresh live catalog and submits only `/permission <preset>` through official `commands.execute {agentId:sessionId,line,submittedAttachments:[]}`. There is no arbitrary slash-command endpoint and no write to the default for future sessions. `danger-full-access` and `auto` require `acknowledged:true`; the mobile UI mirrors the Web risk gate with a fresh unchecked acknowledgment. Unknown, withdrawn or control-character values are refused. The resulting `permissions.currentValue` projection, rather than a local optimistic preset, is authoritative. The client binds the action to the original host, session and connection generation and does not replay an uncertain write.

Read-only composer details reuse the existing full `session/follow` opening projection baseline and host-wide `sessionControl` replacement frames. `sessionStats`, `tokenUsage`, `contextPressure`, and `contextBreakdown` are never recomputed from the phone's paged messages or persisted on the phone. Missing projections stay unavailable, not invented zero values. Per-key sequence watermarks prevent an older baseline from replacing a newer update.

The usage total is `uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens`; reasoning is already included in output. Cache hit uses `cacheReadTokens / (uncachedInputTokens + cacheReadTokens + cacheWriteTokens)` and is absent when the denominator is zero. A partial hit is not rounded to 100%. Context occupancy uses `projectedTokens ?? pressureTokens` and a known positive `contextWindow`; its display percentage matches Web rounding and is capped at 100. The approximate system/tool/message composition proportions the occupied part of the bar and need not sum to the provider-anchored context reading. TTFT is `ttftMs / ttftSteps`; TPS is `decodeTokens / (decodeMs / 1000)` over the timed decode steps, rather than all output divided by total model time.

### Conversation file changes

The `changes` capability adds two read-only methods: `changes.summary {sessionId,seq}` and `changes.diff {sessionId,seq,index}`. They use the authenticated owner Peer's official Connection Fetch routes `/api/changes.summary` and `/api/changes.diff`, the same sources as the Web review UI. Callers cannot supply a filesystem path, arbitrary route or namespace. Neither method creates an operation-ledger entry.

Coordinates come from durable `workspace/changes` Session events; their data contains the turn number. Keep only the latest sequence for each turn. A file index always refers to the original, unfiltered summary order. Summary responses are `{status:"available",summary:{turn,files,total,added,deleted}}`; file entries contain `path,display,added,deleted` with optional `binary:true` or `oversized:true`. Host working directories and Git tree identifiers are omitted. `total` may exceed the number of served files. Per-turn counts must not be presented as a net conversation diff.

Diff responses are `{status:"available",diff:WorkspaceFileDiff}` using the public DSH DTO: `kind:"text"` includes `path,display,before,after,hunks,coarse`; each hunk includes `oldStart,oldLines,newStart,newLines,lines` with `+`, `-` or space prefixes. `before`/`after` determine added/deleted/modified status. Binary and oversized variants contain only `kind,path,display`. `coarse:true` means the Host fell back to whole-file replacement.

Both methods return `{status:"unavailable"}` when the Host no longer serves that snapshot (or the Web route is absent). This is distinct from an available summary with zero files. Transient server failures remain errors with an explicit retry action. Snapshots are not durable across Host restart or Session disposal. The phone holds summaries and comparisons only in the open panel's memory, discards them on connection-generation or conversation changes, and never reconstructs old diffs from the current working tree. History is paged on demand; the UI identifies that only loaded rounds are shown. Git snapshots cover turn-start/end changes; outside Git, the official recorder covers file-tool mutations rather than arbitrary shell edits.

Business mutations carry `operationId` in params. Prompts additionally carry a persistent `requestId`. The same id must always carry identical content. A dispatched non-idempotent operation with an unknown outcome must not be automatically replayed.

The following fixed mobile methods map to existing DSH APIs through the bridge; there is no generic namespace/method passthrough:

* `sessions.list`, `sessions.search`, `sessions.create`, `sessions.rename`, `sessions.fork`, `sessions.prompt`, `sessions.cancel`, `sessions.updateQueue`, `sessions.events`, `sessions.state`, `sessions.projections`.
* `sessions.archive`, `sessions.unarchive`, `sessions.pin`, `sessions.unpin` map to workspace APIs.
* `workspaces.list`, `workspaces.create`, `workspaces.rename`, `models.list`, `models.select`.
* `files.list`, `files.stat`, `files.read`, `files.download`.
* `feedback.list`, `feedback.put`, `feedback.delete` map to the official `messageFeedback` service. Mutations retain `ifVersion` compare-and-set semantics; a conflict is reported instead of overwriting another device.
* `jobs.list`, `jobs.kill`, `interactions.reply`, `questions.answer`.
* `subscribe` takes `{ topic, request }` and returns `{ subscriptionId, generation }`; `unsubscribe` takes `{subscriptionId}`. Topics: `sessions`, `session`, `sessionState`, `sessionControl`, `workspaces`, `interactions`, `questionWait`, `jobs`, `job`, `files`, `feedback`. The feedback topic opens its event listener before reading the authoritative list, and emits a new `{type:"baseline",value:{items:[...]}}` after every feedback change.
* `attachments.begin`, `attachments.status`, `attachments.finalize`, `attachments.cancel`.
* `push.describe`, `push.configuration`, `push.register`, `push.unregister`, `push.received`. `push.describe` sends public application metadata `{platform,applicationId,teamId?,environment?}` before provider setup so the desktop can prefill its import wizard. Metadata is an informational hint, not proof of signing-key permission.

Except mobile operation ids, domain request fields follow the pinned DSH DTOs. `session/follow` has NO afterSeq parameter. It opens with a baseline and its own cursor, then events. Transient assistant chunks are NOT durable journal records. Desktop browser drafts and arbitrary plugin UI are not remotely synchronized.

Secrets may only be imported through the local desktop configuration surface. `push.configuration` returns public FirebaseOptions only. All push registrations bind to the current authenticated peer, never a caller-supplied device id.

`push.describe` accepts `{platform,applicationId,teamId?,environment?}` from an authenticated device before push credentials are configured. These are advisory values for the local setup form, never authorization claims. After the desktop imports push configuration it sends `{ "v": 1, "type": "notice", "name": "push-configuration-changed" }` on the authorized event stream. This frame has no subscription id; clients handle it separately and asynchronously fetch `push.configuration`, then register their OS token. No credentials or private configuration appear in the notice.

## Desktop presentation data

Session follow snapshots, completed `turn/end` frames, and `sessions.events` history results may include `presentation: { turns: [...] }`. Each turn carries the real `endSeq`, closing-message identity/time/text, first assistant sequence, completion status, optional desktop-computed duration and exact `tokenUsage`, plus the same branch boundary availability as the pinned Web UI. The desktop uses the pinned official Web token accounting algorithm. Incomplete history or unproven usage omits totals; clients must not manufacture or sum a second total.

Mobile clients keep these business snapshots and event rows in memory. Only pairing identity, paired-computer configuration and notification setup persist on the phone. Reopening the App fetches desktop state again. Trace UI reads these same official events and pages history on demand.

## Interactive requests (adapter 0.1.1)

An authenticated owner Peer has one upstream Gateway `$events` client shared by its `sessions` and `interactions` subscriptions. The interactions topic forwards `ready {clientId}`, `waterfall {eventId,event,agentId,request}` and `cancel {eventId}`. Supported waterfalls are `approval/request` and `user-questions/request`; unsupported types are delegated with `next` rather than held invisibly. A new subscriber receives the current pending deliveries. Reconnection creates a new client and generation; old replies cannot answer a new delivery.

`interactions.reply` takes `{clientId,eventId,outcome}`. The client and event must belong to this Peer. For `outcome: {kind:"result",value}`, a plain approval value is exactly `"allowed-once"` or `"rejected"`. A question value is `{answers:[{id,selected:string[],custom?:string}]}` with one entry per original question. Selected values must be offered option labels; non-multiselect questions accept at most one. An empty selection without custom text explicitly skips a general question. An `intent.kind:"approval"` question accepts one offered action and no custom text; persistent permission is offered only when the original request declares `always`. Plan-review details and question intents follow the pinned official DTOs.

The Host returns `{accepted:boolean}` and echoes cancellation to the replying phone as well as forwarding official cancellation from other answerers. A confirmed mobile reply, a Web reply, host cancellation, revocation or disconnect must release the local delivery and any wait claim. The upstream services decide the first valid answer; the phone never applies permissions independently.

The `interaction-waits` hello capability enables `subscribe {topic:"questionWait",request:{clientId,eventId}}`. The Host resolves that exact pending timed question to its original Agent and call, then retains the official `userQuestions.attachWait` stream. It sends `{type:"waiting",eventId,remainingMs}` and, on completion, `{type:"ended",eventId}`. Unsubscribe releases the claim. Relative budgets use a monotonic mobile clock; focus, editing and an explicit hold pause the countdown. On local expiry the client releases its claim and rejects the delivery with `{kind:"rejected",error:{name:"UserQuestionError",code:"ASK_TIMED_OUT",message:"Question timed out"}}`, matching the official Web client.

Timed calls may remain answerable as `userQuestions.active` projection rows in state `continued`. The phone merges live deliveries and projections by Session plus callId, across every screen. It recovers projections using `sessionControl` and nonactivating `sessions.projections` reads of listed sessions after connection. `questions.answer {sessionId,callId,answer}` validates the authoritative continued question and holds an official Session activation lease while submitting. It returns the upstream boolean; a duplicate or settled call is not re-enqueued. Questions, drafts, clocks and settlement suppression stay in memory; reconnect obtains the current Host state again.

Only official agent interaction requests are included. Desktop settings, operating-system permission prompts and arbitrary third-party React dialogs are not serialized as mobile interfaces.
