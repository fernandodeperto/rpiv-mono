# Syncing tasks from another extension

[`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo)
accepts a task list from another Pi extension over `pi.events`, so a plan
runner or workflow engine can show its progress in the same overlay as the
model's own todos instead of drawing a second panel.

## The request

Emit `rpiv:todo:sync` with the whole list for one group:

```ts
import {
  TODO_SYNC_EVENT,
  TODO_SYNC_RESULT_EVENT,
  type TodoSyncEventPayload,
  type TodoSyncResultEventPayload,
} from "@juicesharp/rpiv-todo/events";

let verdict: TodoSyncResultEventPayload | undefined;
const off = pi.events.on(TODO_SYNC_RESULT_EVENT, (data) => {
  const result = data as TodoSyncResultEventPayload;
  if (result.requestId === "plan-1") verdict = result;
});
pi.events.emit(TODO_SYNC_EVENT, {
  requestId: "plan-1",
  owner: "my-extension",
  group: "plans/feature.md",
  sessionId: ctx.sessionManager.getSessionId(),
  items: [
    { key: "step:1", subject: "Add the parser", status: "completed" },
    { key: "step:2", subject: "Wire the command", status: "in_progress" },
    { key: "step:3", subject: "Write tests", status: "pending" },
  ],
} satisfies TodoSyncEventPayload);
off();
// verdict is set here: the bus runs listeners inside emit().
```

| Field | Meaning |
| --- | --- |
| `requestId` | Echoed on the verdict. Required. |
| `owner` | Who owns the group. Non-empty. |
| `group` | Which of the owner's lists this is. Non-empty. |
| `sessionId` | Session to write. Omit to target the foreground session. |
| `items[]` | The whole group in display order: `key` (unique, non-empty), `subject` (non-empty), `status` (`pending`, `in_progress` or `completed`). |

## What a sync does

The group is every non-deleted task whose `metadata` carries the same `owner`
and `group`. Each sync makes that group match `items`:

- A key with no task yet is created, with `metadata: { owner, group, key }`.
- A task whose subject or status differs is updated in place.
- A move the status machine forbids (`completed` back to `pending` or
  `in_progress`) deletes the old task and creates a new one.
- A task whose key is no longer listed is deleted. An empty `items` deletes the
  whole group.
- A sync that changes nothing writes nothing.

Tasks outside the group, including every task the model created with the
`todo` tool, are never read or changed. Changes go through the same reducer
the tool uses and are recorded as a `rpiv-todo-state` entry on the session
branch, so they survive `/reload`, compaction and resume like any other change.

## The verdict

The rpiv-todo instance that owns the target session answers once on
`rpiv:todo:sync-result`, synchronously inside `emit()`:

```ts
{ ok: true, requestId, sessionId, live }        // accepted
{ ok: false, requestId, code: "invalid_payload", reason }  // refused, nothing changed
```

`live` is `true` when the written session is the foreground one whose overlay
is on screen. An emitter can use it to hide its own progress display.

No verdict means no rpiv-todo instance owns that session: the package is not
installed, or the session has not started yet. Treat that as "absent" and fall
back to your own display.

Only the owning instance answers because `pi.appendEntry` writes to the session
an extension instance belongs to. A child session runs its own instance, so a
sync aimed at it is answered by that instance and persisted on its branch.

## Stability

The `rpiv:*` policy applies: channel names never change, payload fields are
only added and always optional, payloads stay JSON-safe, and a breaking change
ships as a new channel.
