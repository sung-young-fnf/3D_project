import * as THREE from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import {
  SparkRenderer,
  SplatMesh,
  SparkControls,
} from "@sparkjsdev/spark";
import { VmdEditor } from "./editor.js";

// ─── 씬 셋업 ─────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 1.6, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
document.body.appendChild(renderer.domElement);

// CSS2D 라벨 렌더러 — 3D 박스 위에 HTML 라벨 오버레이
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.left = "0";
labelRenderer.domElement.style.pointerEvents = "none";
document.body.appendChild(labelRenderer.domElement);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

const controls = new SparkControls({ canvas: renderer.domElement });

// 조명
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(2, 3, 1);
scene.add(dirLight);

// ─── Splat 로딩 ─────────────────────────────────────────
const splat = new SplatMesh({ url: "/space.spz" });
scene.add(splat);

let editor = null;

splat.initialized.then(() => {
  document.getElementById("loading").classList.add("hidden");
  console.log("Splat loaded!", splat.numSplats, "splats");

  // Splat 로드 후 에디터 초기화
  editor = new VmdEditor(splat, scene, camera, renderer);
  // 콘솔에서 튜닝용 접근 (editor.setSoftEdge(0.2) 등)
  window.editor = editor;
  window.captureCanvas = captureCanvas;
  updateUI();
});

// ─── 모드 관리 ───────────────────────────────────────────
let currentMode = "camera";

function setMode(mode) {
  currentMode = mode;
  if (editor) editor.mode = mode;

  // SparkControls 활성/비활성
  const isCam = mode === "camera";
  controls.fpsMovement.enable = isCam;
  controls.pointerControls.enable = isCam;

  // 커서
  switch (mode) {
    case "camera":
      renderer.domElement.style.cursor = "default";
      break;
    case "select":
      renderer.domElement.style.cursor = "crosshair";
      break;
    case "move":
    case "anchor":
      renderer.domElement.style.cursor = "grab";
      break;
  }

  updateModeUI();
}

// ─── 키보드 이벤트 ───────────────────────────────────────
function isTypingInInput() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

window.addEventListener("keydown", (e) => {
  // 보정 모달 열려있으면 최우선 처리 (ESC 만)
  const modal = document.getElementById("enhance-modal");
  if (modal && !modal.classList.contains("hidden")) {
    if (e.key === "Escape") {
      closeEnhanceModal();
      e.preventDefault();
    }
    return;
  }
  // 입력 필드 포커스 중엔 단축키(B/V/ESC/Delete)·mode switch 무시
  if (isTypingInInput()) return;

  // 모드 전환은 항상 동작
  switch (e.key.toLowerCase()) {
    case "b":
      if (currentMode !== "select") setMode("select");
      return;
    case "v":
      if (currentMode !== "move") setMode("move");
      return;
    case "x":
      if (currentMode !== "anchor") setMode("anchor");
      return;
    case "z":
      toggleWire();
      return;
    case "escape":
      setMode("camera");
      return;
    case "delete":
    case "backspace":
      if (currentMode !== "camera" && editor) {
        editor.removeActiveBox();
        updateUI();
      }
      return;
  }
});

// ─── UI 업데이트 ─────────────────────────────────────────
const modeButtons = {
  camera: document.getElementById("btn-camera"),
  select: document.getElementById("btn-select"),
  move: document.getElementById("btn-move"),
  anchor: document.getElementById("btn-anchor"),
};

function updateModeUI() {
  Object.entries(modeButtons).forEach(([mode, btn]) => {
    if (!btn) return;
    btn.classList.toggle("active", mode === currentMode);
  });
  document.getElementById("mode-hint").textContent = {
    camera: "WASD 이동 | 마우스 시점 변경",
    select: "드래그로 BOX 영역 크기 지정 | ESC 취소",
    move: "BOX 드래그로 내부 객체 이동 | Shift+드래그 높이 조절 | ESC 취소",
    anchor: "BOX 드래그로 박스 자체 재배치 | Shift+드래그 높이 조절 | ESC 취소",
  }[currentMode];
}

