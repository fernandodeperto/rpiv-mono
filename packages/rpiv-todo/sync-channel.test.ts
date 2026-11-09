import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeCustomEntry } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	TODO_SYNC_EVENT,
	TODO_SYNC_RESULT_EVENT,
	type TodoSyncEventPayload,
	type TodoSyncItem,
	type TodoSyncResultEventPayload,
} from "./events.ts";
import registerTodo from "./index.ts";
import { replayFromBranch } from "./state/replay.ts";
import { getState } from "./state/store.ts";
import { __resetState } from "./todo.ts";
import { STATE_ENTRY_TYPE, type TaskDetails } from "./tool/types.ts";

/**
 * The `rpiv:todo:sync` channel end to end, on Pi's real event bus
 * (`createEventBus`: listeners run synchronously inside `emit`), so a verdict
 * is in hand as soon as `emit` returns.
 */

const overlayUpdate = vi.fn();
const overlayModule = {
	TodoOverlay: class {
		setUICtx(): void {}
		resetCompletedDisplayState(): void {}
		update(): void {
			overlayUpdate();
		}
	},
} as unknown as typeof import("./todo-overlay.ts");

async function harness(opts: { sessionId?: string; hasUI?: boolean } = {}) {
	__resetState();
	overlayUpdate.mockClear();
	const bus = createEventBus();
	const verdicts: TodoSyncResultEventPayload[] = [];
	bus.on(TODO_SYNC_RESULT_EVENT, (data: unknown) => {
		verdicts.push(data as TodoSyncResultEventPayload);
	});
	const { pi, captured } = createMockPi({ events: bus } as never);
	registerTodo(pi, async () => overlayModule);
	const sessionId = opts.sessionId ?? "main";
	const ctx = createMockCtx({ sessionId, hasUI: opts.hasUI ?? true });
	const tool = captured.tools.get("todo")!;
	const start = captured.events.get("session_start")![0];
	await start({} as never, ctx as never);

	let n = 0;
	const sync = (items: TodoSyncItem[], extra: Partial<TodoSyncEventPayload> = {}) => {
		const requestId = `r${++n}`;
		bus.emit(TODO_SYNC_EVENT, { requestId, owner: "plannotator", group: "plan.md", items, ...extra });
		return verdicts.filter((v) => v.requestId === requestId);
	};
	const todo = (params: Record<string, unknown>) =>
		tool.execute?.("tc", params as never, undefined as never, undefined as never, ctx as never);
	const tasks = () => getState(sessionId).tasks;
	const live = () => tasks().filter((t) => t.status !== "deleted");
	return { bus, captured, ctx, sync, todo, tasks, live, verdicts, sessionId };
}

const step = (n: number, status: TodoSyncItem["status"] = "pending"): TodoSyncItem => ({
	key: `step:${n}`,
	subject: `Step ${n}`,
	status,
});

beforeEach(() => __resetState());

