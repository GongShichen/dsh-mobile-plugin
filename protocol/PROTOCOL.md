# DSH Mobile protocol v1

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

Business mutations carry `operationId` in params. Prompts additionally carry a persistent `requestId`. The same id must always carry identical content. A dispatched non-idempotent operation with an unknown outcome must not be automatically replayed.

The following fixed mobile methods map to existing DSH APIs through the bridge; there is no generic namespace/method passthrough:

* `sessions.list`, `sessions.search`, `sessions.create`, `sessions.rename`, `sessions.fork`, `sessions.prompt`, `sessions.cancel`, `sessions.updateQueue`, `sessions.events`, `sessions.state`, `sessions.projections`.
* `sessions.archive`, `sessions.unarchive`, `sessions.pin`, `sessions.unpin` map to workspace APIs.
* `workspaces.list`, `workspaces.create`, `workspaces.rename`, `models.list`, `models.select`.
* `files.list`, `files.stat`, `files.read`, `files.download`.
* `jobs.list`, `jobs.kill`, `interactions.reply`, `questions.answer`.
* `subscribe` takes `{ topic, request }` and returns `{ subscriptionId, generation }`; `unsubscribe` takes `{subscriptionId}`. Topics: `sessions`, `session`, `sessionState`, `sessionControl`, `workspaces`, `interactions`, `jobs`, `job`, `files`.
* `attachments.begin`, `attachments.status`, `attachments.finalize`, `attachments.cancel`.
* `push.describe`, `push.configuration`, `push.register`, `push.unregister`, `push.received`. `push.describe` sends public application metadata `{platform,applicationId,teamId?,environment?}` before provider setup so the desktop can prefill its import wizard. Metadata is an informational hint, not proof of signing-key permission.

Except mobile operation ids, domain request fields follow the pinned DSH DTOs. `session/follow` has NO afterSeq parameter. It opens with a baseline and its own cursor, then events. Transient assistant chunks are NOT durable journal records. Desktop browser drafts and arbitrary plugin UI are not remotely synchronized.

Secrets may only be imported through the local desktop configuration surface. `push.configuration` returns public FirebaseOptions only. All push registrations bind to the current authenticated peer, never a caller-supplied device id.

`push.describe` accepts `{platform,applicationId,teamId?,environment?}` from an authenticated device before push credentials are configured. These are advisory values for the local setup form, never authorization claims. After the desktop imports push configuration it sends `{ "v": 1, "type": "notice", "name": "push-configuration-changed" }` on the authorized event stream. This frame has no subscription id; clients handle it separately and asynchronously fetch `push.configuration`, then register their OS token. No credentials or private configuration appear in the notice.
