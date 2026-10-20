import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Execute the HTML and browser script emitted by the build, without starting a server.
const source = readFileSync(new URL("../../src/dashboard.js", import.meta.url), "utf8");
const expression = source.match(/const HTML = ([\s\S]*?\.join\([^\n]*?\));/)?.[1];
assert.ok(expression);
const html: string = runInNewContext(expression);
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);
const now = Date.parse("2026-10-13T08:00:00.000Z");
const earlier = "2026-10-13T07:00:00.000Z";
const key = "engineering-bridge.dashboard.history.v1";
type RecordView = Record<string, unknown>;
const task = (task_id: string, state: string, producer_id = "online", extra: RecordView = {}) => ({
  task_id, state, producer_id, executor: "codex", workspace_id: "project", workspace_display_name: "测试项目",
  requested_model: null, requested_reasoning_effort: null,
  created_at: earlier, started_at: earlier, ended_at: state === "completed" || state === "failed" ? earlier : null,
  observed_at: earlier, ...extra,
});
const view = (tasks: RecordView[]) => ({
  availability: "available", tasks,
  producers: [{ producer_id: "online", freshness: "fresh", age_ms: 0 },
    { producer_id: "offline", freshness: "stale", age_ms: 60000 },
    { producer_id: "unknown", freshness: "unknown", age_ms: null }],
});

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  hidden = false;
  open = false;
  disabled = false;
  events = new Map<string, () => void>();
  constructor(readonly tag: string, readonly document: { activeElement: Element | null }) {}
  append(node: Element) { this.insertBefore(node, null); }
  insertBefore(node: Element, next: Element | null) {
    node.remove(); node.parent = this;
    this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node);
  }
  remove() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(node: Element | null): boolean { return node === this || this.children.some(child => child.contains(node)); }
  get isConnected(): boolean { return this.parent !== null; }
  focus() { this.document.activeElement = this; }
  addEventListener(name: string, callback: () => void) { this.events.set(name, callback); }
  querySelector(selector: string): Element | null {
    const field = selector.match(/data-field="([^"]+)"/)?.[1];
    for (const child of this.children) {
      if (field && child.dataset.field === field) return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
}

async function browser(initial: RecordView, storage = new Map<string, string>(), blocked: string[] = []) {
  const elements = new Map<string, Element>();
  const document = {
    activeElement: null as Element | null,
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string): Element => new Element(tag, document),
  };
  const root = new Element("body", document);
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"([^>]*)>/g)) {
    const element = new Element(match[1]!, document);
    element.hidden = /\bhidden\b/.test(match[3]!); element.open = /\bopen\b/.test(match[3]!);
    elements.set(match[2]!, element); root.append(element);
  }
  const get = (id: string) => { const node = elements.get(id); assert.ok(node, id); return node; };
  for (const [container, list] of [["past-records", "past-tasks"], ["review-records", "review-tasks"], ["ended-records", "ended-tasks"]]) {
    if (elements.has(container!)) { get("task-section").append(get(container!)); get(container!).append(get(list!)); }
  }
  get("task-section").append(get("tasks"));
  let current = initial;
  let clock = now;
  let failure = false;
  const timers: Array<() => Promise<void>> = [];
  const requests: unknown[] = [];
  runInNewContext(script!, {
    document,
    Date: class extends Date { static override now() { return clock; } },
    localStorage: {
      getItem(name: string) { if (blocked.includes("get")) throw Error("denied"); return storage.get(name) ?? null; },
      setItem(name: string, value: string) { if (blocked.includes("set")) throw Error("quota"); storage.set(name, value); },
      removeItem(name: string) { if (blocked.includes("remove")) throw Error("denied"); storage.delete(name); },
    },
    fetch: async (url: string, options: unknown) => {
      requests.push([url, options]); if (failure) throw Error("offline");
      return { ok: true, json: async () => structuredClone(current) };
    },
    setTimeout(callback: () => Promise<void>, delay: number) { assert.equal(delay, 2000); timers.push(callback); },
  });
  await setImmediate();
  return {
    get, document, storage, requests,
    ids: (id: string) => get(id).children.map(card => card.querySelector('[data-field="task_id"]')!.textContent),
    click(id: string) { const button = get(id); assert.equal(button.disabled, false, id); button.events.get("click")!(); },
    async poll(next = current, fail = false) {
      current = next; failure = fail;
      const callback = timers.shift(); assert.ok(callback, "polling continues"); await callback();
    },
    setClock(value: number) { clock = value; },
  };
}