function updateUI() {
  updateModeUI();
  updateBoxList();
  updatePropertyPanel();
}

// ─── 영역 목록 패널 ──────────────────────────────────────
const MASK_BADGE = {
  none: "",
  pending: " ⏳",
  ready: " ✅",
  error: " ❌",
};

function updateBoxList() {
  const list = document.getElementById("box-list");
  if (!list || !editor) return;

  list.innerHTML = "";
  editor.boxes.forEach((box) => {
    const item = document.createElement("div");
    item.className = "box-item" + (box === editor.activeBox ? " active" : "");
    item.textContent = box.name + (MASK_BADGE[box.maskStatus] ?? "");
    item.title =
      box.maskStatus === "error"
        ? `마스크 에러: ${box.maskStatusMessage}`
        : box.maskStatus === "ready"
        ? "마스크 적용됨"
        : box.maskStatus === "pending"
        ? "마스크 생성 중"
        : "마스크 없음";
    item.addEventListener("click", () => {
      editor.selectBox(box);
      updateUI();
    });
    list.appendChild(item);
  });
}

// ─── 속성 패널 ───────────────────────────────────────────
const sizeInputs = {
  x: document.getElementById("size-x"),
  y: document.getElementById("size-y"),
  z: document.getElementById("size-z"),
};
const sizeVals = {
  x: document.getElementById("val-x"),
  y: document.getElementById("val-y"),
  z: document.getElementById("val-z"),
};
const scaleInputs = {
  x: document.getElementById("scale-x"),
  y: document.getElementById("scale-y"),
  z: document.getElementById("scale-z"),
};
const scaleVals = {
  x: document.getElementById("val-scale-x"),
  y: document.getElementById("val-scale-y"),
  z: document.getElementById("val-scale-z"),
};

function updatePropertyPanel() {
  const panel = document.getElementById("property-panel");
  if (!panel) return;

  if (!editor || !editor.activeBox) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const box = editor.activeBox;
  const nameInput = document.getElementById("prop-name-input");
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = box.name;
  }

  ["x", "y", "z"].forEach((axis) => {
    const sizeStr = box.size[axis].toFixed(2);
    if (sizeInputs[axis]) sizeInputs[axis].value = sizeStr;
    if (sizeVals[axis]) sizeVals[axis].textContent = sizeStr;

    const scaleStr = box.scaleFactor[axis].toFixed(2);
    if (scaleInputs[axis]) scaleInputs[axis].value = scaleStr;
    if (scaleVals[axis]) scaleVals[axis].textContent = scaleStr;
  });

  const disp = box.displacement;
  document.getElementById("disp-value").textContent =
    `X: ${disp.x.toFixed(2)}  Y: ${disp.y.toFixed(2)}  Z: ${disp.z.toFixed(2)}`;

  // 마스크 상태
  const maskStatusEl = document.getElementById("mask-status");
  const btnGen = document.getElementById("btn-mask-generate");
  const btnPrev = document.getElementById("btn-mask-preview");
  const btnClr = document.getElementById("btn-mask-clear");
  if (maskStatusEl) {
    maskStatusEl.className = `mask-status ${box.maskStatus}`;
    maskStatusEl.textContent = {
      none: "없음",
      pending: "생성 중...",
      ready: `적용됨${box.maskImageSize ? ` (${box.maskImageSize.w}×${box.maskImageSize.h})` : ""}`,
      error: `에러: ${box.maskStatusMessage || "알 수 없음"}`,
    }[box.maskStatus] || "없음";
  }
  if (btnGen) {
    btnGen.textContent = box.maskStatus === "ready" ? "재생성" : "생성";
    btnGen.disabled = box.maskStatus === "pending";
  }
  if (btnPrev) btnPrev.disabled = !box.hasMask;
  if (btnClr) btnClr.disabled = !box.hasMask && box.maskStatus !== "error";
}

// 탭1: 영역 크기 슬라이더
["x", "y", "z"].forEach((axis) => {
  const input = sizeInputs[axis];
  if (!input) return;
  input.addEventListener("input", () => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0 && editor) {
      editor.updateActiveBoxSize(axis, val);
      if (sizeVals[axis]) sizeVals[axis].textContent = val.toFixed(2);
    }
  });
});

