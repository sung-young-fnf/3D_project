import { defineConfig } from "vite";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import "dotenv/config";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROMPT = `너는 3D Gaussian Splatting으로 렌더된 매장/공간 이미지를 분석하는 어시스턴트다.
규칙:
- 반드시 유효한 JSON 배열만 출력한다. 설명, 마크다운 펜스, 코멘트 금지.
- 스키마: [{"label": "<물체명>", "bbox": [x1, y1, x2, y2]}]
- 좌표는 이미지 크기 기준 0~1 정규화, 원점은 좌상단.
- 물체를 찾지 못했으면 빈 배열 [] 만 출력한다.
- 배경(벽, 바닥, 천장), 가림막, 원경은 절대 포함하지 않는다.`;

function claudeDetectPlugin() {
  const capturesDir = resolve(__dirname, "captures");

  return {
    name: "claude-detect-api",
    configureServer(server) {
      server.middlewares.use("/api/detect", async (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }

        const sendJson = (status, payload) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const raw = Buffer.concat(chunks).toString("utf8");

          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            return sendJson(400, { error: "invalid json body" });
          }

          const { image_base64, mode, target } = body;
          if (!image_base64 || (mode !== "target" && mode !== "all")) {
            return sendJson(400, { error: "image_base64 and mode ('target'|'all') required" });
          }
          if (mode === "target" && !target) {
            return sendJson(400, { error: "target required when mode='target'" });
          }

          const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
          if (!token) {
            return sendJson(500, { error: "AWS_BEARER_TOKEN_BEDROCK not set in .env" });
          }

          if (!existsSync(capturesDir)) mkdirSync(capturesDir, { recursive: true });
          const capture_id = timestampId();
          writeFileSync(join(capturesDir, `${capture_id}.jpg`), Buffer.from(image_base64, "base64"));

          const client = new AnthropicBedrock({
            awsRegion: process.env.AWS_REGION ?? "us-west-2",
          });

          const userPrompt = mode === "target"
            ? `이미지에서 "${target}"에 해당하는 물체를 모두 찾아 bbox를 반환하라.`
            : `이미지에 보이는 모든 구별 가능한 개별 물체를 찾아 각각 bbox를 반환하라.`;

          const bedrockCall = client.messages.create({
            model: process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-opus-4-7",
            max_tokens: 1024,
            system: [{ type: "text", text: SYSTEM_PROMPT }],
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image_base64 } },
                { type: "text", text: userPrompt },
              ],
            }],
          });

          const resp = await withTimeout(bedrockCall, 60000);

          const text = (resp.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");

          let detections = parseDetections(text);
          detections = normalizeDetections(detections);
          detections = dedupeByIou(detections, 0.5);

          sendJson(200, { capture_id, detections });
        } catch (err) {
          console.error("[/api/detect]", err);
          sendJson(500, { error: String(err?.message ?? err) });
        }
      });
    },
  };
}

function timestampId() {
  const d = new Date();
  const p = (n, w = 2) => n.toString().padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `-${p(d.getMilliseconds(), 3)}`
  );
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Bedrock timeout ${ms}ms`)), ms)
    ),
  ]);
}

function parseDetections(text) {
  let s = (text ?? "").trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  const match = s.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

function normalizeDetections(items) {
  const out = [];
  for (const it of items) {
    if (!it || typeof it.label !== "string") continue;
    if (!Array.isArray(it.bbox) || it.bbox.length !== 4) continue;
    let [x1, y1, x2, y2] = it.bbox.map(Number);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    x1 = Math.max(0, Math.min(1, x1));
    y1 = Math.max(0, Math.min(1, y1));
    x2 = Math.max(0, Math.min(1, x2));
    y2 = Math.max(0, Math.min(1, y2));
    if (x1 > x2) [x1, x2] = [x2, x1];
    if (y1 > y2) [y1, y2] = [y2, y1];
    if (x2 - x1 < 0.001 || y2 - y1 < 0.001) continue;
    out.push({ label: it.label.trim(), bbox: [x1, y1, x2, y2] });
  }
  return out;
}

function bboxArea(b) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = bboxArea(a) + bboxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

function dedupeByIou(dets, threshold) {
  const groups = new Map();
  for (const d of dets) {
    if (!groups.has(d.label)) groups.set(d.label, []);
    groups.get(d.label).push(d);
  }
  const kept = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => bboxArea(b.bbox) - bboxArea(a.bbox));
    const local = [];
    for (const d of arr) {
      const overlap = local.some((k) => iou(k.bbox, d.bbox) >= threshold);
      if (!overlap) local.push(d);
    }
    kept.push(...local);
  }
  return kept;
}

export default defineConfig({
  server: { port: 8080 },
  resolve: {
    alias: {
      "@sparkjsdev/spark": resolve(__dirname, "spark/dist/spark.module.js"),
    },
    dedupe: ["three"],
  },
  plugins: [claudeDetectPlugin()],
});