test("only fresh queued/running tasks are current; review, ended and old-process observations have exclusive collapsed sections", async () => {
  const records = [task("queued", "queued"), task("running", "running"), task("review", "waiting_for_supervisor_review"),
    task("done", "completed"), task("failed", "failed"), task("old-run", "running", "offline"),
    task("old-review", "waiting_for_supervisor_review", "offline"), task("missing", "queued", "missing"),
    task("unknown", "running", "unknown")];
  const original = JSON.stringify(records);
  const ui = await browser(view(records));
  assert.deepEqual(ui.ids("tasks"), ["queued", "running"]);
  assert.deepEqual(ui.ids("review-tasks"), ["review"]);
  assert.deepEqual(ui.ids("ended-tasks"), ["done", "failed"]);
  assert.deepEqual(ui.ids("past-tasks"), ["old-run", "old-review", "missing", "unknown"]);
  for (const id of ["review-records", "ended-records", "past-records"]) assert.equal(ui.get(id).open, false);
  assert.equal(JSON.stringify(records), original);
});

test("missing titles show project, executor and short ID; explicit titles remain literal text", async () => {
  const ui = await browser(view([task("12345678-abcdef", "running", "online", { executor: "dsh" }),
    task("abcdef12-rest", "queued", "online", { workspace_display_name: undefined, workspace_id: "legacy" }),
    task("named", "queued", "online", { dashboard_title: '<img src=x onerror="alert(1)">' })]));
  const titles = ui.get("tasks").children.map(card => card.querySelector('[data-field="title"]')!.textContent);
  assert.deepEqual(titles, ["测试项目 · DSH · 12345678", "legacy · Codex · abcdef12", '<img src=x onerror="alert(1)">']);
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test("clear hides old review and ended cards across polls and reload, preserves active tasks and producers, and restore reverses it", async () => {
  const input = view([task("active", "running"), task("queued", "queued"), task("review", "waiting_for_supervisor_review"),
    task("old-review", "waiting_for_supervisor_review", "offline"), task("done", "completed"),
    task("old-failed", "failed", "offline"), task("old-run", "running", "offline")]);
  const original = JSON.stringify(input);
  const storage = new Map<string, string>();
  const ui = await browser(input, storage);
  ui.click("clear-history");
  assert.deepEqual(ui.ids("tasks"), ["active", "queued"]);
  assert.deepEqual(ui.ids("review-tasks"), []); assert.deepEqual(ui.ids("ended-tasks"), []);
  assert.deepEqual(ui.ids("past-tasks"), ["old-run"]);
  assert.equal(ui.get("producers").children.length, 3);
  assert.match(ui.get("history-note").textContent, /4/);
  assert.equal(storage.size, 1); assert.ok(storage.get(key)!.length < 256);
  await ui.poll(); assert.deepEqual(ui.ids("review-tasks"), []);
  const reload = await browser(input, storage);
  assert.deepEqual(reload.ids("ended-tasks"), []);
  reload.click("restore-history");
  assert.deepEqual(reload.ids("review-tasks"), ["review"]);
  assert.deepEqual(reload.ids("ended-tasks"), ["done"]);
  assert.equal(storage.has(key), false);
  assert.equal(JSON.stringify(input), original);
  assert.ok(ui.requests.every(request => JSON.stringify(request) === '["/api/snapshots",{"cache":"no-store"}]'));
});

test("newly reviewed/completed and resumed tasks remain visible after clearing, regardless of creation time", async () => {
  const ui = await browser(view([task("review", "waiting_for_supervisor_review")]));
  ui.click("clear-history"); ui.setClock(now + 10000);
  const later = new Date(now + 5000).toISOString();
  await ui.poll(view([task("review", "running"), task("new-review", "waiting_for_supervisor_review", "online", { observed_at: later }),
    task("new-done", "completed", "online", { ended_at: later }), task("new-failure", "failed", "offline", { ended_at: later })]));
  assert.deepEqual(ui.ids("tasks"), ["review"]);
  assert.deepEqual(ui.ids("review-tasks"), ["new-review"]);
  assert.deepEqual(ui.ids("ended-tasks"), ["new-done"]);
  assert.deepEqual(ui.ids("past-tasks"), ["new-failure"]);
});

test("missing, invalid, noncanonical and future timestamps are never silently hidden", async () => {
  const invalid = [undefined, null, "bad", "2026-10-13", "2026-10-13T08:00:00+00:00", new Date(now + 10000).toISOString()];
  const records = invalid.flatMap((value, index) => [task("review-" + index, "waiting_for_supervisor_review", "online", { observed_at: value }),
    task("ended-" + index, "completed", "online", { ended_at: value })]);
  const ui = await browser(view(records)); ui.click("clear-history");
  assert.equal(ui.ids("review-tasks").length, 6); assert.equal(ui.ids("ended-tasks").length, 6);
});

test("malformed, oversized and future local markers fail open; clock rollback cannot hide tasks", async () => {
  for (const marker of ["{", "null", "x".repeat(300), JSON.stringify({ version: 2, cleared_through: earlier }),
    JSON.stringify({ version: 1, cleared_through: "2026-10-13" }),
    JSON.stringify({ version: 1, cleared_through: new Date(now + 1).toISOString() })]) {
    const ui = await browser(view([task("done", "completed")]), new Map([[key, marker]]));
    assert.deepEqual(ui.ids("ended-tasks"), ["done"]);
    ui.click("clear-history");
    assert.deepEqual(ui.ids("ended-tasks"), []);
    assert.doesNotMatch(ui.get("history-note").textContent, /本页/, "malformed settings do not imply unavailable storage");
  }
  const ui = await browser(view([task("done", "completed")])); ui.click("clear-history");
  ui.setClock(now - 1); await ui.poll();
  assert.deepEqual(ui.ids("ended-tasks"), ["done"]);
});

test("storage failures keep clear/restore usable in this page and explain persistence limits", async () => {
  const input = view([task("review", "waiting_for_supervisor_review"), task("done", "completed")]);
  for (const blocked of [["get"], ["set"], ["remove"], ["get", "set", "remove"]]) {
    const ui = await browser(input, new Map(), blocked);
    ui.click("clear-history"); assert.deepEqual(ui.ids("review-tasks"), []);
    ui.click("restore-history"); assert.deepEqual(ui.ids("review-tasks"), ["review"]);
    assert.deepEqual(ui.ids("ended-tasks"), ["done"]);
    assert.match(ui.get("history-note").textContent, /本页/);
    await ui.poll(); assert.deepEqual(ui.ids("review-tasks"), ["review"]);
  }
});

test("unavailable snapshots and fetch failures recover through polling without losing the display marker", async () => {
  const input = view([task("done", "completed"), task("active", "running")]);
  const ui = await browser(input); ui.click("clear-history");
  await ui.poll({ availability: "unavailable", producers: [], tasks: [] });
  assert.equal(ui.get("errors").hidden, false); assert.equal(ui.get("clear-history").disabled, true);
  await ui.poll(input, true); assert.equal(ui.get("errors").hidden, false);
  await ui.poll(input); assert.equal(ui.get("errors").hidden, true);
  assert.deepEqual(ui.ids("tasks"), ["active"]); assert.deepEqual(ui.ids("ended-tasks"), []);
});

test("polling preserves disclosure nodes and focus as a task moves from current to review or old-process history", async () => {
  const input = view([task("active", "running")]);
  const ui = await browser(input);
  const card = ui.get("tasks").children[0]!;
  const title = card.querySelector('[data-field="title"]')!; title.focus();
  const details = card.children.find(child => child.className === "card-footer")!.children.find(child => child.tag === "details")!;
  details.open = true;
  await ui.poll(view([task("active", "waiting_for_supervisor_review")]));
  assert.equal(ui.get("review-tasks").children[0], card); assert.equal(details.open, true);
  assert.equal(ui.get("review-records").open, true); assert.equal(ui.document.activeElement, title);
  await ui.poll({ ...input, producers: [] });
  assert.equal(ui.get("past-tasks").children[0], card);
  assert.equal(ui.get("past-records").open, true); assert.equal(ui.document.activeElement, title);
});
