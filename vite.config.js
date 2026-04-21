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
- label 은 반드시 **한국어**로 작성한다 (예: "종이컵", "티슈 박스", "금연 표지판", "비닐봉지 묶음"). 영어·한자 금지.
- 좌표는 이미지 크기 기준 0~1 정규화, 원점은 좌상단.
- 물체를 찾지 못했으면 빈 배열 [] 만 출력한다.
- 배경(벽, 바닥, 천장), 가림막, 원경은 절대 포함하지 않는다.`;

const COMMAND_SYSTEM_PROMPT = `너는 3D VMD 에디터의 자연어 명령 해석 어시스턴트다.
사용자가 한국어 문장으로 박스 조작을 지시하면 대상 박스와 동작을 JSON 객체로 반환한다.

지원 동작:
- swap: 두 박스의 위치를 서로 바꿈 (targets 에 박스 id 2개)

출력 스키마 (JSON only, no markdown fence):
{"action": "swap" | "none", "targets": [<id>, ...], "reason": "<한글 설명>"}

규칙:
- 반드시 아래 박스 목록의 id 만 사용한다.
- 의도를 확신할 수 없거나 매칭되는 박스가 없으면 action="none", targets=[], reason 에 이유.
- 박스 이름(label 포함)과 사용자 지시어를 의미적으로 매칭한다 (예: "냉장고"와 "paper cup stack" 은 매칭 불가).`;

const ENHANCE_PROMPT_NO_REF = `이 3D 매장/공간 이미지에는 3D Gaussian Splatting 렌더링의 잔여 아티팩트 — 얼룩, 반투명 자국, 빈 공간, 경계 잡음 — 이 남아있다.

요구사항:
- 물체의 위치·종류·색감·조명은 최대한 그대로 유지한다.
- 렌더링 아티팩트만 자연스럽게 제거해 깔끔한 실내 사진처럼 보정한다.
- 새 물체를 추가하거나 기존 물체를 제거하지 않는다. 블러·흐릿한 영역에서 보이는 듯한 물체를 상상해 만들지 말 것.
- 배경(벽·바닥·천장) 질감은 일관되게 복원한다.
- 원본의 카메라 각도와 구도를 유지한다.
- "최근 이동/변형된 물체" 가 주어지면 해당 영역의 잔여 잡음·경계선을 특히 정밀하게 다듬는다.`;

const ENHANCE_PROMPT_WITH_REF = `**매우 중요**: 이 작업은 새 이미지 생성이 아니라 **3D 렌더링 아티팩트 디노이징** 이다. 출력은 첫 번째 입력 이미지와 **99% 픽셀 수준으로 동일** 해야 하며, 단지 렌더링 잡음만 제거된다.

**입력 이미지**:
- **첫 번째 = 보정 대상**: 3D 매장 씬. 일부 물체가 박스 편집으로 재배치됨. 렌더링 잔여물(얼룩·반투명·블러·경계 잡음) 남음.
- **두 번째 = 외형 참조**: 편집 전 원본. 흐린 영역이 원래 무엇이었는지 확인용. **출력에 직접 사용하지 말 것**.

**출력 정의**: 첫 번째 이미지의 복사본, 단 아티팩트만 지운 것. 구도·배치·존재하는 물체·텍스트 모두 그대로.

## 100% 준수 (하나라도 어기면 실패):

1. **새 물체 추가 절대 금지**: 첫 번째 이미지에 없는 것은 출력에도 없다. 정수기·새 가구·새 상자·새 컵·새 선반·식기세척기·냉장고 등 **일체 추가 금지**. 두 번째 이미지에만 있고 첫 번째 이미지에 없는 물체도 추가하지 말 것.

2. **기존 물체 삭제/이동 금지**: 첫 번째 이미지의 모든 물체는 출력에도 **같은 자리에** 동일한 수만큼 존재해야 함. Maxim 박스·텀블러·물병·컵·쓰레기통 등 어떤 것도 위치 변경하지 말 것.

3. **물체 종류 변환 금지**: 플라스틱 병을 유리잔으로, 텀블러를 컵으로, 상자를 기계로 등 **절대 금지**. 첫 번째 이미지에 보이는 종류 그대로.

