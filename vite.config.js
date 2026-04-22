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

const ENHANCE_PROMPT = `**작업 정의**: 이 이미지는 3D Gaussian Splatting 으로 렌더된 매장 씬이며, 박스 영역 편집으로 일부 물체가 재배치된 **편집 후 상태** 다. 이 작업은 새 이미지 생성이 아니라 **박스 목록에 지정된 영역 주변에 한정된 국소 디노이징 + 박스 와이어프레임 선 제거** 다. 출력은 입력 이미지와 **99% 픽셀 수준으로 동일** 해야 하며, 박스 목록 영역 밖은 전혀 변경되지 않는다.

**입력**: 이미지 1장(편집 후 현재 상태). 편집 전 원본은 제공되지 않는다 — 추측·상상으로 "편집 전 상태"로 되돌리지 말 것.

**박스 와이어프레임 선 안내**: 이미지 위에 **cyan(하늘색, 비활성 박스)** 과 **노란색(활성 박스)** 의 직육면체 선(edge line) 이 그려져 있다. 이것은 편집 영역을 표시하는 UI 오버레이이며, **실제 씬의 물체가 아니다**. 출력에서는 이 선들을 **완전히 제거** 하고, 선이 덮고 있던 자리는 주변 씬 픽셀(물체 또는 배경) 로 자연스럽게 복원해야 한다. 이 선들의 위치가 곧 "보정 대상 박스 영역" 의 시각적 경계이므로, **해당 선이 둘러싼 내부 및 경계 주변만** 디노이징 작업을 수행한다.

## 100% 준수 (하나라도 어기면 실패):

1. **박스 와이어프레임 선 완전 제거**: 이미지의 모든 cyan/노란색 직육면체 선(edge line) 은 UI 오버레이이므로 출력에서 **100% 제거** 한다. 선이 덮고 있던 픽셀은 그 바로 아래에 있는 실제 씬 콘텐츠(물체 또는 배경 질감) 로 자연스럽게 메운다. 출력에 어떤 컬러 선·윤곽선·박스 테두리도 남겨두지 말 것.

2. **박스 목록 밖 영역 완전 보존**: 아래 "보정 대상 박스 목록" 에 포함되지 않은 모든 영역은 **입력 이미지와 픽셀 단위로 동일** 해야 한다 (단, 그 영역을 가로지르는 박스 와이어프레임 선이 있다면 그 선만 제거하고 주변 픽셀로 메움). 배경(벽·바닥·천장), 표지판, 다른 물체, 빈 공간 — 전부 원본 그대로. 리렌더·채색·매끈화 금지.

3. **박스 영역 내부 = 국소 디노이징만**: 박스 와이어프레임 선이 둘러싼 내부 및 그 경계(박스 면적의 약 1.3배 반경) 에 한해 렌더링 잡음 — 얼룩·반투명 자국·경계 블러·흔들린 픽셀 — 만 자연스럽게 지운다. 물체 자체는 그대로.

4. **"편집 전" 으로 되돌리기 절대 금지**: 박스 안의 물체가 이동·재배치된 결과 그대로 유지한다. 물체를 원래 있던 자리로 옮기거나, 이동 흔적을 "없던 일" 로 만들지 말 것. **이것은 편집 취소가 아니다**.

5. **이동 잔재(ghost) 복원 절대 금지 — 가장 중요**: 물체가 박스로 이동된 경우, **원래 있던 자리에 희미한 실루엣·반투명 수직 기둥·대형 흐릿한 덩어리·부분 윤곽·얼룩진 형체** 가 남아있을 수 있다. 이것은 3D Gaussian Splatting 의 잔재(ghost) 이며 **실제 물체가 아니다**. 절대로 이 흔적을 선명한 물체로 복원·완성·재해석하지 말고 **주변 배경(벽·바닥·주변 가구) 픽셀로 깨끗하게 지워라**.
   - **동일 물체 2개 룰**: "최근 이동·스케일 변형된 박스" 목록에 있는 물체 이름은 이미지 전체에 **정확히 박스 개수만큼만** 선명하게 존재해야 한다. 박스 밖 어딘가에 유사한 실루엣·반투명 형체가 보이면 **100% 잔재로 간주하고 배경으로 메운다**. 같은 이름의 물체가 출력에 2개 이상 선명하게 찍히면 즉시 실패.
   - **판단 휴리스틱**: 박스 안에 이미 선명한 냉장고가 있다면, 그 박스 밖의 수직 흰색/회색 실루엣·반투명 기둥은 **모두 이전 위치의 ghost** 다. 절대 "흐릿한 냉장고" 로 해석해 완성시키지 말 것.

6. **새 물체 추가 절대 금지**: 입력 이미지에 없는 가구·가전·식기·컵·박스·기계·식물 등 **일체 추가 금지**. 빈 공간·블러·반투명 영역을 새 물체로 채우지 말 것. 박스 와이어프레임이 감싼 공간을 "새 물체" 로 해석하지 말 것 — 선은 단순 UI 오버레이다. **희미하게 보이는 윤곽을 "아마 OO일 것" 이라고 추측해 완성시키지 말 것**.

7. **기존 물체 삭제 금지**: 입력 이미지에 **선명하게** 존재하는 물체는 출력에도 같은 자리에 존재. 단 박스 와이어프레임 선·이동 잔재(ghost) 는 "물체" 가 아니므로 제거 대상.

8. **물체 종류·색상 변환 금지**: 플라스틱 병→유리잔, 텀블러→컵, 상자→기계 등 재해석 금지.

9. **모든 텍스트 보존 (글자 단위)**: 표지판·라벨·간판·아이콘의 한국어/영어 텍스트를 **한 글자도 바꾸지 말 것**. 번역·재생성·유추 금지. 흐리면 흐린 그대로.

10. **카메라 각도·구도·프레이밍 완전 동일**.

## 아티팩트 처리 방식

**박스 영역 내부** (실제 물체 위에 남은 렌더링 잡음):
- **얼룩·반투명 자국**: 주변 질감을 기반으로 자연스럽게 제거.
- **경계 블러·흔들림**: 물체 외형을 또렷하게 정리, 단 종류·색상 변경 금지.
- **작은 빈 틈**: 주변 배경 질감으로 메움(새 물체 생성 금지).

**박스 영역 밖의 이동 잔재(ghost)** — "최근 이동·스케일 변형된 박스" 에 등록된 물체의 *원래 자리*에 남은 흔적:
- **대형 수직 실루엣·기둥형 반투명 덩어리·희미한 외곽선·얼룩진 형체**: 전부 ghost. 선명한 물체로 복원하지 말고 **배경(벽·바닥·주변 가구) 질감으로 깨끗이 지운다**.
- **판단 기준**: 같은 이름의 물체가 이미 박스 안에 선명하게 존재한다면, 박스 밖의 유사한 형체는 **100% 잔재**. 박스 개수 = 해당 물체의 최종 출력 개수.
- **복원 유혹 차단**: ghost 는 3D 렌더링의 limitation 일 뿐, "흐릿하니까 선명하게 만들어달라" 는 지시가 아니다. 흐릿하면 **지워라**, 선명하게 하지 마라.

## 금지된 환각 예시 (절대 하지 말 것)

- ❌ 박스 안의 물체를 "원래 있던 자리" 로 되돌리기
- ❌ **이동된 물체의 원래 자리에 남은 흐릿한 실루엣·반투명 기둥을 선명한 "같은 물체"로 복원 — 결과 이미지에 동일 물체가 2개 찍히면 100% 실패**
- ❌ 반투명 수직 덩어리를 "흐릿한 냉장고·선반·기기" 로 해석해 완성시키기
- ❌ 박스 밖 흐릿한 형체를 "여기에도 뭔가 있었을 것" 이라 추측해 채우기
- ❌ 박스 밖 영역을 손보기 (배경 리렌더, 조명 재계산 등) — 단, ghost 제거는 예외
- ❌ 이미지 전체에 통일된 필터·톤 적용
- ❌ 새 가구/소품을 그려 넣기
- ❌ 박스 와이어프레임 선을 출력에 남겨두기 (흐리게라도 안 됨)
- ❌ 박스 선을 실제 물체(예: 유리 케이스, 선반 프레임) 로 재해석하기

## 한 줄 요약

**박스 와이어프레임 선 제거 → 박스 선 내부만 디노이징 → 박스 밖의 ghost(이동 잔재)는 배경으로 지움 → 그 외 픽셀은 원본 그대로. 같은 물체가 2개 선명하게 출력되면 실패. 당신의 창의력은 필요없다. 선·ghost 제거 + 국소 노이즈 제거만 하라.**`;