// 탭2: 객체 스케일 슬라이더
["x", "y", "z"].forEach((axis) => {
  const input = scaleInputs[axis];
  if (!input) return;
  input.addEventListener("input", () => {
    const val = parseFloat(input.value);
    if (!isNaN(val) && val > 0 && editor) {
      editor.updateActiveBoxScale(axis, val);
      if (scaleVals[axis]) scaleVals[axis].textContent = val.toFixed(2);
    }
  });
});

// 박스 이름 편집 — Claude 명령 매칭을 위해 사용자가 자유 명명
const propNameInput = document.getElementById("prop-name-input");
propNameInput?.addEventListener("input", () => {
  if (!editor?.activeBox) return;
  editor.activeBox.setName(propNameInput.value);
  updateBoxList();
});
propNameInput?.addEventListener("focus", () => {
  controls.fpsMovement.enable = false;
});
propNameInput?.addEventListener("blur", () => {
  if (editor?.activeBox) {
    const trimmed = propNameInput.value.trim();
    if (!trimmed) {
      const fallback = `영역 ${editor.activeBox.id}`;
      editor.activeBox.setName(fallback);
      propNameInput.value = fallback;
      updateBoxList();
    }
  }
  if (currentMode === "camera") {
    controls.fpsMovement.enable = true;
  }
});

// 탭 전환
document.querySelectorAll(".prop-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    document.querySelectorAll(".prop-tab").forEach((t) =>
      t.classList.toggle("active", t === tab)
    );
    document.querySelectorAll(".prop-tab-content").forEach((c) => {
      c.classList.toggle("hidden", c.dataset.content !== target);
    });
  });
});

// 삭제 버튼
document.getElementById("btn-delete")?.addEventListener("click", () => {
  if (editor) {
    editor.removeActiveBox();
    updateUI();
  }
});

// ─── 마스크 버튼 (🎭 생성 / 미리보기 / 제거) ─────────────
document.getElementById("btn-mask-generate")?.addEventListener("click", () => {
  if (!editor?.activeBox) return;
  requestSegmentForBox(editor.activeBox);
});

document.getElementById("btn-mask-clear")?.addEventListener("click", () => {
  if (!editor?.activeBox) return;
  editor.activeBox.clearMask();
  editor._syncBoxUniforms();
  editor.splatMesh.updateVersion();
  updateUI();
});

document.getElementById("btn-mask-preview")?.addEventListener("click", () => {
  const box = editor?.activeBox;
  if (!box || !box.mask || !box.mask.image) return;
  const existing = document.getElementById("mask-preview-popup");
  if (existing) existing.remove();
  const wrap = document.createElement("div");
  wrap.id = "mask-preview-popup";
  wrap.style.cssText =
    "position:fixed;top:20px;right:20px;z-index:9999;background:#111;" +
    "border:2px solid #caf;padding:6px;border-radius:6px;max-width:380px;";
  const title = document.createElement("div");
  title.style.cssText = "color:#caf;font-size:0.7rem;margin-bottom:4px;";
  title.textContent = `마스크: ${box.name} (클릭해서 닫기)`;
  const imgEl = document.createElement("img");
  imgEl.src = box.mask.image.src || "";
  imgEl.style.cssText = "max-width:100%;display:block;background:#000;";
  wrap.appendChild(title);
  wrap.appendChild(imgEl);
  wrap.onclick = () => wrap.remove();
  document.body.appendChild(wrap);
});

// 모드 버튼 클릭
document.getElementById("btn-camera")?.addEventListener("click", () => setMode("camera"));
document.getElementById("btn-select")?.addEventListener("click", () => setMode("select"));
document.getElementById("btn-move")?.addEventListener("click", () => setMode("move"));
document.getElementById("btn-anchor")?.addEventListener("click", () => setMode("anchor"));

// 박스 와이어프레임 표시 토글 (Z 키 / 버튼)
const btnWire = document.getElementById("btn-wire");
function toggleWire() {
  if (!editor) return;
  const visible = editor.toggleWireframes();
  btnWire?.classList.toggle("active", visible);
}
btnWire?.addEventListener("click", toggleWire);

