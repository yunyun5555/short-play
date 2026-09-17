import { randomUUID } from "node:crypto";
import type { VideoCreateInput, VideoStatus } from "./video";

type ComfyWorkflow = Record<string, { inputs: Record<string, unknown>; class_type: string; _meta?: unknown }>;

type ComfyLiveProgress = {
  value?: number;
  max?: number;
  percent?: number;
  node?: string;
  stage?: string;
  updatedAt: number;
};

const comfyProgress = new Map<string, ComfyLiveProgress>();
const comfySockets = new Map<string, WebSocket>();
const comfySocketTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function taskParts(taskId: string) {
  const [promptId, clientId = ""] = taskId.slice("comfy::".length).split("::");
  return { promptId, clientId };
}

function forgetComfyProgressWatch(promptId: string) {
  const timer = comfySocketTimeouts.get(promptId);
  if (timer) clearTimeout(timer);
  comfySocketTimeouts.delete(promptId);
  comfySockets.delete(promptId);
}

function closeComfyProgressWatch(promptId: string) {
  const socket = comfySockets.get(promptId);
  forgetComfyProgressWatch(promptId);
  comfyProgress.delete(promptId);
  try { socket?.close(); } catch {}
}

function progressLabel(promptId: string) {
  const p = comfyProgress.get(promptId);
  if (!p) return "";
  if (typeof p.percent === "number") {
    const steps = typeof p.value === "number" && typeof p.max === "number" ? `（${p.value}/${p.max}）` : "";
    return `H3 采样 ${p.percent}%${steps}`;
  }
  return p.stage || (p.node ? `正在执行节点 ${p.node}` : "");
}

function startComfyProgressWatch(base: string, clientId: string, promptId: string) {
  if (!clientId || comfySockets.has(promptId) || typeof WebSocket === "undefined") return;
  try {
    const wsBase = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    const socket = new WebSocket(`${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`);
    comfySockets.set(promptId, socket);
    comfySocketTimeouts.set(promptId, setTimeout(() => closeComfyProgressWatch(promptId), 2 * 60 * 60 * 1000));

    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      try {
        const message = JSON.parse(raw) as { type?: string; data?: Record<string, unknown> };
        const data = message.data || {};
        if (data.prompt_id && String(data.prompt_id) !== promptId) return;

        if (message.type === "progress") {
          const value = Number(data.value);
          const max = Number(data.max);
          const percent = Number.isFinite(value) && Number.isFinite(max) && max > 0
            ? Math.max(0, Math.min(100, Math.floor((value / max) * 100)))
            : undefined;
          comfyProgress.set(promptId, {
            value: Number.isFinite(value) ? value : undefined,
            max: Number.isFinite(max) ? max : undefined,
            percent,
            node: typeof data.node === "string" ? data.node : undefined,
            updatedAt: Date.now(),
          });
        } else if (message.type === "executing" || message.type === "execution_start") {
          comfyProgress.set(promptId, {
            node: typeof data.node === "string" ? data.node : undefined,
            stage: message.type === "execution_start" ? "ComfyUI 开始执行" : "ComfyUI 正在执行",
            updatedAt: Date.now(),
          });
        }
      } catch {
        // 预览二进制帧或非 JSON 消息不影响文字进度。
      }
    });
    socket.addEventListener("close", () => forgetComfyProgressWatch(promptId));
    socket.addEventListener("error", () => forgetComfyProgressWatch(promptId));
  } catch {
    // WebSocket 不可用时仍回退到 HTTP 队列状态，不影响出片。
  }
}

function baseUrl() {
  const value = (process.env.COMFYUI_BASE_URL || "").replace(/\/$/, "");
  if (!value) throw new Error("缺少 COMFYUI_BASE_URL");
  return value;
}

