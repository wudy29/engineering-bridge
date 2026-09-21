import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { CoreError, ERROR_CODES } from "./core/errors.js";

const MAX_BYTES = 16 * 1024;
const nullableString = z.string().nullable();
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const taskSchema = z.object({
  task_id: z.string(),
  state: z.enum(["queued", "running", "waiting_for_supervisor_review", "completed", "failed"]),
  executor: z.enum(["codex", "dsh"]),
  requested_model: nullableString,
  requested_reasoning_effort: nullableString,
  thread_id: z.string().optional(),
  created_at: timestamp,
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
  last_reported_activity_at: timestamp.optional(),
});
const envelopeSchema = z.object({
  schema_version: z.literal(1),
  kind: z.enum(["producer", "task"]),
  record_id: z.string().min(1),
  producer_id: z.string().min(1),
  observed_at: z.unknown().optional(),
  metadata: z.record(z.unknown()),
});
type Freshness = "fresh" | "stale" | "unknown";
export interface ProducerView {
  producer_id: string;
  observed_at: string | null;
  age_ms: number | null;
  freshness: Freshness;
  bridge_version?: string;
  pid?: number;
  started_at?: string;
}
export type TaskView = z.infer<typeof taskSchema> & {
  producer_id: string;
  error_code?: string;
  error_summary?: string;
};
export interface SnapshotView {
  availability: "available" | "unavailable";
  freshness?: "unknown";
  producers: ProducerView[];
  tasks: TaskView[];
}

export async function observationsDirectory(configPath: string): Promise<string> {
  return join(await fs.realpath(dirname(resolve(configPath))), basename(configPath) + ".observations");
}

const sameIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean =>
  a.dev === b.dev && a.ino === b.ino;

async function directoryStat(directory: string) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))) {
    throw new Error("Unsafe observation directory");
  }
  return stat;
}

export async function readSnapshots(configPath: string, now = Date.now()): Promise<SnapshotView> {
  try {
    const directory = await observationsDirectory(configPath);
    const identity = await directoryStat(directory);
    const producers: ProducerView[] = [];
    const tasks: TaskView[] = [];
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      try {
        const path = join(directory, entry.name);
        const stat = await fs.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
        const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let encoded: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || !sameIdentity(stat, opened) || opened.size > MAX_BYTES) continue;
          const buffer = Buffer.alloc(MAX_BYTES + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          if (length > MAX_BYTES) continue;
          encoded = buffer.toString("utf8", 0, length);
        } finally { await handle.close(); }
        const record = envelopeSchema.parse(JSON.parse(encoded));
        const filename = createHash("sha256")
          .update(JSON.stringify([record.kind, record.record_id])).digest("hex") + ".json";
        if (filename !== entry.name) continue;
        const metadata = record.metadata;
        if (record.kind === "producer") {
          if (record.record_id !== record.producer_id) continue;
          const observed = typeof record.observed_at === "string" ? record.observed_at : null;
          const age = observed === null ? NaN : now - Date.parse(observed);
          const known = Number.isFinite(age) && age >= 0;
          const producer: ProducerView = {
            producer_id: record.producer_id, observed_at: observed,
            age_ms: known ? age : null,
            freshness: !known ? "unknown" : age <= 15000 ? "fresh" : "stale",
          };
          if (typeof metadata.bridge_version === "string") producer.bridge_version = metadata.bridge_version;
          if (typeof metadata.pid === "number" && Number.isSafeInteger(metadata.pid) && metadata.pid > 0) {
            producer.pid = metadata.pid;
          }
          if (typeof metadata.started_at === "string") producer.started_at = metadata.started_at;
          producers.push(producer);
        } else {
          const parsed = taskSchema.parse(metadata);
          if (parsed.task_id !== record.record_id) continue;
          const task: TaskView = { ...parsed, producer_id: record.producer_id };
          const code = ERROR_CODES.find(value => value === metadata.error_code);
          if (code && metadata.error_summary === new CoreError(code).message) {
            task.error_code = code;
            task.error_summary = new CoreError(code).message;
          }
          tasks.push(task);
        }
      } catch { /* A malformed, replaced, or unreadable entry does not hide other records. */ }
    }
    if (!sameIdentity(identity, await directoryStat(directory))) throw new Error("Directory replaced");
    tasks.sort((a, b) =>
      Date.parse(b.last_reported_activity_at ?? b.created_at) - Date.parse(a.last_reported_activity_at ?? a.created_at) ||
      Date.parse(b.created_at) - Date.parse(a.created_at) ||
      (a.task_id < b.task_id ? 1 : a.task_id > b.task_id ? -1 : 0));
    producers.sort((a, b) => a.producer_id < b.producer_id ? -1 : a.producer_id > b.producer_id ? 1 : 0);
    return { availability: "available", producers, tasks };
  } catch {
    return { availability: "unavailable", freshness: "unknown", producers: [], tasks: [] };
  }
}