// ─── Claude 물체 감지 ────────────────────────────────────
const claudeInput = document.getElementById("claude-target");
const btnClaude = document.getElementById("btn-claude");
const btnClaudeAll = document.getElementById("btn-claude-all");
const btnClaudeCmd = document.getElementById("btn-claude-cmd");
const claudeStatus = document.getElementById("claude-status");

function setClaudeStatus(cls, text) {
  if (!claudeStatus) return;
  claudeStatus.className = cls;
  claudeStatus.textContent = text;
}

function updateClaudeButton() {
  const hasText = !!claudeInput?.value.trim();
  if (btnClaude) btnClaude.disabled = !hasText;
  if (btnClaudeCmd) btnClaudeCmd.disabled = !hasText;
}

// 호출 중 실시간 경과 시간 카운터 — 100ms 간격으로 상태 텍스트 갱신
function startElapsedTicker(label) {
  const start = performance.now();
  const fmt = () => ((performance.now() - start) / 1000).toFixed(1);
  const tick = () => setClaudeStatus("loading", `${label} ${fmt()}s`);
  tick();
  const id = setInterval(tick, 100);
  return { stop: () => clearInterval(id), elapsed: fmt };
}

async function captureCanvas() {
  // preserveDrawingBuffer=false 환경에서 compositor 가 drawingBuffer 를 삼키기 전
  // render → drawImage → toDataURL 을 한 rAF 콜백 안에서 동기 실행해야 안정적이다.
  return new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      try {
        renderer.render(scene, camera);
        const src = renderer.domElement;
        const maxDim = 1600;
        const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
        const dw = Math.round(src.width * scale);
        const dh = Math.round(src.height * scale);
        const off = document.createElement("canvas");
        off.width = dw;
        off.height = dh;
        off.getContext("2d").drawImage(src, 0, 0, dw, dh);
        const dataUrl = off.toDataURL("image/jpeg", 0.85);
        if (!dataUrl || dataUrl.length < 200) {
          reject(new Error("캔버스 캡처 결과가 비어있음"));
          return;
        }
        resolve(dataUrl.split(",")[1]);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// ─── Phase 2: 마스크 요청 유틸 ────────────────────────────
// 박스 하나에 대해 /api/segment 호출 + 결과를 THREE.Texture 로 변환 + BoxRegion 에 저장.
// 병렬 호출 대응을 위해 박스 단위 상태만 갱신 (claudeStatus 는 건드리지 않음).
async function requestSegmentForBox(box, { quiet = false } = {}) {
  if (!box) return { ok: false, reason: "박스 없음" };
  const name = (box.name || "").trim();
  // "영역 1" 같은 기본 이름은 segmentation 대상으로 부적절
  if (!name || /^영역\s*\d+$/.test(name)) {
    box.maskStatus = "error";
    box.maskStatusMessage = "이름을 먼저 지정하세요";
    updateUI();
    return { ok: false, reason: box.maskStatusMessage };
  }

  box.maskStatus = "pending";
  box.maskStatusMessage = "";
  updateUI();

  try {
    const image_base64 = await captureCanvas();
    // 캡처 시점 카메라 matrix 사본 — 이후 카메라가 움직여도 이 값으로 역투영
    const viewMatrix = camera.matrixWorldInverse.clone();
    const projMatrix = camera.projectionMatrix.clone();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 65000);

    const resp = await fetch("/api/segment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64, target: name }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    const texture = await loadMaskTexture(data.mask_base64, data.mask_mime);
    const w = texture.image.naturalWidth || texture.image.width;
    const h = texture.image.naturalHeight || texture.image.height;

    box.setMask(texture, viewMatrix, projMatrix, { w, h }, data.capture_id);
    // 슬롯 uniform 전체 재동기화 — 활성 박스 아니어도 슬롯 N 번에 들어가 있음
    editor._syncBoxUniforms();
    editor.splatMesh.updateVersion();
    updateUI();
    if (!quiet) {
      console.log(`[segment] "${name}" ready (${data.capture_id}, ${w}x${h})`);
    }
    return { ok: true, capture_id: data.capture_id };
  } catch (err) {
    box.maskStatus = "error";
    box.maskStatusMessage = err.name === "AbortError" ? "시간 초과" : (err.message || String(err));
    updateUI();
    if (!quiet) console.warn(`[segment] "${name}" failed:`, box.maskStatusMessage);
    return { ok: false, reason: box.maskStatusMessage };
  }
}

// 마스크 base64 → THREE.Texture 로드 (DataTexture 대신 Image 기반 — 알파 채널 보존 가능)
async function loadMaskTexture(mask_base64, mime = "image/png") {
  const dataUrl = `data:${mime};base64,${mask_base64}`;
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("마스크 이미지 로드 실패"));
    img.src = dataUrl;
  });
  const texture = new THREE.Texture(img);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.flipY = false; // 셰이더에서 UV 계산 일관성 위해
  texture.needsUpdate = true;
  return texture;
}

