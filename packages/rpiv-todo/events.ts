/**
 * Public event contract for @juicesharp/rpiv-todo.
 *
 * Follows the `rpiv:*` stability policy documented in
 * `packages/rpiv-ask-user-question/events.ts`: channel names never change,
 * payloads grow append-only with optional fields, listeners tolerate unknown
 * fields, and payloads stay JSON-safe (no callbacks, no class instances).
 */

/**
 * Mirror another extension's list into the todo overlay.
 *
 * The emitter owns a group of tasks identified by `owner` + `group`. Each sync
 * carries the full list for that group: missing tasks are created, changed ones
 * updated, and tasks the list no longer names are deleted. An empty `items`
 * deletes the whole group. Tasks without that owner/group, including every task
 * the model created through the `todo` tool, are never touched.
 *
 * The rpiv-todo instance that owns the target session (`sessionId`, or the
 * foreground session when omitted) answers with exactly one verdict on
 * `TODO_SYNC_RESULT_EVENT`, emitted synchronously inside the `emit` call. An
 * emitter that sees no verdict can treat rpiv-todo as absent for that session.
 */
export const TODO_SYNC_EVENT = "rpiv:todo:sync" as const;

export type TodoSyncItemStatus = "pending" | "in_progress" | "completed";

export interface TodoSyncItem {
	/** Stable key within the group, e.g. `"step:3"`. */
	key: string;
	subject: string;
	status: TodoSyncItemStatus;
}

export interface TodoSyncEventPayload {
	/** Echoed back on the verdict so the emitter can pair it with this request. */
	requestId: string;
	/** Who owns the group, e.g. `"plannotator"`. */
	owner: string;
	/** Which of the owner's lists this is, e.g. a plan file path. */
	group: string;
	/** Session to write, as `ctx.sessionManager.getSessionId()` reports it. Defaults to the foreground session. */
	sessionId?: string;
	/** The whole group. New tasks are appended in this order; existing ones keep their place. */
	items: ReadonlyArray<TodoSyncItem>;
}

/** Verdict for a `TODO_SYNC_EVENT`. One per request, accepted or not. */
export const TODO_SYNC_RESULT_EVENT = "rpiv:todo:sync-result" as const;

/**
 * Why a sync was refused — branch on this, not on `reason`:
 * - `invalid_payload`: a field is missing, has the wrong type, or an item key repeats.
 */
export type TodoSyncRejectCode = "invalid_payload";

export interface TodoSyncResultEventPayload {
	ok: boolean;
	/** Echoed from the request when it was a string. */
	requestId?: string;
	/** Set when `ok` is true: the session slot that was written. */
	sessionId?: string;
	/** Set when `ok` is true: the slot is the foreground one the overlay draws. */
	live?: boolean;
	/** Set when `ok` is false. */
	code?: TodoSyncRejectCode;
	/** Human-readable detail for logs. Wording may change — do not parse it. */
	reason?: string;
}