const HTML = [
  '<!doctype html><html lang="en"><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>Engineering Bridge Dashboard</title>',
  '<style>',
  'body{font:16px system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;background:#f6f7f8;color:#20252b}',
  'article{background:white;border:1px solid #ccd1d6;border-left:5px solid #78838e;padding:1rem;margin:1rem 0;overflow-wrap:anywhere}',
  'article[data-state="waiting_for_supervisor_review"]{border-left-color:#a65b00;background:#fff7e5}',
  'article[data-state="completed"]{border-left-color:#287544}',
  'h2{font-size:1.2rem}p{margin:.45rem 0}#errors{color:#9b2525}#producers{overflow-wrap:anywhere}',
  '</style><h1>Engineering Bridge Dashboard</h1>',
  '<p id="errors" role="status" aria-live="polite"></p>',
  '<section id="producers" aria-label="Producer heartbeat"></section>',
  '<main id="tasks" aria-label="Tasks"></main>',
  '<script>',
  'const producers = document.getElementById("producers");',
  'const tasks = document.getElementById("tasks");',
  'const errors = document.getElementById("errors");',
  'function add(parent, tag, value) {',
  '  const element = document.createElement(tag); element.textContent = value; parent.append(element); return element;',
  '}',
  'function field(parent, label, value) { add(parent, "p", label + ": " + (value ?? "not reported")); }',
  'function render(view) {',
  '  producers.replaceChildren(); tasks.replaceChildren();',
  '  errors.textContent = view.availability === "unavailable" ? "Read error: observations unavailable; freshness unknown." : "";',
  '  if (!view.producers.length) add(producers, "p", "Producer heartbeat: not reported; freshness unknown");',
  '  for (const producer of view.producers) {',
  '    const line = add(producers, "div", "");',
  '    field(line, "Producer", producer.producer_id); field(line, "Freshness", producer.freshness);',
  '    field(line, "Heartbeat", producer.observed_at); field(line, "Age (ms)", producer.age_ms);',
  '    field(line, "Bridge version", producer.bridge_version); field(line, "PID", producer.pid);',
  '    field(line, "Producer started", producer.started_at);',
  '  }',
  '  if (!view.tasks.length) add(tasks, "p", "No task snapshots reported.");',
  '  for (const task of view.tasks) {',
  '    const card = add(tasks, "article", ""); card.dataset.state = task.state;',
  '    add(card, "h2", task.state); field(card, "Task", task.task_id); field(card, "Producer", task.producer_id);',
  '    field(card, "Executor", task.executor); field(card, "Requested model", task.requested_model);',
  '    field(card, "Requested reasoning effort", task.requested_reasoning_effort);',
  '    if (task.thread_id !== undefined) field(card, "Thread", task.thread_id);',
  '    field(card, "Created", task.created_at); field(card, "Started", task.started_at);',
  '    field(card, "Ended", task.ended_at); field(card, "Last reported activity", task.last_reported_activity_at);',
  '    if (task.error_code) field(card, "Error", task.error_code + ": " + task.error_summary);',
  '  }',
  '}',
  'async function poll() {',
  '  try {',
  '    const response = await fetch("/api/snapshots", { cache: "no-store" });',
  '    if (!response.ok) throw new Error("Fetch failed");',
  '    render(await response.json());',
  '  } catch {',
  '    producers.replaceChildren(); tasks.replaceChildren();',
  '    errors.textContent = "Fetch error: snapshots unavailable; freshness unknown.";',
  '  } finally { setTimeout(poll, 2000); }',
  '}',
  'poll();',
  '</script></html>',
].join("\n");

export async function startDashboardServer(configPath: string, port = 4317): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { "Content-Type": type });
      response.end(body);
    };
    const address = server.address();
    const localPort = address && typeof address !== "string" ? address.port : port;
    const allowedHosts = ["127.0.0.1", "localhost"].flatMap(host => [host, host + ":" + localPort]);
    if (!allowedHosts.includes(request.headers.host ?? "")) {
      send(403, "text/plain; charset=utf-8", "Forbidden");
    } else if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      send(405, "text/plain; charset=utf-8", "Method not allowed");
    } else if (request.url === "/") {
      send(200, "text/html; charset=utf-8", HTML);
    } else if (request.url === "/api/snapshots") {
      void readSnapshots(configPath).then(
        view => send(200, "application/json; charset=utf-8", JSON.stringify(view)),
        () => send(500, "text/plain; charset=utf-8", "Snapshot read failed"),
      );
    } else {
      send(404, "text/plain; charset=utf-8", "Not found");
    }
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListening();
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !process.argv[2]) {
    console.error("Usage: npm run dashboard -- <config-path>");
    process.exitCode = 1;
  } else {
    void startDashboardServer(process.argv[2]).then(server => {
      const address = server.address();
      if (address && typeof address !== "string") {
        console.log(`Engineering Bridge Dashboard: http://127.0.0.1:${address.port}/`);
      }
    }).catch((error: unknown) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      console.error(code === "EADDRINUSE"
        ? "Dashboard could not start: 127.0.0.1:4317 is already in use. Stop the existing dashboard process before retrying."
        : "Dashboard could not start. Check that this process is permitted to listen on 127.0.0.1:4317, then retry.");
      process.exitCode = 1;
    });
  }
}
