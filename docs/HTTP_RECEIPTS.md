# Optional direct receipt HTTP transport

**Default off; code availability is not deployment or permission to enable it.** Issue receipts submit and query existing durable source bindings. Separately configured named announcements use pinned local audiences without an Issue binding. Neither accepts recipient IDs, authenticates business completion, or executes commands. Existing Slack intake, ordinary TTLs and attachments are unchanged.

## Trust and activation boundary

This deliberately has no account, token or application authentication system. A caller is admitted by its actual TCP peer IP, a separately configured repository allowlist, and an existing valid source binding. This identifies a network address, **not a particular app, user or Codex process**. Any process/device able to use an admitted source address can submit public text to bound audiences and query delivery states. NAT, proxies, shared machines and compromised clients may broaden that audience. Forwarded-IP headers are ignored. Private addressing alone is not authentication; plain HTTP does not provide encryption or integrity against network attackers.

Before enabling, separately approve the exact bind address/port, permitted source devices and network path, disclosure scope, transport risk, deployment/backup/rollback and real test audience. Verify the real network boundary; do not assume only one developer tool can reach it. Do not open a public listener, disable network controls, create credentials or expand persistent access as part of installing this code. Browser Origin requests and unexpected Host headers are rejected; these checks are additional restrictions, not identity authentication.

The existing single bridge process owns the HTTP server, private SQLite and outbox. Do not run another writer or a second robot connection. All of these settings are required when enabling:

|Setting|Meaning|
|---|---|
|`RECEIPT_HTTP_ENABLED`|Exactly `true` enables; absent/`false` creates no listener|
|`RECEIPT_HTTP_TRUST_NETWORK`|Must explicitly be `true`; acknowledges the network trust model, does not secure the network|
|`RECEIPT_HTTP_HOST`|Exact loopback or RFC1918 IPv4 literal, or `::1`; no wildcard/public address/hostname|
|`RECEIPT_HTTP_PORT`|Explicit integer 1–65535|
|`RECEIPT_HTTP_CLIENT_IPS`|Nonempty comma-separated exact permitted loopback/private IP literals; no CIDRs or forwarded headers|
|`RECEIPT_HTTP_REPOSITORIES`|Nonempty subset of existing `FEEDBACK_ALLOWED_REPOSITORIES`|

The normal feedback configuration (fixed responder bot/user, robot, owner, private channel, repository and group allowlists) must remain valid. Each call rechecks the saved binding against it; submission requires an active binding and the original pinned audience. HTTP never fabricates a Slack event or accepts Slack identity fields. Revocation/config changes still block queued output under existing transport checks. Removing only an HTTP admission setting prevents new calls; already accepted jobs remain subject to the existing feedback/outbound policy. Stop the service or revoke the binding using the existing authorized path if pending output must be stopped. None of this can retract an in-flight send.

## Two operations

Both use `POST`, exact `Content-Type: application/json`, a Content-Length and one flat UTF-8 JSON object. No query string, trailing route, duplicate/extra fields, nested data, content encoding or transfer encoding. Maximum HTTP body: 16384 bytes; public text: 3000 UTF-8 bytes. Supply Host as the configured IP literal and port (bracket IPv6). Example data is synthetic; it is not a request to run a test against an existing service.

`POST /v1/receipts`:

```json
{"repository":"example/project","issue":17,"deliveryId":"receipt-example-v1","text":"The approved result and remaining limitations."}
```

`POST /v1/receipts/status`:

```json
{"repository":"example/project","issue":17,"deliveryId":"receipt-example-v1"}
```

Only these fields are accepted. There is no target/chat/user/root/bind/revoke/config/command parameter. Caller-supplied text is untrusted public content, never a command. The caller must independently verify evidence and allowed disclosure; do not include source, raw logs, credentials, personal identifiers or private links. Completion/approval logic belongs to the caller's workflow, not this generic bridge.