function headers(): Record<string, string> {
  const token = process.env.COMFYUI_API_TOKEN || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function cloneWorkflow(): ComfyWorkflow {
  const raw = process.env.COMFYUI_WORKFLOW_JSON || "";
  if (!raw) throw new Error("缺少 COMFYUI_WORKFLOW_JSON");
  try {
    return JSON.parse(raw) as ComfyWorkflow;
  } catch {
    throw new Error("COMFYUI_WORKFLOW_JSON 不是有效的 API 工作流 JSON");
  }
}

function slots(files: string[]) {
  return JSON.stringify([...files.slice(0, 10), ...Array(10).fill("")].slice(0, 10));
}

function attachImages(wf: ComfyWorkflow, gridId: string, files: string[], prefix: string) {
  const grid = wf[gridId];
  grid.inputs.slots_json = "[]";
  for (let i = 1; i <= 10; i += 1) delete grid.inputs[`image_${i}`];
  files.slice(0, 10).forEach((file, i) => {
    const loadId = `${prefix}_${i + 1}`;
    wf[loadId] = { class_type: "LoadImage", inputs: { image: file } };
    grid.inputs[`image_${i + 1}`] = [loadId, 0];
  });
}

function bindReferenceImages(wf: ComfyWorkflow, files: string[]) {
  const first = files[0] ? [files[0]] : [];
  const remaining = files.slice(1);
  attachImages(wf, "526", remaining.length ? remaining : first, "901");
  attachImages(wf, "527", remaining.length ? [remaining[0]] : first, "902");
  attachImages(wf, "528", first.length ? first : remaining.slice(0, 1), "903");
}

function applyVideoSettings(wf: ComfyWorkflow, input: VideoCreateInput) {
  // 工作台项目设置中的清晰度直接控制 ResolutionSelector。
  const mp: Record<string, number> = {
    // 按像素量控制；ResolutionSelector 再按项目画幅取最接近 32 倍数的宽高。
    "360P": 0.25,
    "480P": 0.4,
    "720P": 0.9,
    "768P": 1.0,
    "1080P": 2.1,
    "2K": 3.7,
  };
  wf["150"].inputs.megapixels = mp[input.resolution || "1080P"] || 2.1;
  wf["150"].inputs.aspect_ratio = input.aspectRatio === "9:16" ? "9:16 (Portrait)" : "16:9 (Widescreen)";
}

async function uploadImage(base: string, dataUrl: string, index: number) {
  if (!dataUrl.startsWith("data:")) return dataUrl;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("ComfyUI 图片格式不正确");
  const mime = dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png";
  const bytes = Buffer.from(dataUrl.slice(comma + 1), "base64");
  const body = new FormData();
  body.set("image", new Blob([bytes], { type: mime }), `short-play-${Date.now()}-${index}.png`);
  const res = await fetch(`${base}/upload/image`, { method: "POST", headers: headers(), body, signal: AbortSignal.timeout(60_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ComfyUI 上传图片 ${res.status}: ${raw.slice(0, 300)}`);
  const d = JSON.parse(raw) as { name?: string; subfolder?: string };
  if (!d.name) throw new Error(`ComfyUI 上传图片未返回文件名: ${raw.slice(0, 200)}`);
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}

export function comfyVideoModel() {
  return "comfyui:Ki_H3_电影质感V1.0_人物写实对照版";
}

export async function comfyCreateVideoTask(input: VideoCreateInput): Promise<{ taskId: string; raw: unknown }> {
  const base = baseUrl();
  // 每条任务单独 client_id，才能从 ComfyUI WebSocket 收到只属于这条任务的实时 progress。
  const clientId = `short-play-${randomUUID()}`;
  const files = await Promise.all((input.images || []).map((image, i) => uploadImage(base, image, i)));
  const wf = cloneWorkflow();
  wf["147"].inputs.value = input.prompt;
  wf["141"].inputs.value = Math.max(5, Math.min(15, Math.round(input.duration)));
  applyVideoSettings(wf, input);
  bindReferenceImages(wf, files);

  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: clientId }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ComfyUI 提交 ${res.status}: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { prompt_id?: string; error?: unknown };
  if (!d.prompt_id) throw new Error(`ComfyUI 提交未返回 prompt_id: ${raw.slice(0, 500)}`);
  startComfyProgressWatch(base, clientId, d.prompt_id);
  return { taskId: `comfy::${d.prompt_id}::${clientId}`, raw: d };
}

type ComfyOutputFile = { filename: string; subfolder?: string; type?: string };

function findVideo(value: unknown): ComfyOutputFile | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findVideo(item); if (found) return found; }
    return null;
  }
  const obj = value as Record<string, unknown>;
  const filename = typeof obj.filename === "string" ? obj.filename : "";
  // VHS_VideoCombine 通常返回 mp4；不同版本也可能只在 format/mime 里标记视频格式。
  const meta = [obj.format, obj.mime, obj.content_type, obj.media_type].filter((v): v is string => typeof v === "string").join(" ");
  const isVideo = /\.(mp4|webm|mov|mkv|avi|m4v|gif)$/i.test(filename)
    || /(^|[\\/\s-])(video|h26[45]|hevc|mpeg|webm|gif)($|[\\/\s-])/i.test(meta);
  if (filename && isVideo) {
    return { filename, subfolder: typeof obj.subfolder === "string" ? obj.subfolder : "", type: typeof obj.type === "string" ? obj.type : "output" };
  }
  for (const item of Object.values(obj)) { const found = findVideo(item); if (found) return found; }
  return null;
}

function outputSummary(value: unknown) {
  const files: string[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const obj = item as Record<string, unknown>;
    if (typeof obj.filename === "string") files.push(obj.filename);
    Object.values(obj).forEach(visit);
  };
  visit(value);
  return files.length ? files.slice(0, 8).join(", ") : "没有可下载的输出文件";
}

async function queueProgress(base: string, promptId: string) {
  const live = progressLabel(promptId);
  if (live) return live;
  try {
    const res = await fetch(`${base}/queue`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return "ComfyUI 队列中";
    const queue = await res.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
    const running = queue.queue_running || [];
    const pending = queue.queue_pending || [];
    if (running.some((item) => Array.isArray(item) && String(item[1]) === promptId)) return "ComfyUI 正在生成";
    const index = pending.findIndex((item) => Array.isArray(item) && String(item[1]) === promptId);
    return index >= 0 ? `ComfyUI 排队中，前方 ${index} 个任务` : "ComfyUI 队列中";
  } catch {
    return "ComfyUI 队列中";
  }
}

export async function comfyCancelVideoTask(taskId: string): Promise<{ message: string }> {
  if (!taskId.startsWith("comfy::")) throw new Error("不是 ComfyUI 视频任务");
  const base = baseUrl();
  const { promptId } = taskParts(taskId);
  const queueRes = await fetch(`${base}/queue`, { headers: headers(), signal: AbortSignal.timeout(20_000) });
  if (!queueRes.ok) throw new Error(`无法读取 ComfyUI 队列：${queueRes.status}`);
  const queue = await queueRes.json() as { queue_running?: unknown[]; queue_pending?: unknown[] };
  const running = queue.queue_running || [];
  const pending = queue.queue_pending || [];
  const isRunning = running.some((item) => Array.isArray(item) && String(item[1]) === promptId);
  const isPending = pending.some((item) => Array.isArray(item) && String(item[1]) === promptId);

  if (isPending) {
    const res = await fetch(`${base}/queue`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`ComfyUI 未能移除排队任务：${res.status}`);
    closeComfyProgressWatch(promptId);
    return { message: "已从 ComfyUI 队列移除" };
  }

  if (isRunning) {
    const res = await fetch(`${base}/interrupt`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`ComfyUI 未能中止当前任务：${res.status}`);
    closeComfyProgressWatch(promptId);
    return { message: "已向 ComfyUI 发送中止命令" };
  }

  closeComfyProgressWatch(promptId);
  return { message: "ComfyUI 队列中已找不到该任务，工作台已停止轮询" };
}

export async function comfyQueryVideoTask(taskId: string): Promise<VideoStatus> {
  const { promptId, clientId } = taskParts(taskId);
  const base = baseUrl();
  // Railway 重启后内存中的监听会消失；带 client_id 的新任务可在下一次轮询时自动重新监听。
  startComfyProgressWatch(base, clientId, promptId);
  const res = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ComfyUI 查询 ${res.status}: ${raw.slice(0, 300)}`);
  const history = JSON.parse(raw) as Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs?: unknown }>;
  const item = history[promptId];
  if (!item) return { taskId, state: "running", isFinal: false, progress: await queueProgress(base, promptId), resultUrl: "", error: "", cost: 0, raw: history };
  const status = item.status?.status_str || "";
  if (status === "error") {
    closeComfyProgressWatch(promptId);
    return { taskId, state: "failed", isFinal: true, progress: "", resultUrl: "", error: JSON.stringify(item.status?.messages || "ComfyUI 工作流执行失败"), cost: 0, raw: item };
  }
  const video = findVideo(item.outputs);
  // 绝不能把 ComfyUI 已经完成但没有视频产物的任务继续伪装成“生成中”。
  if (!video && ["success", "completed"].includes(status.toLowerCase())) {
    closeComfyProgressWatch(promptId);
    return {
      taskId,
      state: "failed",
      isFinal: true,
      progress: "",
      resultUrl: "",
      error: `ComfyUI 已结束，但工作流没有输出视频文件（${outputSummary(item.outputs)}）。请确认 VHS_VideoCombine / 保存视频节点已连接并启用。`,
      cost: 0,
      raw: item,
    };
  }
  if (!video) return { taskId, state: "running", isFinal: false, progress: status || "ComfyUI 生成中", resultUrl: "", error: "", cost: 0, raw: item };
  const q = new URLSearchParams({ filename: video.filename, subfolder: video.subfolder || "", type: video.type || "output" });
  closeComfyProgressWatch(promptId);
  return { taskId, state: "success", isFinal: true, progress: "100%", resultUrl: `${base}/view?${q}`, error: "", cost: 0, raw: item };
}


function findImage(value: unknown): { filename: string; subfolder?: string; type?: string } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findImage(item); if (found) return found; }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.filename === "string" && /\.(png|jpe?g|webp)$/i.test(obj.filename)) {
    return { filename: obj.filename, subfolder: typeof obj.subfolder === "string" ? obj.subfolder : "", type: typeof obj.type === "string" ? obj.type : "output" };
  }
  for (const item of Object.values(obj)) { const found = findImage(item); if (found) return found; }
  return null;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 没有外部图片 API 时，复用用户的 H3 工作流生成 5 秒片段，并取解码出的第一帧作为工作台首帧。
 * 工作流与视频使用同一组人物/场景参考图，因此首帧和之后 H3 视频处在同一视觉空间。
 */