async function callClaudeDetect(target, mode) {
  if (!editor) {
    setClaudeStatus("error", "아직 splat 로딩 중...");
    return;
  }
  const targetValue = (target ?? "").trim();
  if (mode === "target" && !targetValue) return;

  if (btnClaude) btnClaude.disabled = true;
  if (btnClaudeAll) btnClaudeAll.disabled = true;

  const ticker = startElapsedTicker("분석 중...");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 65000);

  try {
    const image_base64 = await captureCanvas();
    const resp = await fetch("/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64,
        mode,
        target: targetValue || undefined,
      }),
      signal: controller.signal,
    });
    const data = await resp.json();
    const elapsed = ticker.elapsed();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    const dets = data.detections ?? [];
    let created = 0;
    const newBoxes = [];
    for (const d of dets) {
      const box = editor.createBoxFromScreenBBox(d.bbox);
      if (box) {
        if (d.label) box.setName(d.label);
        created++;
        newBoxes.push(box);
      }
    }
    setClaudeStatus(
      "ok",
      `감지 ${dets.length}건 → 박스 ${created}개 (${elapsed}s) · 마스크 생성 중...`
    );
    updateUI();

    // Claude 자동 박스는 segmentation 도 자동. 병렬 호출, 각자 끝나는 대로 UI 갱신.
    // await Promise.all 로 기다려 전체 상태를 표시하되, 하나 실패해도 다른 건 계속.
    if (newBoxes.length > 0) {
      const segResults = await Promise.all(
        newBoxes.map((b) => requestSegmentForBox(b, { quiet: true }))
      );
      const okCount = segResults.filter((r) => r.ok).length;
      setClaudeStatus(
        okCount === newBoxes.length ? "ok" : "loading",
        `감지 ${dets.length}건 · 박스 ${created} · 마스크 ${okCount}/${newBoxes.length} (${ticker.elapsed()}s)`
      );
    }
  } catch (err) {
    const elapsed = ticker.elapsed();
    if (err.name === "AbortError") {
      setClaudeStatus("error", `시간 초과 (${elapsed}s)`);
    } else {
      setClaudeStatus("error", `에러: ${err.message} (${elapsed}s)`);
    }
  } finally {
    ticker.stop();
    clearTimeout(timeoutId);
    if (btnClaudeAll) btnClaudeAll.disabled = false;
    updateClaudeButton();
  }
}

claudeInput?.addEventListener("input", updateClaudeButton);
claudeInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && btnClaude && !btnClaude.disabled) {
    e.preventDefault();
    btnClaude.click();
  }
});

