import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { CoreError, ERROR_CODES } from "./core/errors.js";
import { dashboardLabelSchema } from "./core/dashboard-label.js";

const MAX_BYTES = 16 * 1024;
const nullableString = z.string().nullable();
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)));
const taskSchema = z.object({
  task_id: z.string(),
  workspace_id: z.string().min(1).optional().catch(undefined),
  workspace_display_name: dashboardLabelSchema.optional().catch(undefined),
  dashboard_title: dashboardLabelSchema.optional().catch(undefined),
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
  observed_at?: string;
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
          const observed = timestamp.safeParse(record.observed_at);
          if (observed.success) task.observed_at = observed.data;
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
  "<!doctype html>",
  "<html lang=\"zh-CN\">",
  "<head>",
  "<meta charset=\"utf-8\">",
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
  "<title>Engineering Bridge</title>",
  "<style>",
  ":root{font:14px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#292b30;background:#f5f5f7;color-scheme:light}",
  "*{box-sizing:border-box}body{margin:0}[hidden]{display:none!important}",
  ".shell{max-width:1064px;margin:0 auto;padding:56px 32px 64px}",
  ".masthead{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:24px}",
  ".eyebrow{margin:0 0 6px;color:#737780;font-size:12px;letter-spacing:.08em;overflow-wrap:anywhere}",
  "h1{margin:0;font-size:30px;line-height:1.25;font-weight:650;letter-spacing:-1px}",
  ".readonly{flex-shrink:0;color:#737780;font-size:12px;border:1px solid #dedfe3;border-radius:20px;padding:4px 10px}",
  ".producer{padding:16px 20px;background:#ffffffb3;border:1px solid #e2e3e7;border-radius:14px;margin-top:10px}",
  ".producer-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px 18px}",
  ".status{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--tone,#6d727c)}",
  ".status::before{content:\"\";width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}",
  ".producer .status{font-size:13px}.heartbeat,.version{font-size:12px;color:#737780;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}",
  ".producer[data-freshness=\"fresh\"]{--tone:#347651}.producer[data-freshness=\"stale\"]{--tone:#986b24}",
  ".producer .details{margin-left:auto}.producer .details[open]{flex-basis:100%;margin-left:0}",
  ".section-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:34px 0 14px}",
  "h2{font-size:16px;font-weight:600;margin:0}.count{margin-left:8px;color:#858a93;font-size:12px;font-weight:400}",
  ".refresh-note{margin:0;font-size:12px;color:#737780}",
  "#tasks,#review-tasks,#ended-tasks,#past-tasks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start}",
  ".record-group{margin-top:28px}.record-group>summary{font-size:13px}.record-group>p{color:#737780;font-size:12px;margin:12px 0 16px}",
  ".task-card{min-width:0;padding:24px;border:1px solid #e1e3e7;border-radius:18px;background:#fff;box-shadow:0 2px 6px #20253004}",
  ".task-card .status{padding:4px 9px;border-radius:7px;background:var(--tint,#f1f2f4)}",
  ".task-card[data-state=\"running\"]{--tone:#416c9e;--tint:#edf3fa}",
  ".task-card[data-state=\"waiting_for_supervisor_review\"]{--tone:#94651f;--tint:#fbf4e7;border-color:#e8ddc8}",
  ".task-card[data-state=\"completed\"]{--tone:#347651;--tint:#eef6f0}",
  ".task-card[data-state=\"failed\"]{--tone:#ae514d;--tint:#fbefee}",
  ".model{margin:20px 0 16px;font-size:18px;font-weight:600;line-height:1.4;letter-spacing:-.3px;overflow-wrap:anywhere}",
  ".duration{margin:0 0 6px;font-size:23px;font-weight:500;letter-spacing:-.5px;font-variant-numeric:tabular-nums}",
  ".activity,.ended{margin:3px 0;color:#737780;font-size:12px;font-variant-numeric:tabular-nums}",
  ".card-footer{margin-top:24px;padding-top:14px;border-top:1px solid #f0f0f2}",
  ".thread{margin:0 0 8px;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#737780}",
  "summary{width:fit-content;color:#737780;cursor:pointer;font-size:12px;line-height:24px;border-radius:4px}",
  "summary:hover{color:#292b30}summary:focus-visible{outline:2px solid #416c9e;outline-offset:4px}",
  ".details[open]>summary{margin-bottom:12px}.details dl{display:grid;grid-template-columns:112px minmax(0,1fr);gap:8px 12px;margin:0;padding:14px 0 2px;border-top:1px solid #ededf0;font-size:11px}",
  "dt{color:#737780}dd{margin:0;color:#535863;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}",
  ".safe-error{margin:12px 0 0;font-size:11px;color:#737780;overflow-wrap:anywhere}",
  ".notice{padding:48px 24px;text-align:center;border:1px solid #e2e3e7;border-radius:18px;background:#ffffffb3}",
  ".notice h2{font-size:16px;font-weight:500}.notice p{margin:10px 0 0;color:#737780;font-size:13px}",
  "#errors{margin-top:32px}",
  ".history-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:24px}.history-controls button{font:inherit;font-size:12px;padding:6px 12px;border:1px solid #dedfe3;border-radius:8px;background:#fff;color:#535863;cursor:pointer}.history-controls button:disabled{opacity:.5;cursor:default}.history-controls button:focus-visible{outline:2px solid #416c9e;outline-offset:3px}.history-controls p{flex-basis:100%;margin:4px 0 0;color:#737780;font-size:12px}",
  "@media(max-width:640px){.shell{padding:28px 20px 40px}h1{font-size:25px}.masthead{align-items:flex-start}.readonly{font-size:11px;padding:3px 8px}#tasks,#review-tasks,#ended-tasks,#past-tasks{grid-template-columns:1fr}.task-card{padding:22px}.producer{padding:14px 16px}.section-heading{margin-top:28px}}",
  "@media(max-width:380px){.shell{padding-left:16px;padding-right:16px}.masthead{flex-wrap:wrap}.details dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:8px}}",
  "</style>",
  "</head>",
  "<body>",
  "<main class=\"shell\">",
  "  <header>",
  "    <div class=\"masthead\"><div><p class=\"eyebrow\">本地工作台</p><h1>Engineering Bridge</h1></div><span class=\"readonly\">仅供查看</span></div>",
  "    <section id=\"producers\" aria-label=\"Bridge 状态\"></section>",
  "    <div id=\"producer-empty\" class=\"producer\"><span class=\"status\">Bridge 状态未知</span></div>",
  "  </header>",
  "  <section id=\"errors\" class=\"notice\" role=\"status\" aria-live=\"polite\" hidden><h2>暂时无法读取 Bridge 状态</h2><p>请确认 Engineering Bridge 正在运行。</p></section>",
  "  <div class=\"history-controls\"><button id=\"clear-history\" type=\"button\" disabled>清理历史显示</button><button id=\"restore-history\" type=\"button\">恢复显示</button><p id=\"history-note\" role=\"status\" aria-live=\"polite\"></p></div>",
  "  <section id=\"task-section\" aria-labelledby=\"task-heading\">",
  "    <div class=\"section-heading\"><h2 id=\"task-heading\">当前任务<span id=\"count\" class=\"count\"></span></h2><p class=\"refresh-note\">每 2 秒自动更新</p></div>",
  "    <div id=\"tasks\"></div>",
  "    <div id=\"empty\" class=\"notice\" hidden><h2>暂无当前任务</h2><p id=\"empty-copy\"></p></div>",
  "    <details id=\"review-records\" class=\"record-group\" hidden><summary>在线任务 · 等待调用方验收<span id=\"review-count\" class=\"count\"></span></summary><p>结果已返回，等待原调用方验收；此看板仅供查看。</p><div id=\"review-tasks\"></div></details>",
  "    <details id=\"ended-records\" class=\"record-group\" hidden><summary>已结束任务<span id=\"ended-count\" class=\"count\"></span></summary><div id=\"ended-tasks\"></div></details>",
  "    <details id=\"past-records\" class=\"record-group\" hidden><summary>旧进程历史观测<span id=\"past-count\" class=\"count\"></span></summary><p>所属 Bridge 没有近期有效心跳。以下仅是最后上报的历史观测，无法确认当前任务状态；原记录仍保留。</p><div id=\"past-tasks\"></div></details>",
  "  </section>",
  "</main>",
  "<script>",
  "const producers = document.getElementById(\"producers\");",
  "const tasks = document.getElementById(\"tasks\");",
  "const pastTasks = document.getElementById(\"past-tasks\");",
  "const reviewTasks = document.getElementById(\"review-tasks\");",
  "const endedTasks = document.getElementById(\"ended-tasks\");",
  "const errors = document.getElementById(\"errors\");",
  "const producerNodes = new Map();",
  "const taskNodes = new Map();",
  "const stateLabels = new Map([[\"queued\", \"等待执行\"], [\"running\", \"执行中\"], [\"waiting_for_supervisor_review\", \"等待调用方验收\"], [\"completed\", \"已完成\"], [\"failed\", \"失败\"]]);",
  "const freshnessLabels = new Map([[\"fresh\", \"Bridge 在线\"], [\"stale\", \"心跳延迟\"], [\"unknown\", \"状态未知\"]]);",
  "const modelLabels = new Map([[\"gpt-6-astra\", \"Astra\"]]);",
  "const effortLabels = new Map([[\"low\", \"低\"], [\"medium\", \"中等\"], [\"high\", \"高\"], [\"max\", \"最高\"]]);",
  "function add(parent, tag, value = \"\", className = \"\") {",
  "  const element = document.createElement(tag); element.textContent = value; element.className = className; parent.append(element); return element;",
  "}",
  "function slot(parent, tag, name, className = \"\") {",
  "  const element = add(parent, tag, \"\", className); element.dataset.field = name; return element;",
  "}",
  "function text(parent, name, value) {",
  "  const element = parent.querySelector('[data-field=\"' + name + '\"]');",
  "  const next = String(value ?? \"未记录\");",
  "  if (element.textContent !== next) element.textContent = next;",
  "  return element;",
  "}",
  "function details(parent, fields) {",
  "  const disclosure = add(parent, \"details\", \"\", \"details\"); add(disclosure, \"summary\", \"技术详情\");",
  "  const list = add(disclosure, \"dl\");",
  "  for (const [name, label] of fields) { add(list, \"dt\", label); slot(list, \"dd\", name); }",
  "  return disclosure;",
  "}",
  "function relativeAge(age) {",
  "  if (typeof age !== \"number\" || !Number.isFinite(age) || age < 0) return \"暂无记录\";",
  "  if (age < 5000) return \"刚刚\";",
  "  if (age < 60000) return Math.floor(age / 1000) + \" 秒前\";",
  "  if (age < 3600000) return Math.floor(age / 60000) + \" 分钟前\";",
  "  if (age < 86400000) return Math.floor(age / 3600000) + \" 小时前\";",
  "  return Math.floor(age / 86400000) + \" 天前\";",
  "}",
  "function relativeTime(value, now) { return relativeAge(now - Date.parse(value)); }",
  "function durationText(task, now, connected = true) {",
  "  const finished = task.state === \"completed\" || task.state === \"failed\";",
  "  if (!connected && !finished) return \"历史观测，当前状态不可确认\";",
  "  if (task.state === \"waiting_for_supervisor_review\") return \"结果已返回，待调用方验收\";",
  "  const queued = task.state === \"queued\";",
  "  const elapsed = (finished ? Date.parse(task.ended_at) : now) - Date.parse(queued ? task.created_at : task.started_at);",
  "  if (!Number.isFinite(elapsed) || elapsed < 0) return finished ? \"耗时未记录\" : \"等待开始\";",
  "  const seconds = Math.floor(elapsed / 1000);",
  "  const duration = seconds < 60 ? seconds + \" 秒\" : seconds < 3600",
  "    ? Math.floor(seconds / 60) + \" 分 \" + String(seconds % 60).padStart(2, \"0\") + \" 秒\"",
  "    : Math.floor(seconds / 3600) + \" 小时 \" + String(Math.floor(seconds / 60) % 60).padStart(2, \"0\") + \" 分\";",
  "  return (finished ? \"耗时 \" : queued ? \"已等待 \" : \"已运行 \") + duration;",
  "}",
  "function activityText(task, now) {",
  "  return task.last_reported_activity_at ? \"最近活动：\" + relativeTime(task.last_reported_activity_at, now) : \"最后上报：\" + relativeTime(task.observed_at, now);",
  "}",
  "function partitionTasks(view) {",
  "  const connected = new Set(view.producers.filter(value => value.freshness === \"fresh\").map(value => value.producer_id));",
  "  const current = [], review = [], ended = [], past = [];",
  "  for (const task of view.tasks) {",
  "    if (!connected.has(task.producer_id)) past.push(task);",
  "    else if (task.state === \"queued\" || task.state === \"running\") current.push(task);",
  "    else if (task.state === \"waiting_for_supervisor_review\") review.push(task);",
  "    else ended.push(task);",
  "  }",
  "  return { connected, current, review, ended, past };",
  "}",
  "const historyKey = \"engineering-bridge.dashboard.history.v1\";",
  "const clearHistory = document.getElementById(\"clear-history\");",
  "const restoreHistory = document.getElementById(\"restore-history\");",
  "const historyNote = document.getElementById(\"history-note\");",
  "let storageAvailable = true;",
  "let latestView = null;",
  "let historyCutoff = readHistory();",
  "function canonicalTime(value) {",
  "  if (typeof value !== \"string\") return null;",
  "  const time = Date.parse(value);",
  "  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;",
  "}",
  "function readHistory() {",
  "  let encoded;",
  "  try { encoded = localStorage.getItem(historyKey); }",
  "  catch { storageAvailable = false; return null; }",
  "  if (!encoded || encoded.length > 256) return null;",
  "  try {",
  "    const marker = JSON.parse(encoded);",
  "    const time = marker && marker.version === 1 ? canonicalTime(marker.cleared_through) : null;",
  "    return time !== null && time <= Date.now() ? time : null;",
  "  } catch { return null; }",
  "}",
  "function hiddenByHistory(task) {",
  "  if (historyCutoff === null) return false;",
  "  const time = task.state === \"completed\" || task.state === \"failed\" ? canonicalTime(task.ended_at)",
  "    : task.state === \"waiting_for_supervisor_review\" ? canonicalTime(task.observed_at) : null;",
  "  return time !== null && time <= historyCutoff;",
  "}",
  "clearHistory.addEventListener(\"click\", () => {",
  "  if (!latestView || latestView.availability !== \"available\") return;",
  "  historyCutoff = Date.now();",
  "  try { localStorage.setItem(historyKey, JSON.stringify({ version: 1, cleared_through: new Date(historyCutoff).toISOString() })); }",
  "  catch { storageAvailable = false; }",
  "  render(latestView);",
  "});",
  "restoreHistory.addEventListener(\"click\", () => {",
  "  historyCutoff = null;",
  "  try { localStorage.removeItem(historyKey); } catch { storageAvailable = false; }",
  "  if (latestView) render(latestView);",
  "});",
  "function modelText(task) {",
  "  const model = modelLabels.get(task.requested_model) ?? task.requested_model ?? \"未指定模型\";",
  "  const effort = task.requested_reasoning_effort == null ? \"未指定思考强度\" : (effortLabels.get(task.requested_reasoning_effort) ?? task.requested_reasoning_effort) + \"思考\";",
  "  return model + \" · \" + effort;",
  "}",
  "function createProducer() {",
  "  const card = document.createElement(\"article\"); card.className = \"producer\";",
  "  const line = add(card, \"div\", \"\", \"producer-line\");",
  "  slot(line, \"span\", \"status\", \"status\"); slot(line, \"span\", \"heartbeat\", \"heartbeat\"); slot(line, \"span\", \"version\", \"version\");",
  "  details(line, [[\"producer_id\", \"Producer ID\"], [\"pid\", \"进程 PID\"], [\"started_at\", \"启动时间\"], [\"observed_at\", \"心跳时间\"]]);",
  "  return card;",
  "}",
  "function updateProducer(card, producer) {",
  "  card.dataset.freshness = producer.freshness;",
  "  text(card, \"status\", freshnessLabels.get(producer.freshness) ?? \"状态未知\");",
  "  text(card, \"heartbeat\", \"心跳 \" + relativeAge(producer.age_ms));",
  "  text(card, \"version\", producer.bridge_version ? \"v\" + producer.bridge_version : \"\");",
  "  for (const name of [\"producer_id\", \"pid\", \"started_at\", \"observed_at\"]) text(card, name, producer[name]);",
  "}",
  "function createTask() {",
  "  const card = document.createElement(\"article\"); card.className = \"task-card\";",
  "  slot(card, \"p\", \"workspace\", \"eyebrow\"); slot(card, \"h3\", \"title\", \"model\");",
  "  slot(card, \"span\", \"status\", \"status\"); slot(card, \"p\", \"model\", \"activity\");",
  "  slot(card, \"p\", \"duration\", \"duration\"); slot(card, \"p\", \"activity\", \"activity\"); slot(card, \"p\", \"ended\", \"ended\");",
  "  const footer = add(card, \"div\", \"\", \"card-footer\"); slot(footer, \"p\", \"thread\", \"thread\");",
  "  const disclosure = details(footer, [[\"workspace_id\", \"Workspace ID\"], [\"task_id\", \"任务 ID\"], [\"producer_id\", \"Producer ID\"], [\"thread_id\", \"线程 ID\"], [\"created_at\", \"创建时间\"], [\"started_at\", \"开始时间\"], [\"ended_at\", \"结束时间\"], [\"last_reported_activity_at\", \"最近活动\"], [\"requested_model\", \"请求模型\"], [\"requested_reasoning_effort\", \"请求思考强度\"], [\"executor\", \"执行器\"]]);",
  "  slot(disclosure, \"p\", \"error\", \"safe-error\");",
  "  return card;",
  "}",
  "function updateTask(card, task, now, connected = true) {",
  "  card.dataset.state = task.state;",
  "  const project = task.workspace_display_name ?? task.workspace_id ?? \"未知项目\";",
  "  const executor = task.executor === \"dsh\" ? \"DSH\" : \"Codex\";",
  "  text(card, \"workspace\", project); text(card, \"title\", task.dashboard_title ?? project + \" · \" + executor + \" · \" + task.task_id.slice(0, 8));",
  "  text(card, \"status\", (connected ? \"\" : \"历史观测：\") + (stateLabels.get(task.state) ?? \"状态未知\")); text(card, \"model\", modelText(task));",
  "  text(card, \"duration\", durationText(task, now, connected)); text(card, \"activity\", activityText(task, now));",
  "  const finished = task.state === \"completed\" || task.state === \"failed\";",
  "  const ended = Date.parse(task.ended_at);",
  "  text(card, \"ended\", Number.isFinite(ended) ? (task.state === \"completed\" ? \"完成于 \" : \"结束于 \") + new Date(ended).toLocaleTimeString(\"zh-CN\", { hour: \"2-digit\", minute: \"2-digit\", hour12: false }) : \"结束时间未记录\").hidden = !finished;",
  "  text(card, \"thread\", task.thread_id ? \"线程 \" + task.thread_id.slice(0, 8) + (task.thread_id.length > 8 ? \"…\" : \"\") : \"\").hidden = !task.thread_id;",
  "  for (const name of [\"workspace_id\", \"task_id\", \"producer_id\", \"thread_id\", \"created_at\", \"started_at\", \"ended_at\", \"last_reported_activity_at\", \"requested_model\", \"requested_reasoning_effort\", \"executor\"]) text(card, name, task[name]);",
  "  text(card, \"error\", task.error_code ? task.error_code + \": \" + task.error_summary : \"\").hidden = !task.error_code;",
  "}",
  "function sync(parent, items, nodes, keyOf, create, update, now, containerFor = () => parent) {",
  "  const focused = parent.contains(document.activeElement) ? document.activeElement : null;",
  "  const keys = new Set();",
  "  const positions = new Map();",
  "  items.forEach(item => {",
  "    const container = containerFor(item); const index = positions.get(container) ?? 0; positions.set(container, index + 1);",
  "    const key = keyOf(item); keys.add(key);",
  "    let node = nodes.get(key);",
  "    if (!node) { node = create(); nodes.set(key, node); }",
  "    update(node, item, now);",
  "    if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null);",
  "  });",
  "  for (const [key, node] of nodes) { if (!keys.has(key)) { node.remove(); nodes.delete(key); } }",
  "  if (focused && focused.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });",
  "}",
  "function render(view) {",
  "  const now = Date.now();",
  "  latestView = view;",
  "  if (historyCutoff !== null && historyCutoff > now) historyCutoff = null;",
  "  const visible = view.tasks.filter(task => !hiddenByHistory(task));",
  "  const { current, review, ended, past, connected } = partitionTasks({ ...view, tasks: visible });",
  "  const section = document.getElementById(\"task-section\");",
  "  const focusedTask = section.contains(document.activeElement) ? document.activeElement : null;",
  "  clearHistory.disabled = view.availability !== \"available\";",
  "  historyNote.textContent = \"已隐藏 \" + (view.tasks.length - visible.length) + \" 条旧审核或已结束记录。仅影响显示，不改变任务状态或磁盘记录。\" + (storageAvailable ? \"\" : \" 显示设置无法保存，当前仅在本页生效。\");",
  "  errors.hidden = view.availability !== \"unavailable\";",
  "  document.getElementById(\"producer-empty\").hidden = view.producers.length > 0;",
  "  document.getElementById(\"task-section\").hidden = !errors.hidden;",
  "  document.getElementById(\"empty\").hidden = current.length > 0;",
  "  document.getElementById(\"empty-copy\").textContent = view.producers.some(value => value.freshness === \"fresh\") ? \"Bridge 已连接，新的任务会自动出现在这里。\" : \"新的任务记录会自动出现在这里。\";",
  "  document.getElementById(\"count\").textContent = String(current.length);",
  "  for (const [name, items] of [[\"review\", review], [\"ended\", ended], [\"past\", past]]) {",
  "    document.getElementById(name + \"-records\").hidden = items.length === 0;",
  "    document.getElementById(name + \"-count\").textContent = String(items.length);",
  "  }",
  "  sync(producers, view.producers, producerNodes, value => value.producer_id, createProducer, updateProducer, now);",
  "  sync(section, visible, taskNodes, value => JSON.stringify([value.producer_id, value.task_id]), createTask, (card, task, now) => updateTask(card, task, now, connected.has(task.producer_id)), now, task =>",
  "    !connected.has(task.producer_id) ? pastTasks : task.state === \"queued\" || task.state === \"running\" ? tasks",
  "      : task.state === \"waiting_for_supervisor_review\" ? reviewTasks : endedTasks);",
  "  for (const [name, container] of [[\"review\", reviewTasks], [\"ended\", endedTasks], [\"past\", pastTasks]]) {",
  "    if (focusedTask && container.contains(focusedTask)) { document.getElementById(name + \"-records\").open = true; focusedTask.focus({ preventScroll: true }); }",
  "  }",
  "}",
  "async function poll() {",
  "  try {",
  "    const response = await fetch(\"/api/snapshots\", { cache: \"no-store\" });",
  "    if (!response.ok) throw new Error(\"Fetch failed\");",
  "    render(await response.json());",
  "  } catch {",
  "    render({ availability: \"unavailable\", producers: [], tasks: [] });",
  "  } finally { setTimeout(poll, 2000); }",
  "}",
  "poll();",
  "</script>",
  "</body>",
  "</html>",
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
