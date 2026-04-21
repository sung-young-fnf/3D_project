import * as THREE from "three";
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
function updateBoxList() {
  const list = document.getElementById("box-list");
  if (!list || !editor) return;

  list.innerHTML = "";
  editor.boxes.forEach((box) => {
    const item = document.createElement("div");
    item.className = "box-item" + (box === editor.activeBox ? " active" : "");
    item.textContent = box.name;
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
  document.getElementById("prop-name").textContent = box.name;

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

// 모드 버튼 클릭
document.getElementById("btn-camera")?.addEventListener("click", () => setMode("camera"));
document.getElementById("btn-select")?.addEventListener("click", () => setMode("select"));
document.getElementById("btn-move")?.addEventListener("click", () => setMode("move"));
document.getElementById("btn-anchor")?.addEventListener("click", () => setMode("anchor"));

// ─── Claude 물체 감지 ────────────────────────────────────
const claudeInput = document.getElementById("claude-target");
const btnClaude = document.getElementById("btn-claude");
const btnClaudeAll = document.getElementById("btn-claude-all");
const claudeStatus = document.getElementById("claude-status");

function setClaudeStatus(cls, text) {
  if (!claudeStatus) return;
  claudeStatus.className = cls;
  claudeStatus.textContent = text;
}

function updateClaudeButton() {
  if (!btnClaude || !claudeInput) return;
  btnClaude.disabled = !claudeInput.value.trim();
}

async function captureCanvas() {
  // preserveDrawingBuffer=false 이므로 즉시 한 프레임 강제 렌더 후 복사
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
  const blob = await new Promise((r) => off.toBlob(r, "image/jpeg", 0.85));
  if (!blob) throw new Error("캔버스 캡처 실패");
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("base64 인코딩 실패"));
    reader.readAsDataURL(blob);
  });
  return dataUrl.split(",")[1];
}

async function callClaudeDetect(target, mode) {
  if (!editor) {
    setClaudeStatus("error", "아직 splat 로딩 중...");
    return;
  }
  const targetValue = (target ?? "").trim();
  if (mode === "target" && !targetValue) return;

  setClaudeStatus("loading", "분석 중...");
  if (btnClaude) btnClaude.disabled = true;
  if (btnClaudeAll) btnClaudeAll.disabled = true;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 65000);
  const startTime = performance.now();
  const fmtElapsed = () => ((performance.now() - startTime) / 1000).toFixed(1);

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
    const elapsed = fmtElapsed();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

    const dets = data.detections ?? [];
    let created = 0;
    for (const d of dets) {
      const box = editor.createBoxFromScreenBBox(d.bbox);
      if (box) {
        if (d.label) box.name = `${box.name} · ${d.label}`;
        created++;
      }
    }
    setClaudeStatus(
      "ok",
      `감지 ${dets.length}건 → 박스 ${created}개 (${elapsed}s)`
    );
    updateUI();
  } catch (err) {
    const elapsed = fmtElapsed();
    if (err.name === "AbortError") {
      setClaudeStatus("error", `시간 초과 (${elapsed}s)`);
    } else {
      setClaudeStatus("error", `에러: ${err.message} (${elapsed}s)`);
    }
  } finally {
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
});

// ─── 리사이즈 ────────────────────────────────────────────
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