// 자연어 명령 실행 (박스 swap 등)
async function callClaudeCommand(text) {
  if (!editor) {
    setClaudeStatus("error", "아직 splat 로딩 중...");
    return;
  }
  const t = (text ?? "").trim();
  if (!t) return;

  const boxes = editor.boxes.map((b) => ({ id: b.id, name: b.name }));
  if (boxes.length < 2) {
    setClaudeStatus("error", "박스가 2개 이상 필요합니다");
    return;
  }

  if (btnClaude) btnClaude.disabled = true;
  if (btnClaudeAll) btnClaudeAll.disabled = true;
  if (btnClaudeCmd) btnClaudeCmd.disabled = true;

  const ticker = startElapsedTicker("명령 해석 중...");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35000);

  try {
    const resp = await fetch("/api/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, boxes }),
      signal: controller.signal,
    });
    const data = await resp.json();
    const elapsed = ticker.elapsed();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    if (data.action === "swap" && Array.isArray(data.targets) && data.targets.length === 2) {
      const ok = editor.swapBoxesById(data.targets[0], data.targets[1]);
      if (ok) {
        const why = data.reason ? ` · ${data.reason}` : "";
        setClaudeStatus("ok", `swap 완료 (${elapsed}s)${why}`);
        updateUI();
      } else {
        setClaudeStatus("error", `swap 실패: 박스 id 불일치`);
      }
    } else {
      setClaudeStatus(
        "error",
        data.reason ? `해석 실패: ${data.reason}` : "명령 해석 실패"
      );
    }
  } catch (err) {
    const elapsed = ticker.elapsed();
    if (err.name === "AbortError") {
      setClaudeStatus("error", `시간 초과 (${elapsed}s)`);
    } else {
      setClaudeStatus("error", `에러: ${err.message} (${elapsed}s)`);
    }
  } finally {
    ticker.stop();
    clearTimeout(timeoutId);
    if (btnClaudeAll) btnClaudeAll.disabled = false;
    updateClaudeButton();
  }
}
// 입력 포커스 중엔 SparkControls WASD/QE 이동을 비활성 (mode=camera 일 때만 원복)
claudeInput?.addEventListener("focus", () => {
  controls.fpsMovement.enable = false;
});
claudeInput?.addEventListener("blur", () => {
  if (currentMode === "camera") {
    controls.fpsMovement.enable = true;
  }
});
btnClaude?.addEventListener("click", () =>
  callClaudeDetect(claudeInput?.value, "target")
);
btnClaudeAll?.addEventListener("click", () => callClaudeDetect(null, "all"));
btnClaudeCmd?.addEventListener("click", () => callClaudeCommand(claudeInput?.value));

// ─── 🎨 보정 (Gemini 이미지 향상) ───────────────────────
const btnClaudeEnhance = document.getElementById("btn-claude-enhance");
const enhanceModal = document.getElementById("enhance-modal");
const enhanceImg = document.getElementById("enhance-img");
const enhanceInfo = document.getElementById("enhance-info");
const btnEnhanceCompare = document.getElementById("btn-enhance-compare");
const btnEnhanceSave = document.getElementById("btn-enhance-save");

let enhanceState = {
  originalDataUrl: null,
  enhancedDataUrl: null,
  filename: null,
  showingOriginal: false,
};

function openEnhanceModal({ originalDataUrl, enhancedDataUrl, info, filename, isError }) {
  enhanceState = {
    originalDataUrl: originalDataUrl ?? null,
    enhancedDataUrl: enhancedDataUrl ?? null,
    filename: filename ?? null,
    showingOriginal: false,
  };
  enhanceImg.src = enhancedDataUrl || originalDataUrl || "";
  enhanceInfo.textContent = info ?? "";
  enhanceInfo.className = isError ? "error" : "";
  btnEnhanceCompare.disabled = !enhancedDataUrl || !originalDataUrl;
  btnEnhanceCompare.classList.remove("active");
  btnEnhanceCompare.textContent = "원본 비교";
  btnEnhanceSave.disabled = !enhancedDataUrl;
  enhanceModal.classList.remove("hidden");
}

function closeEnhanceModal() {
  enhanceModal.classList.add("hidden");
  enhanceImg.src = "";
  enhanceState = { originalDataUrl: null, enhancedDataUrl: null, filename: null, showingOriginal: false };
}

document.querySelector(".enhance-close")?.addEventListener("click", closeEnhanceModal);
document.querySelector(".enhance-backdrop")?.addEventListener("click", closeEnhanceModal);