export async function comfyGenerateFrame(opts: { prompt: string; refs: Array<{ buffer: Buffer; mime: string }> }): Promise<{ buffer: Buffer; mime: string }> {
  const base = baseUrl();
  const images = await Promise.all(opts.refs.map((ref, i) => uploadImage(base, `data:${ref.mime};base64,${ref.buffer.toString("base64")}`, i)));
  const wf = cloneWorkflow();
  wf["147"].inputs.value = opts.prompt;
  wf["141"].inputs.value = 5;
  bindReferenceImages(wf, images);
  // 148 是视频 VAE 解码图像；保存它可以直接回填给工作台做首帧。
  wf["998"] = { class_type: "SaveImage", inputs: { filename_prefix: "short-play/frames", images: ["148", 0] } };

  const submitted = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "short-play-frame" }),
    signal: AbortSignal.timeout(120_000),
  });
  const submitRaw = await submitted.text();
  if (!submitted.ok) throw new Error(`ComfyUI 首帧提交 ${submitted.status}: ${submitRaw.slice(0, 500)}`);
  const task = JSON.parse(submitRaw) as { prompt_id?: string };
  if (!task.prompt_id) throw new Error(`ComfyUI 首帧提交未返回 prompt_id: ${submitRaw.slice(0, 400)}`);

  for (let attempt = 0; attempt < 180; attempt += 1) {
    await pause(5_000);
    const res = await fetch(`${base}/history/${encodeURIComponent(task.prompt_id)}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
    const raw = await res.text();
    if (!res.ok) throw new Error(`ComfyUI 首帧查询 ${res.status}: ${raw.slice(0, 300)}`);
    const item = (JSON.parse(raw) as Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs?: unknown }>)[task.prompt_id];
    if (!item) continue;
    if (item.status?.status_str === "error") throw new Error(`ComfyUI 首帧失败: ${JSON.stringify(item.status.messages || "").slice(0, 500)}`);
    const image = findImage(item.outputs);
    if (!image) continue;
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
    const file = await fetch(`${base}/view?${query}`, { headers: headers(), signal: AbortSignal.timeout(120_000) });
    if (!file.ok) throw new Error(`ComfyUI 下载首帧失败 ${file.status}`);
    const mime = (file.headers.get("content-type") || "image/png").split(";")[0];
    return { buffer: Buffer.from(await file.arrayBuffer()), mime };
  }
  throw new Error("ComfyUI 首帧超过 15 分钟未完成");
}