4. **모든 텍스트 보존 (글자 단위)**: 벽의 표지판·라벨·쓰레기통 아이콘의 한국어/영어 텍스트를 **한 글자도 바꾸지 말 것**. 번역·재생성·유추 금지. 원본 글자가 흐리면 두 번째 이미지의 동일 위치 텍스트를 복사. 두 이미지 모두 불명확하면 흐린 상태 그대로 둘 것.

5. **카메라 각도·구도·프레이밍 완전 동일**.

## 아티팩트 처리 방식

- **블러 영역**: 같은 위치를 두 번째 이미지에서 찾아 그대로 복사 (새로 생성 금지).
- **반투명 자국**: 주변 질감으로 자연스럽게 지움.
- **물체 경계 잡음**: 해당 물체의 두 번째 이미지 실제 형태를 참조해 선명하게 정리, 단 종류·색상 변경 금지.

## 금지된 환각 예시 (절대 하지 말 것)

- ❌ 새 가구를 그려 넣는 것
- ❌ 물체를 새롭게 재해석
- ❌ 첫 번째 이미지 빈 공간에 추가 물체 창조

## 한 줄 요약

첫 번째 이미지 ≈ 출력. 두 번째 이미지 = 흐릿한 곳 확인용 레퍼런스. **당신의 창의력은 필요없다. 오직 노이즈 제거만 하라.**`;

function claudeDetectPlugin() {
  const capturesDir = resolve(__dirname, "captures");

  return {
    name: "claude-detect-api",
    configureServer(server) {
      // Gemini 이미지 보정 엔드포인트 — splat 아티팩트 제거
      server.middlewares.use("/api/enhance", async (req, res, next) => {
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
          const { image_base64, reference_base64, context, boxes } = body;
          if (!image_base64) {
            return sendJson(400, { error: "image_base64 required" });
          }

          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey) {
            return sendJson(500, { error: "GEMINI_API_KEY not set in .env" });
          }
          const modelId = process.env.GEMINI_MODEL_ID ?? "gemini-2.5-flash-image-preview";

          if (!existsSync(capturesDir)) mkdirSync(capturesDir, { recursive: true });
          const capture_id = timestampId();
          writeFileSync(
            join(capturesDir, `${capture_id}.jpg`),
            Buffer.from(image_base64, "base64")
          );

          // 클라이언트에서 보낸 pristine 레퍼런스 저장 (디버그용)
          let referenceId = null;
          if (reference_base64) {
            try {
              writeFileSync(
                join(capturesDir, `${capture_id}-reference.jpg`),
                Buffer.from(reference_base64, "base64")
              );
              referenceId = `${capture_id}-reference`;
            } catch (err) {
              console.warn("[/api/enhance] 레퍼런스 저장 실패:", err?.message);
            }
          }

          // 박스 목록 → 프롬프트 컨텍스트
          let boxContext = "";
          if (Array.isArray(boxes) && boxes.length > 0) {
            const moved = boxes.filter((b) => b?.moved).map((b) => b.name);
            const all = boxes.map((b) => b?.name).filter(Boolean);
            const lines = [];
            if (moved.length > 0) {
              lines.push(`최근 이동/변형된 물체: ${moved.join(", ")}`);
            }
            if (all.length > 0) {
              lines.push(`화면의 박스 라벨 전체: ${all.join(", ")}`);
            }
            if (lines.length > 0) {
              boxContext = "\n\n" + lines.join("\n");
            }
          }

          const userContext = context ? `\n\n사용자 맥락: ${context}` : "";
          const promptBase = reference_base64 ? ENHANCE_PROMPT_WITH_REF : ENHANCE_PROMPT_NO_REF;
          const prompt = `${promptBase}${boxContext}${userContext}`;

          // Gemini 멀티 이미지 parts — **보정 대상(편집 후) 을 먼저**, 참조를 뒤에.
          // Gemini 는 첫 이미지를 "편집할 대상" 으로 해석하는 경향이 있어 순서가 중요.
          const parts = [];
          parts.push({ inline_data: { mime_type: "image/jpeg", data: image_base64 } });
          if (reference_base64) {
            parts.push({ inline_data: { mime_type: "image/jpeg", data: reference_base64 } });
          }
          parts.push({ text: prompt });

          const started = Date.now();
          const geminiCall = fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
              },
              body: JSON.stringify({
                contents: [{ parts }],
              }),
            }
          );
          const geminiResp = await withTimeout(geminiCall, 50000, "Gemini");

          if (!geminiResp.ok) {
            const errText = await geminiResp.text().catch(() => "");
            return sendJson(geminiResp.status, {
              error: `Gemini ${geminiResp.status}: ${errText.slice(0, 400)}`,
            });
          }
          const data = await geminiResp.json();
          const part = data?.candidates?.[0]?.content?.parts?.find(
            (p) => p.inline_data || p.inlineData
          );
          const inline = part?.inline_data ?? part?.inlineData;
          if (!inline?.data) {
            return sendJson(502, { error: "Gemini 응답에 이미지가 없음" });
          }
          const enhanced_base64 = inline.data;
          const enhanced_mime = inline.mime_type ?? inline.mimeType ?? "image/png";
          const ext = enhanced_mime.includes("png") ? "png" : "jpg";
          writeFileSync(
            join(capturesDir, `${capture_id}-enhanced.${ext}`),
            Buffer.from(enhanced_base64, "base64")
          );

          sendJson(200, {
            capture_id,
            enhanced_base64,
            enhanced_mime,
            elapsed_ms: Date.now() - started,
            reference_id: referenceId,
          });
        } catch (err) {
          console.error("[/api/enhance]", err);
          sendJson(500, { error: String(err?.message ?? err) });
        }
      });

      // 자연어 명령 해석 엔드포인트 (이미지 없이 텍스트만)
      server.middlewares.use("/api/command", async (req, res, next) => {
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
          const { text, boxes } = body;
          if (typeof text !== "string" || !text.trim()) {
            return sendJson(400, { error: "text required" });
          }
          if (!Array.isArray(boxes) || boxes.length === 0) {
            return sendJson(400, { error: "boxes array required (non-empty)" });
          }

          const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
          if (!token) {
            return sendJson(500, { error: "AWS_BEARER_TOKEN_BEDROCK not set in .env" });
          }

          const client = new AnthropicBedrock({
            awsRegion: process.env.AWS_REGION ?? "us-west-2",
          });

          const listStr = boxes
            .map((b) => `- id=${b.id}, name=${JSON.stringify(b.name)}`)
            .join("\n");
          const userPrompt = `박스 목록:\n${listStr}\n\n사용자 명령:\n${text}`;

          const bedrockCall = client.messages.create({
            model: process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6",
            max_tokens: 512,
            system: [{ type: "text", text: COMMAND_SYSTEM_PROMPT }],
            messages: [{ role: "user", content: userPrompt }],
          });
          const resp = await withTimeout(bedrockCall, 30000, "Bedrock");

          const responseText = (resp.content ?? [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          const parsed = parseCommand(responseText);
          sendJson(200, parsed);
        } catch (err) {
          console.error("[/api/command]", err);
          sendJson(500, { error: String(err?.message ?? err) });
        }
      });

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

          const resp = await withTimeout(bedrockCall, 60000, "Bedrock");

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

function withTimeout(promise, ms, label = "Request") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)
    ),
  ]);
}

function parseCommand(text) {
  let s = (text ?? "").trim();
  s = s.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const tryParse = (str) => {
    try {
      const o = JSON.parse(str);
      if (o && typeof o === "object" && !Array.isArray(o)) return o;
    } catch {}
    return null;
  };
  let obj = tryParse(s);
  if (!obj) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) obj = tryParse(m[0]);
  }
  if (!obj) return { action: "none", targets: [], reason: "응답 파싱 실패" };
  return {
    action: typeof obj.action === "string" ? obj.action : "none",
    targets: Array.isArray(obj.targets) ? obj.targets : [],
    reason: typeof obj.reason === "string" ? obj.reason : "",
  };
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
