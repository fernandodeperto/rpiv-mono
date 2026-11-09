import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	TODO_SYNC_EVENT,
	TODO_SYNC_RESULT_EVENT,
	type TodoSyncItem,
	type TodoSyncResultEventPayload,
} from "./events.ts";
import { isTransitionValid } from "./state/invariants.ts";
import type { TaskState } from "./state/state.ts";
import { applyTaskMutation, changesState } from "./state/state-reducer.ts";
import { commitState, getActiveRenderSession, getState } from "./state/store.ts";
import { STATE_ENTRY_TYPE, type TaskDetails, type TaskMutationParams } from "./tool/types.ts";

const ITEM_STATUSES: ReadonlySet<unknown> = new Set(["pending", "in_progress", "completed"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonBlank = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The metadata stamped on every task a sync owns; it is how later syncs find them. */
interface SyncMetadata {
	owner: string;
	group: string;
	key: string;
}

function ownedKey(task: TaskState["tasks"][number], owner: string, group: string): string | undefined {
	const m = task.metadata;
	if (task.status === "deleted" || !m || m.owner !== owner || m.group !== group) return undefined;
	return typeof m.key === "string" ? m.key : undefined;
}

/** Validate the request's items. Returns the reason for the first problem, or the items. */
function parseItems(value: unknown): TodoSyncItem[] | string {
	if (!Array.isArray(value)) return "items must be an array";
	const seen = new Set<string>();
	for (const [i, item] of value.entries()) {
		if (!isRecord(item)) return `items[${i}] must be an object`;
		if (!isNonBlank(item.key)) return `items[${i}].key must be a non-empty string`;
		if (seen.has(item.key)) return `items[${i}].key "${item.key}" is duplicated`;
		if (!isNonBlank(item.subject)) return `items[${i}].subject must be a non-empty string`;
		if (!ITEM_STATUSES.has(item.status)) return `items[${i}].status must be pending, in_progress or completed`;
		seen.add(item.key);
	}
	return value as TodoSyncItem[];
}

/**
 * Bring one owner's group in line with `items`, through the same reducer the
 * `todo` tool uses. Returns the new state and whether anything changed.
 */
export function reconcileGroup(
	start: TaskState,
	owner: string,
	group: string,
	items: readonly TodoSyncItem[],
): { state: TaskState; changed: boolean } {
	let state = start;
	let changed = false;
	const apply = (action: "create" | "update" | "delete", params: TaskMutationParams): number | undefined => {
		const result = applyTaskMutation(state, action, params);
		// Inputs are validated and ids come from the current state, so the reducer
		// cannot refuse here; a refusal would be a reducer bug worth surfacing.
		if (result.op.kind === "error") throw new Error(`rpiv-todo sync: ${result.op.message}`);
		state = result.state;
		changed ||= changesState(result.op);
		return result.op.kind === "create" ? result.op.taskIds[0] : undefined;
	};

	const wanted = new Map(items.map((item) => [item.key, item]));
	const existing = new Map<string, number>();
	for (const task of start.tasks) {
		const key = ownedKey(task, owner, group);
		if (key === undefined) continue;
		// A key no longer listed, or a duplicate of one already kept, goes.
		if (!wanted.has(key) || existing.has(key)) apply("delete", { id: task.id });
		else existing.set(key, task.id);
	}

	for (const item of items) {
		const id = existing.get(item.key);
		const current = id === undefined ? undefined : state.tasks.find((t) => t.id === id);
		if (current && current.subject === item.subject && current.status === item.status) continue;
		if (current && isTransitionValid(current.status, item.status)) {
			apply("update", { id: current.id, subject: item.subject, status: item.status });
			continue;
		}
		// New, or a move the task lifecycle forbids (completed → pending): replace it.
		if (current) apply("delete", { id: current.id });
		const metadata: SyncMetadata = { owner, group, key: item.key };
		const created = apply("create", { subject: item.subject, metadata: { ...metadata } });
		if (item.status !== "pending") apply("update", { id: created, status: item.status });
	}

	return { state, changed };
}

export interface SyncChannelDeps {
	/** The session this extension instance runs in, once `session_start` has fired. */
	ownSession(): string | undefined;
	/** Redraw the overlay after a foreground write. */
	refresh(): void;
}

/**
 * Listen for `rpiv:todo:sync` and answer on `rpiv:todo:sync-result`.
 *
 * Only the instance that owns the target session answers: the request's
 * `sessionId`, or the foreground session when it names none. That keeps the
 * persisted entry on the right branch, since `pi.appendEntry` writes to the
 * session this instance belongs to.
 */
export function registerSyncChannel(pi: ExtensionAPI, deps: SyncChannelDeps): void {
	pi.events.on(TODO_SYNC_EVENT, (data: unknown) => {
		const payload = isRecord(data) ? data : {};
		const own = deps.ownSession();
		if (own === undefined) return;
		const target = typeof payload.sessionId === "string" ? payload.sessionId : getActiveRenderSession();
		if (target !== own) return;

		const requestId = typeof payload.requestId === "string" ? payload.requestId : undefined;
		const reply = (verdict: Omit<TodoSyncResultEventPayload, "requestId">) => {
			pi.events.emit(TODO_SYNC_RESULT_EVENT, {
				...verdict,
				...(requestId !== undefined ? { requestId } : {}),
			} satisfies TodoSyncResultEventPayload);
		};
		const reject = (reason: string) => reply({ ok: false, code: "invalid_payload", reason });

		if (!isRecord(data)) return reject("payload must be an object");
		if (requestId === undefined) return reject("requestId must be a string");
		if (!isNonBlank(payload.owner)) return reject("owner must be a non-empty string");
		if (!isNonBlank(payload.group)) return reject("group must be a non-empty string");
		const items = parseItems(payload.items);
		if (typeof items === "string") return reject(items);

		const { owner, group } = payload;
		const { state, changed } = reconcileGroup(getState(target), owner, group, items);
		const live = target === getActiveRenderSession();
		if (changed) {
			commitState(target, state);
			const details: TaskDetails = {
				action: "update",
				params: { source: TODO_SYNC_EVENT, owner, group },
				tasks: state.tasks,
				nextId: state.nextId,
			};
			pi.appendEntry(STATE_ENTRY_TYPE, details);
		}
		reply({ ok: true, sessionId: target, live });
		if (changed && live) deps.refresh();
	});
}