const SEGMENT_PROMPT = `**작업**: 이 이미지에서 "{target}" 에 해당하는 물체의 **픽셀 단위 이진 마스크** 를 생성하라.

**출력 요구사항**:
- 입력 이미지와 **완전히 동일한 해상도·구도·프레이밍** 의 이미지를 출력.
- "{target}" 에 해당하는 픽셀은 **순수 흰색 (RGB 255,255,255)**.
- 그 외 모든 픽셀 (배경·다른 물체·바닥·그림자) 은 **순수 검정 (RGB 0,0,0)**.
- **회색·그라디언트·앤티앨리어싱 금지** — 오직 흑 또는 백 두 가지 색만.
- 물체의 정확한 윤곽을 픽셀 단위로 표시. 직사각형 근사 금지.

**물체 식별 규칙**:
- 여러 부분으로 구성된 물체(예: 손잡이 + 본체)는 모두 흰색.
- 물체에 붙어 있는 라벨·스티커·로고는 물체의 일부로 간주 → 흰색.
- 물체가 가려져 일부만 보이면 **보이는 픽셀만** 흰색. 추측으로 가린 부분까지 확장하지 말 것.
- 화면에 "{target}" 이 여러 개 있으면 모두 흰색 (같은 종류 물체 전부).

**절대 금지**:
- 배경 벽·바닥·천장을 흰색으로 표시
- 대상 물체와 인접한 다른 물체를 같은 마스크에 포함
- 회색 음영으로 "애매함" 표현
- 원본 이미지 색상 보존 (출력은 순수 흑백)
- 해상도 변경·크롭·리사이즈

**한 줄 요약**: 입력 이미지와 똑같은 크기의 흑백 이미지. "{target}" = 흰색, 나머지 = 검정. 끝.`;

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
          const { image_base64, context, boxes } = body;
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

          // 박스 목록 → 프롬프트 컨텍스트 (보정 대상 영역 한정)
          let boxContext = "";
          if (Array.isArray(boxes) && boxes.length > 0) {
            const moved = boxes.filter((b) => b?.moved).map((b) => b.name);
            const all = boxes.map((b) => b?.name).filter(Boolean);
            const lines = [];
            if (all.length > 0) {
              lines.push(
                `## 보정 대상 박스 목록 (이 물체들의 주변만 디노이징 허용, 나머지 영역은 원본 픽셀 그대로):\n- ${all.join("\n- ")}`
              );
            }
            if (moved.length > 0) {
              lines.push(
                `## 최근 이동·스케일 변형된 박스 (잔여 아티팩트가 가장 심한 영역 — 우선 정리):\n- ${moved.join("\n- ")}`
              );
            }
            if (lines.length > 0) {
              boxContext = "\n\n" + lines.join("\n\n");
            }
          } else {
            // 박스가 하나도 없으면 보정할 영역이 없으므로 입력 그대로 반환 지시
            boxContext =
              "\n\n## 보정 대상 박스 목록: 없음\n\n박스 목록이 비어있으므로 **어떤 영역도 변경하지 말고 입력 이미지를 픽셀 단위로 그대로 반환** 하라.";
          }

          const userContext = context ? `\n\n## 사용자 맥락\n${context}` : "";
          const prompt = `${ENHANCE_PROMPT}${boxContext}${userContext}`;

          // Gemini 입력: 보정 대상 이미지 1장 + 프롬프트.
          // 편집 전 원본(레퍼런스) 은 주지 않는다 — 주면 Gemini 가 자주 "편집 전 상태" 로 되돌려버림.
          const parts = [
            { inline_data: { mime_type: "image/jpeg", data: image_base64 } },
            { text: prompt },
          ];

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
          });
        } catch (err) {
          console.error("[/api/enhance]", err);
          sendJson(500, { error: String(err?.message ?? err) });
        }
      });

      // Gemini 물체 마스크 생성 엔드포인트 — 박스 내 물체 픽셀만 흰색 표시한 이진 마스크 반환
      server.middlewares.use("/api/segment", async (req, res, next) => {
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
          const { image_base64, target, bbox } = body;
          if (!image_base64) return sendJson(400, { error: "image_base64 required" });
          if (typeof target !== "string" || !target.trim()) {
            return sendJson(400, { error: "target (물체 이름) required" });
          }

          const apiKey = process.env.GEMINI_API_KEY;
          if (!apiKey) {
            return sendJson(500, { error: "GEMINI_API_KEY not set in .env" });
          }
          const modelId = process.env.GEMINI_MODEL_ID ?? "gemini-3.1-flash-image-preview";

          if (!existsSync(capturesDir)) mkdirSync(capturesDir, { recursive: true });
          const capture_id = timestampId();
          writeFileSync(
            join(capturesDir, `${capture_id}-for-mask.jpg`),
            Buffer.from(image_base64, "base64")
          );

          // bbox 있으면 프롬프트에 위치 힌트 추가 (정규화 좌표 0~1, 좌상단 원점)
          let bboxContext = "";
          if (Array.isArray(bbox) && bbox.length === 4) {
            const [x1, y1, x2, y2] = bbox.map(Number);
            if ([x1, y1, x2, y2].every(Number.isFinite)) {
              bboxContext =
                `\n\n**위치 힌트**: 대상 "${target}" 은 이미지의 정규화 좌표 ` +
                `[x1=${x1.toFixed(3)}, y1=${y1.toFixed(3)}, x2=${x2.toFixed(3)}, y2=${y2.toFixed(3)}] ` +
                `(좌상단 원점, 0~1 범위) 영역 안에 있다. 이 영역 주변의 "${target}" 픽셀만 흰색으로.`;
            }
          }

          const prompt =
            SEGMENT_PROMPT.replace(/\{target\}/g, target.trim()) + bboxContext;

          const parts = [
            { inline_data: { mime_type: "image/jpeg", data: image_base64 } },
            { text: prompt },
          ];

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
          const geminiResp = await withTimeout(geminiCall, 40000, "Gemini");

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
            return sendJson(502, { error: "Gemini 응답에 마스크 이미지가 없음" });
          }
          const mask_base64 = inline.data;
          const mask_mime = inline.mime_type ?? inline.mimeType ?? "image/png";
          const ext = mask_mime.includes("png") ? "png" : "jpg";
          writeFileSync(
            join(capturesDir, `${capture_id}-mask.${ext}`),
            Buffer.from(mask_base64, "base64")
          );

          sendJson(200, {
            capture_id,
            mask_base64,
            mask_mime,
            target: target.trim(),
            elapsed_ms: Date.now() - started,
          });
        } catch (err) {
          console.error("[/api/segment]", err);
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