btnEnhanceCompare?.addEventListener("click", () => {
  if (!enhanceState.originalDataUrl || !enhanceState.enhancedDataUrl) return;
  enhanceState.showingOriginal = !enhanceState.showingOriginal;
  enhanceImg.src = enhanceState.showingOriginal
    ? enhanceState.originalDataUrl
    : enhanceState.enhancedDataUrl;
  btnEnhanceCompare.classList.toggle("active", enhanceState.showingOriginal);
  btnEnhanceCompare.textContent = enhanceState.showingOriginal ? "보정본 보기" : "원본 비교";
});

btnEnhanceSave?.addEventListener("click", () => {
  const url = enhanceState.showingOriginal
    ? enhanceState.originalDataUrl
    : enhanceState.enhancedDataUrl;
  if (!url || !enhanceState.filename) return;
  const a = document.createElement("a");
  a.href = url;
  a.download = enhanceState.showingOriginal
    ? enhanceState.filename.replace(/-enhanced\.(png|jpg)$/, ".jpg")
    : enhanceState.filename;
  a.click();
});

async function callEnhance(context = "") {
  if (!editor) {
    setClaudeStatus("error", "아직 splat 로딩 중...");
    return;
  }

  if (btnClaude) btnClaude.disabled = true;
  if (btnClaudeAll) btnClaudeAll.disabled = true;
  if (btnClaudeCmd) btnClaudeCmd.disabled = true;
  if (btnClaudeEnhance) btnClaudeEnhance.disabled = true;

  const ticker = startElapsedTicker("보정 중...");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55000);

  // 박스 목록 + moved 플래그 (displacement 또는 scale 조정된 박스) 서버로 전달
  const boxes = editor.boxes.map((b) => ({
    name: b.name,
    moved:
      b.displacement.lengthSq() > 0.0001 ||
      Math.abs(b.scaleFactor.x - 1) > 0.01 ||
      Math.abs(b.scaleFactor.y - 1) > 0.01 ||
      Math.abs(b.scaleFactor.z - 1) > 0.01,
  }));

  let originalBase64 = null;
  try {
    originalBase64 = await captureCanvas();
    const resp = await fetch("/api/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_base64: originalBase64,
        context,
        boxes,
      }),
      signal: controller.signal,
    });
    const data = await resp.json();
    const elapsed = ticker.elapsed();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    const mime = data.enhanced_mime || "image/png";
    const ext = mime.includes("png") ? "png" : "jpg";
    openEnhanceModal({
      originalDataUrl: `data:image/jpeg;base64,${originalBase64}`,
      enhancedDataUrl: `data:${mime};base64,${data.enhanced_base64}`,
      info: `${data.capture_id} · ${elapsed}s`,
      filename: `${data.capture_id}-enhanced.${ext}`,
    });
    setClaudeStatus("ok", `보정 완료 (${elapsed}s)`);
  } catch (err) {
    const elapsed = ticker.elapsed();
    const msg =
      err.name === "AbortError"
        ? `시간 초과 (${elapsed}s)`
        : `에러: ${err.message} (${elapsed}s)`;
    setClaudeStatus("error", msg);
    if (originalBase64) {
      openEnhanceModal({
        originalDataUrl: `data:image/jpeg;base64,${originalBase64}`,
        enhancedDataUrl: null,
        info: msg,
        filename: null,
        isError: true,
      });
    }
  } finally {
    ticker.stop();
    clearTimeout(timeoutId);
    if (btnClaudeAll) btnClaudeAll.disabled = false;
    if (btnClaudeEnhance) btnClaudeEnhance.disabled = false;
    updateClaudeButton();
  }
}

btnClaudeEnhance?.addEventListener("click", () => callEnhance());

// ─── 포인터 이벤트 후처리 (UI 갱신) ─────────────────────
renderer.domElement.addEventListener("pointerup", () => {
  setTimeout(() => updateUI(), 0);
});

// ─── 렌더 루프 ───────────────────────────────────────────
renderer.setAnimationLoop(function animate() {
  if (currentMode === "camera") {
    controls.update(camera);
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

// ─── 리사이즈 ────────────────────────────────────────────
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});
