import type { VideoCreateInput, VideoStatus } from "./video";

type ComfyWorkflow = Record<string, { inputs: Record<string, unknown>; class_type: string; _meta?: unknown }>;

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
  const files = await Promise.all((input.images || []).map((image, i) => uploadImage(base, image, i)));
  const wf = cloneWorkflow();
  wf["147"].inputs.value = input.prompt;
  wf["141"].inputs.value = Math.max(5, Math.min(15, Math.round(input.duration)));
  if (input.aspectRatio === "9:16") wf["150"].inputs.aspect_ratio = "9:16 (Portrait)";

  // 本工作流的三个参考入口：人设、场景资产、分镜关键画面。
  // 工作台送来的时间线首帧优先进入 Panel；其余参考图同时供人设与资产节点使用。
  const first = files[0] ? [files[0]] : [];
  const remaining = files.slice(1);
  wf["526"].inputs.slots_json = slots(remaining.length ? remaining : first);
  wf["527"].inputs.slots_json = slots(remaining.length ? [remaining[0]] : first);
  wf["528"].inputs.slots_json = slots(first.length ? first : remaining.slice(0, 1));

  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "short-play" }),
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ComfyUI 提交 ${res.status}: ${raw.slice(0, 500)}`);
  const d = JSON.parse(raw) as { prompt_id?: string; error?: unknown };
  if (!d.prompt_id) throw new Error(`ComfyUI 提交未返回 prompt_id: ${raw.slice(0, 500)}`);
  return { taskId: `comfy::${d.prompt_id}`, raw: d };
}

function findVideo(value: unknown): { filename: string; subfolder?: string; type?: string } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findVideo(item); if (found) return found; }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.filename === "string" && /\.mp4$/i.test(obj.filename)) {
    return { filename: obj.filename, subfolder: typeof obj.subfolder === "string" ? obj.subfolder : "", type: typeof obj.type === "string" ? obj.type : "output" };
  }
  for (const item of Object.values(obj)) { const found = findVideo(item); if (found) return found; }
  return null;
}

export async function comfyQueryVideoTask(taskId: string): Promise<VideoStatus> {
  const promptId = taskId.slice("comfy::".length);
  const base = baseUrl();
  const res = await fetch(`${base}/history/${encodeURIComponent(promptId)}`, { headers: headers(), signal: AbortSignal.timeout(60_000) });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ComfyUI 查询 ${res.status}: ${raw.slice(0, 300)}`);
  const history = JSON.parse(raw) as Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs?: unknown }>;
  const item = history[promptId];
  if (!item) return { taskId, state: "running", isFinal: false, progress: "ComfyUI 队列中/生成中", resultUrl: "", error: "", cost: 0, raw: history };
  const status = item.status?.status_str || "";
  if (status === "error") return { taskId, state: "failed", isFinal: true, progress: "", resultUrl: "", error: JSON.stringify(item.status?.messages || "ComfyUI 工作流执行失败"), cost: 0, raw: item };
  const video = findVideo(item.outputs);
  if (!video) return { taskId, state: "running", isFinal: false, progress: status || "ComfyUI 生成中", resultUrl: "", error: "", cost: 0, raw: item };
  const q = new URLSearchParams({ filename: video.filename, subfolder: video.subfolder || "", type: video.type || "output" });
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
  const first = images[0] ? [images[0]] : [];
  const remaining = images.slice(1);
  wf["526"].inputs.slots_json = slots(remaining.length ? remaining : first);
  wf["527"].inputs.slots_json = slots(remaining.length ? [remaining[0]] : first);
  wf["528"].inputs.slots_json = slots(first.length ? first : remaining.slice(0, 1));
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