describe("rpiv:todo:sync", () => {
	it("creates the group's tasks with their statuses and owner metadata, and answers once", async () => {
		const h = await harness();
		const verdicts = h.sync([step(1, "completed"), step(2, "in_progress"), step(3)]);

		expect(verdicts).toEqual([{ ok: true, requestId: "r1", sessionId: "main", live: true }]);
		expect(h.live().map((t) => [t.subject, t.status])).toEqual([
			["Step 1", "completed"],
			["Step 2", "in_progress"],
			["Step 3", "pending"],
		]);
		expect(h.live()[0].metadata).toEqual({ owner: "plannotator", group: "plan.md", key: "step:1" });
	});

	it("updates a changed status in place and is a no-op when nothing changed", async () => {
		const h = await harness();
		h.sync([step(1, "in_progress"), step(2)]);
		const ids = h.live().map((t) => t.id);
		const entriesBefore = h.captured.entries.length;

		h.sync([step(1, "completed"), step(2, "in_progress")]);
		expect(h.live().map((t) => [t.id, t.status])).toEqual([
			[ids[0], "completed"],
			[ids[1], "in_progress"],
		]);

		const entriesAfterUpdate = h.captured.entries.length;
		expect(entriesAfterUpdate).toBe(entriesBefore + 1);
		expect(h.sync([step(1, "completed"), step(2, "in_progress")])).toHaveLength(1);
		expect(h.captured.entries.length).toBe(entriesAfterUpdate);
	});

	it("deletes tasks whose key the list no longer names", async () => {
		const h = await harness();
		h.sync([step(1), step(2), step(3)]);
		h.sync([step(1), step(3)]);
		expect(h.live().map((t) => t.subject)).toEqual(["Step 1", "Step 3"]);
		expect(h.tasks().find((t) => t.subject === "Step 2")?.status).toBe("deleted");
	});

	it("replaces a task when the lifecycle forbids the move (completed → pending)", async () => {
		const h = await harness();
		h.sync([step(1, "completed")]);
		const [first] = h.live();
		h.sync([step(1, "pending")]);
		const [second] = h.live();
		expect(second.status).toBe("pending");
		expect(second.id).not.toBe(first.id);
		expect(h.tasks().find((t) => t.id === first.id)?.status).toBe("deleted");
	});

	it("empty items deletes the whole group", async () => {
		const h = await harness();
		h.sync([step(1, "completed"), step(2)]);
		expect(h.sync([])).toEqual([{ ok: true, requestId: "r2", sessionId: "main", live: true }]);
		expect(h.live()).toEqual([]);
	});

	it("never touches the model's own tasks or another group's", async () => {
		const h = await harness();
		await h.todo({ action: "create", subject: "model task" });
		h.sync([step(1)], { group: "other.md" });
		h.sync([step(1)]);
		h.sync([]);
		expect(h.live().map((t) => [t.subject, t.metadata?.group])).toEqual([
			["model task", undefined],
			["Step 1", "other.md"],
		]);
	});

	it.each([
		["a non-object payload", "nope", undefined],
		["a missing requestId", { owner: "o", group: "g", items: [] }, undefined],
		["a blank owner", { requestId: "x", owner: " ", group: "g", items: [] }, "x"],
		["a non-array items", { requestId: "x", owner: "o", group: "g", items: {} }, "x"],
		["a bad status", { requestId: "x", owner: "o", group: "g", items: [{ ...step(1), status: "done" }] }, "x"],
		["a duplicated key", { requestId: "x", owner: "o", group: "g", items: [step(1), step(1)] }, "x"],
	])("refuses %s without changing anything", async (_label, payload, requestId) => {
		const h = await harness();
		h.bus.emit(TODO_SYNC_EVENT, payload);
		expect(h.verdicts).toHaveLength(1);
		expect(h.verdicts[0]).toMatchObject({ ok: false, code: "invalid_payload" });
		expect(h.verdicts[0].requestId).toBe(requestId);
		expect(h.tasks()).toEqual([]);
		expect(h.captured.entries).toEqual([]);
	});

	it("persists a snapshot that replays to the same state", async () => {
		const h = await harness();
		h.sync([step(1, "completed"), step(2, "in_progress")]);
		const branch = h.captured.entries.map((e) => makeCustomEntry(e.customType, e.data));
		expect(h.captured.entries.every((e) => e.customType === STATE_ENTRY_TYPE)).toBe(true);
		const replayed = replayFromBranch(createMockCtx({ branch }));
		const last = h.captured.entries.at(-1)?.data as TaskDetails;
		expect(replayed).toEqual({ tasks: h.tasks(), nextId: last.nextId });
	});

	it("reports live and redraws the overlay only for the foreground session", async () => {
		const fg = await harness({ hasUI: true });
		fg.sync([step(1)]);
		await vi.waitFor(() => expect(overlayUpdate).toHaveBeenCalled());

		const headless = await harness({ hasUI: false, sessionId: "child" });
		expect(headless.sync([step(1)], { sessionId: "child" })).toEqual([
			{ ok: true, requestId: "r1", sessionId: "child", live: false },
		]);
		await Promise.resolve();
		expect(overlayUpdate).not.toHaveBeenCalled();
	});

	it("stays silent for a session this instance does not own", async () => {
		const h = await harness();
		expect(h.sync([step(1)], { sessionId: "someone-else" })).toEqual([]);
		expect(h.verdicts).toEqual([]);
		expect(h.tasks()).toEqual([]);
	});
});