|Response|Meaning|
|---|---|
|202 `{"status":"accepted","delivery":"pending"}`|Persisted admission; `delivery` is the current stored state, possibly already `wecom_ack` or `unknown` for a duplicate. Acceptance is not a WeCom ACK|
|200 `{"status":"wecom_ack"}`|Status lookup: the SDK returned a successful ACK and local state recorded it; not audience read or business acceptance|
|200 other status|`pending`, `sending`, `unknown`, `revoked`, `expired`, `quarantined` or `not_found` reflect stored transport facts; not permission to replay|
|400 / 413 / 415|Invalid input / excessive body / unsupported content type; no result admitted|
|403 `unavailable`|Network admission, repository, binding, active state or existing policy unavailable; no route details disclosed|
|404|Unsupported route/method|
|409 `conflict`|deliveryId belongs to another binding or different text; do not change ID to evade it|
|408 / dropped connection|Request deadline/connection limit; never infer whether a previous submission committed|
|503 `unavailable`|Internal failure; outcome may need lookup, no internal errors returned|

A revoked/invalid binding cannot be queried through this endpoint; 403 does not erase its prior delivery evidence. Status lookup is read-only and creates no Slack/WeCom jobs. Responses expose no routing identity, private logs or credentials; requests/bodies are not logged. HTTP accepted state is distinct from Slack accepted/ACK, which this path does not produce.

## Optional named announcements

`RECEIPT_HTTP_ANNOUNCEMENT_TARGETS` defaults to `[]`. An explicitly approved local array may contain up to 16 entries, each with exactly `repository,name,chatId`. Repositories must already be admitted by receipt HTTP; chat IDs must already be in the group allowlist. Names match `[a-z][a-z0-9-]{0,63}` and are unique within a repository. Synthetic configuration:

```json
[{"repository":"example/project","name":"dev-deploy","chatId":"synthetic-approved-group"}]
```

This enables `POST /v1/announcements` with exactly `repository,name,deliveryId,text`, and `POST /v1/announcements/status` with exactly `repository,name,deliveryId`. They use the same network admission, JSON restrictions, limits and response states as receipts. Requests cannot contain an Issue, recipient, identity, command or configuration field. Status lookup creates no binding or job.

A first submission transaction pins a separate announcement binding to the locally configured audience, owner, channel and robot. It neither uses nor modifies Issue source bindings. Existing bindings cannot be redirected by changing configuration. Each output rechecks the named route and current identities; revocation blocks new output, but cannot retract an in-flight send. Unlike existing Issue receipts, disabling HTTP or removing its repository also prevents announcement output. Older code does not authorize this new request kind: on rollback it may revoke pending announcements, so preserve the new evidence and inspect it before continuing.

Announcements share the global deliveryId namespace, digest checks, transaction, durable outbox, pacing and ACK handling. Same ID/content/binding does not send again; conflicts and unknown outcomes must not be bypassed with a fresh ID. An unknown send blocks later output on that announcement binding. Names are independent queues, not a global cross-route or cross-process send lock. Approve the audience and public-content purpose before configuring a route; an admitted source device can submit arbitrary text to configured audiences. Deploy/start/completion policy belongs to the caller, not this generic bridge.

## Persistence and uncertainty

Both transports share the existing global deliveryId, immutable binding, canonical public text SHA-256, transaction and outbox. HTTP text is literal; a Slack submission compares after the existing Slack text decoding. Same ID/binding/text returns current state without adding another job. Any differing content/binding is rejected. Do not open a new ID to retry an unknown result. On restart, sending becomes unknown; unknown is not replayed and blocks later group jobs on that binding. Unknown network responses must be reconciled through status and existing controlled records, not blindly retried. `not_found` is only a local lookup result, not proof no external side effect ever happened.

The server bounds headers/requests/idle sockets to about five seconds, limits body size and concurrent sockets (32), closes responses, and closes listeners before bridge shutdown. These are basic resource limits, not protection against a hostile network or a global rate/identity guarantee. Once admitted, sending uses existing pacing, authorization, ACK and persistence logic.

## Offline checks and rollout

`node --test test/receipt-http.test.js test/announcements.test.js` uses temporary loopback listeners, new temporary SQLite stores, synthetic source messages and mock Slack/WeCom; it does not use production state, platforms or prior real test bindings. `npm run check` includes all regressions. Local success does not prove real network isolation, tenant send windows, restart behavior on the deployed service or audience delivery.

A later deployment must preserve the whole current private state consistently, keep this feature disabled first, and separately verify the approved network restriction before enabling. Roll back code/config only after stopping the single writer and preserving newly accepted jobs/status; never restore an old database over new receipts or reset unknown to pending. Do not use the new transport to bypass a rejected send/test or retry it through a different path. This change itself does not enable, deploy, modify networking, create credentials or send any real messages.
