import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  SplatEdit,
  SplatEditSdf,
  SplatEditSdfType,
  dyno,
} from "@sparkjsdev/spark";

// ─── 단일 BOX 영역 ─────────────────────────────────────────
class BoxRegion {
  constructor(name, position, size, sharedEdit, scene, dummyMask) {
    this.id = null; // VmdEditor 가 createBox 에서 할당
    this.name = name;
    this.size = size.clone();
    this.originalSize = size.clone(); // 고정 AABB (splat 스케일 판정 범위)
    this.originPosition = position.clone();
    this.displacement = new THREE.Vector3(0, 0, 0);
    this.scaleFactor = new THREE.Vector3(1, 1, 1); // 객체 스케일 배율
    this.sharedEdit = sharedEdit;

    // ── Phase 2: segmentation 마스크 ──
    // 마스크는 "생성 시점 카메라" 기준 2D 이미지. 이후 카메라가 바뀌어도
    // 이 matrix 로 Gaussian 을 역투영해 UV 조회 → 물체/배경 판정.
    this.mask = null;                // THREE.Texture
    this.viewMatrix = null;          // THREE.Matrix4 (capture 시점)
    this.projMatrix = null;          // THREE.Matrix4
    this.maskImageSize = null;       // { w, h } — 마스크 원본 해상도
    this.hasMask = false;
    this.maskStatus = "none";        // "none" | "pending" | "ready" | "error"
    this.maskStatusMessage = "";     // 에러 메시지 보관용
    this.maskCaptureId = null;       // 서버 capture_id (디버그)

    // SplatEditSdf만 생성 → 공용 SplatEdit에 추가
    // (박스마다 SplatEdit을 따로 만들면 GPU에서 순차 적용돼
    //  다른 박스의 displace 결과가 이 박스의 SDF 판정에 간섭함 → 복제처럼 보임)
    this.sdf = new SplatEditSdf({
      type: SplatEditSdfType.BOX,
      radius: 0,
      displace: new THREE.Vector3(0, 0, 0),
    });
    this.sdf.position.copy(position);
    this.sdf.scale.copy(size);
    sharedEdit.add(this.sdf);

    // 와이어프레임 시각화
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const edges = new THREE.EdgesGeometry(geo);
    this.wireframe = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
      })
    );
    this.wireframe.position.copy(position);
    this.wireframe.scale.copy(size);
    this.wireframe.renderOrder = 999;
    scene.add(this.wireframe);

    // 클릭 감지용 투명 히트박스
    const hitGeo = new THREE.BoxGeometry(1, 1, 1);
    const hitMat = new THREE.MeshBasicMaterial({
      visible: false,
      side: THREE.DoubleSide,
    });
    this.hitbox = new THREE.Mesh(hitGeo, hitMat);
    this.hitbox.position.copy(position);
    this.hitbox.scale.copy(size);
    this.hitbox.userData.boxRegion = this;
    scene.add(this.hitbox);

    // Fill mesh — 박스 원위치에 배치, 이동 시 visible.
    //   ShaderMaterial 로 각 픽셀을 마스크 캡처 시점 카메라로 역투영 →
    //   마스크 "물체" 영역만 색 칠하고 나머지는 discard.
    //   → 박스 AABB 가 커도 Fill 은 실제 물체 실루엣 모양으로만 보임.
    //   마스크 없는 박스는 uHasMask=0 이라 박스 전체 색상자로 fallback.
    this.fillMesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: {
          uFillColor:      { value: new THREE.Color(0xa0a080) },
          uMask:           { value: dummyMask },
          uMaskViewMatrix: { value: new THREE.Matrix4() },
          uMaskProjMatrix: { value: new THREE.Matrix4() },
          uHasMask:        { value: 0.0 },
        },
        vertexShader: `
          varying vec3 vWorldPos;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vWorldPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          uniform sampler2D uMask;
          uniform mat4 uMaskViewMatrix;
          uniform mat4 uMaskProjMatrix;
          uniform vec3 uFillColor;
          uniform float uHasMask;
          varying vec3 vWorldPos;
          void main() {
            if (uHasMask > 0.5) {
              vec4 clip = uMaskProjMatrix * uMaskViewMatrix * vec4(vWorldPos, 1.0);
              if (clip.w <= 0.0) discard;
              vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
              uv.y = 1.0 - uv.y;
              if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
              if (texture2D(uMask, uv).r < 0.5) discard;
            }
            gl_FragColor = vec4(uFillColor, 1.0);
          }
        `,
        side: THREE.FrontSide,
      })
    );
    this.fillMesh.position.copy(position);
    this.fillMesh.scale.copy(size);
    this.fillMesh.visible = false;
    this.fillColorSampled = false;
    scene.add(this.fillMesh);

    // CSS2D 라벨 — 박스 상단 왼쪽 모서리에 부착
    const labelDiv = document.createElement("div");
    labelDiv.className = "box-label";
    labelDiv.textContent = name;
    this.label = new CSS2DObject(labelDiv);
    // 라벨의 bottom-left 가 3D 점에 붙게 → 모서리 바로 위에 태그처럼 매달림
    this.label.center.set(0, 1);
    scene.add(this.label);
    this._updateLabelPos();
  }

  _updateLabelPos() {
    const worldPos = this.originPosition.clone().add(this.displacement);
    worldPos.x -= this.size.x * 0.5;
    worldPos.y += this.size.y * 0.5;
    // z 는 박스 중심 유지 (CSS2D 는 항상 카메라 향함)
    this.label.position.copy(worldPos);
  }

  setSelected(active) {
    this.wireframe.material.color.setHex(active ? 0xffff00 : 0x00ffff);
    this.wireframe.material.opacity = active ? 1.0 : 0.7;
    if (this.label) {
      this.label.element.classList.toggle("active", active);
    }
  }

  setDisplacement(d) {
    this.displacement.copy(d);
    // SDF displace 는 완전 폐기 — worldModifier 슬롯 루프가 displace 전담
    // sdf.displace 는 항상 0 유지 (생성자 기본값)
    const pos = this.originPosition.clone().add(d);
    this.wireframe.position.copy(pos);
    this.hitbox.position.copy(pos);
    // fillMesh 는 "원위치" 에 머문다 (이동된 박스 자리 메우는 용도)
    this.fillMesh.visible = d.lengthSq() > 0.0001 && !!this.fillEnabled;
    this._updateLabelPos();
  }

  updateSize(size) {
    this.size.copy(size);
    this.sdf.scale.copy(size);
    this.wireframe.scale.copy(size);
    this.hitbox.scale.copy(size);
    // fillMesh 는 원점 기준이므로 updateSize 에서도 scale 동기화
    this.fillMesh.scale.copy(size);
    this._updateLabelPos();
  }

  // 박스 원점(originPosition) 변경 — X 드래그에서 호출.
  // displacement/scaleFactor 는 유지, SDF·wireframe·hitbox 는 origin+displacement 로 재배치.
  setOrigin(newOrigin) {
    this.originPosition.copy(newOrigin);
    const worldPos = newOrigin.clone().add(this.displacement);
    this.sdf.position.copy(worldPos);
    this.wireframe.position.copy(worldPos);
    this.hitbox.position.copy(worldPos);
    // fillMesh 는 새 원점에 머무름
    this.fillMesh.position.copy(newOrigin);
    this._updateLabelPos();
  }

  setFillEnabled(on) {
    this.fillEnabled = !!on;
    this.fillMesh.visible = this.fillEnabled && this.displacement.lengthSq() > 0.0001;
  }

  setFillColor(hex) {
    this.fillMesh.material.uniforms.uFillColor.value.setHex(hex);
    this.fillColorSampled = true;
  }

  // 이름 변경 — name 프로퍼티 + 라벨 텍스트 동기화
  setName(name) {
    this.name = name;
    if (this.label) this.label.element.textContent = name;
  }

  // 마스크 텍스처 + 캡처 시점 카메라 matrix 저장. Phase 4 셰이더가 이를 참조.
  setMask(texture, viewMatrix, projMatrix, imageSize, captureId = null) {
    if (this.mask && this.mask !== texture) this.mask.dispose();
    this.mask = texture;
    this.viewMatrix = viewMatrix.clone();
    this.projMatrix = projMatrix.clone();
    this.maskImageSize = { w: imageSize.w, h: imageSize.h };
    this.hasMask = true;
    this.maskStatus = "ready";
    this.maskStatusMessage = "";
    this.maskCaptureId = captureId;
    // Fill Plane 에도 동일 마스크/matrix 주입 → 실루엣 모양으로만 Fill 표시
    const u = this.fillMesh.material.uniforms;
    u.uMask.value = texture;
    u.uMaskViewMatrix.value.copy(viewMatrix);
    u.uMaskProjMatrix.value.copy(projMatrix);
    u.uHasMask.value = 1.0;
  }

  clearMask() {
    if (this.mask) this.mask.dispose();
    this.mask = null;
    this.viewMatrix = null;
    this.projMatrix = null;
    this.maskImageSize = null;
    this.hasMask = false;
    this.maskStatus = "none";
    this.maskStatusMessage = "";
    this.maskCaptureId = null;
    // Fill Plane 을 박스 전체 색상자로 fallback
    const u = this.fillMesh.material.uniforms;
    u.uHasMask.value = 0.0;
  }

  remove(scene) {
    scene.remove(this.wireframe);
    scene.remove(this.hitbox);
    scene.remove(this.label);
    scene.remove(this.fillMesh);
    this.sharedEdit.remove(this.sdf);
    this.wireframe.geometry.dispose();
    this.wireframe.material.dispose();
    this.hitbox.geometry.dispose();
    this.hitbox.material.dispose();
    this.fillMesh.geometry.dispose();
    this.fillMesh.material.dispose();
    if (this.label) this.label.element.remove();
    if (this.mask) this.mask.dispose();
  }
}

// ─── VMD 에디터 ─────────────────────────────────────────────
export class VmdEditor {
  constructor(splatMesh, scene, camera, renderer) {
    this.splatMesh = splatMesh;
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;

    // 모든 박스가 공유하는 단일 SplatEdit
    // → 내부 SDF들이 softmax로 블렌딩돼 한 번만 평가됨 (상호 간섭 방지)
    // softEdge: SDF 경계 부근 ±값(월드 단위) 안의 Gaussian 은 displace 를 부분 적용.
    //   박스 중앙 깊이의 Gaussian(= 물체일 확률 높음) → full displace
    //   박스 경계 근처 Gaussian(= 배경이 섞였을 확률 높음) → smooth 부분 이동 (제자리에 가까움)
    //   → 박스에 딸려온 배경이 새 위치로 선명하게 따라가지 않도록 완화.
    this.softEdgeValue = 0.0;
    this.sharedEdit = new SplatEdit({
      name: "vmd-boxes",
      softEdge: this.softEdgeValue,
      sdfSmooth: 0,
    });
    splatMesh.add(this.sharedEdit);

    // ── 박스 통합 shader ──
    // 역할:
    //   1) scale: 활성 박스 AABB 내 Gaussian 을 중심 기준 scale 배율로 (단일 슬롯, 기존 객체 스케일)
    //   2) displace: N 개 슬롯 배열로 모든 박스 처리 — 각 슬롯은
    //      마스크 있으면 Z 박스 + XY 마스크 필터, 마스크 없으면 XYZ 박스 필터
    //   SplatEditSdf 의 displace 는 완전 폐기 (항상 0) — 모든 displace 는 여기서 처리
    this.MAX_BOXES = 8;

    // 더미 1×1 흰색 텍스처 — 마스크 없는 슬롯에 바인딩 (샘플 값 1.0)
    this.dummyMask = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      THREE.RGBAFormat
    );
    this.dummyMask.needsUpdate = true;

    // scale 은 활성 박스 하나만 적용 (기존 객체 스케일 탭 동작)
    this.scaleUniforms = {
      enable:   dyno.dynoFloat(0.0),
      center:   dyno.dynoVec3(new THREE.Vector3()),
      halfSize: dyno.dynoVec3(new THREE.Vector3(1, 1, 1)),
      scale:    dyno.dynoVec3(new THREE.Vector3(1, 1, 1)),
    };
    // 외부 호환 alias (기존 코드가 boxUniforms.scale 참조 가능성)
    this.boxUniforms = this.scaleUniforms;

    // displace 슬롯 N 개 (박스마다 하나씩 배정)
    this.boxSlots = [];
    for (let i = 0; i < this.MAX_BOXES; i++) {
      this.boxSlots.push({
        enable:     dyno.dynoFloat(0.0),
        center:     dyno.dynoVec3(new THREE.Vector3()),
        halfSize:   dyno.dynoVec3(new THREE.Vector3(1, 1, 1)),
        displace:   dyno.dynoVec3(new THREE.Vector3()),
        viewMatrix: dyno.dynoMat4(new THREE.Matrix4()),
        projMatrix: dyno.dynoMat4(new THREE.Matrix4()),
        mask:       dyno.dynoSampler2D(this.dummyMask),
        hasMask:    dyno.dynoFloat(0.0),
      });
    }

    // dyno inTypes / apply 용 키 평탄화 (slot 0..N-1 → enable0, center0, ...)
    const buildInTypes = () => {
      const t = {
        gsplat:        dyno.Gsplat,
        scaleEnable:   "float",
        scaleCenter:   "vec3",
        scaleHalfSize: "vec3",
        scaleValue:    "vec3",
      };
      for (let i = 0; i < this.MAX_BOXES; i++) {
        t[`enable${i}`]   = "float";
        t[`center${i}`]   = "vec3";
        t[`halfSize${i}`] = "vec3";
        t[`displace${i}`] = "vec3";
        t[`viewM${i}`]    = "mat4";
        t[`projM${i}`]    = "mat4";
        t[`mask${i}`]     = "sampler2D";
        t[`hasMask${i}`]  = "float";
      }
      return t;
    };
    const buildApplyInputs = (gsplat) => {
      const m = {
        gsplat,
        scaleEnable:   this.scaleUniforms.enable,
        scaleCenter:   this.scaleUniforms.center,
        scaleHalfSize: this.scaleUniforms.halfSize,
        scaleValue:    this.scaleUniforms.scale,
      };
      for (let i = 0; i < this.MAX_BOXES; i++) {
        const s = this.boxSlots[i];
        m[`enable${i}`]   = s.enable;
        m[`center${i}`]   = s.center;
        m[`halfSize${i}`] = s.halfSize;
        m[`displace${i}`] = s.displace;
        m[`viewM${i}`]    = s.viewMatrix;
        m[`projM${i}`]    = s.projMatrix;
        m[`mask${i}`]     = s.mask;
        m[`hasMask${i}`]  = s.hasMask;
      }
      return m;
    };

    const slotDisplaceBlock = (i) => `
      if (\${inputs.enable${i}} > 0.5) {
        vec3 rel${i} = origCenter - \${inputs.center${i}};
        vec3 absRel${i} = abs(rel${i});
        bool inZ${i}   = absRel${i}.z <= \${inputs.halfSize${i}}.z;
        bool inFull${i} =
             absRel${i}.x <= \${inputs.halfSize${i}}.x
          && absRel${i}.y <= \${inputs.halfSize${i}}.y
          && inZ${i};
        if (\${inputs.hasMask${i}} > 0.5) {
          if (inZ${i}) {
            vec4 clip${i} = \${inputs.projM${i}} * \${inputs.viewM${i}} * vec4(origCenter, 1.0);
            float w${i} = 0.0;
            if (clip${i}.w > 0.0) {
              vec2 ndc${i} = clip${i}.xy / clip${i}.w;
              vec2 uv${i} = ndc${i} * 0.5 + 0.5;
              uv${i}.y = 1.0 - uv${i}.y;
              if (uv${i}.x >= 0.0 && uv${i}.x <= 1.0 && uv${i}.y >= 0.0 && uv${i}.y <= 1.0) {
                float mv${i} = texture(\${inputs.mask${i}}, uv${i}).r;
                w${i} = step(0.5, mv${i});
              }
            }
            \${outputs.gsplat}.center += \${inputs.displace${i}} * w${i};
          }
        } else {
          if (inFull${i}) {
            \${outputs.gsplat}.center += \${inputs.displace${i}};
          }
        }
      }
    `;

    splatMesh.worldModifier = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => {
        const slotBlocks = [];
        for (let i = 0; i < this.MAX_BOXES; i++) slotBlocks.push(slotDisplaceBlock(i));
        const shader = new dyno.Dyno({
          inTypes: buildInTypes(),
          outTypes: { gsplat: dyno.Gsplat },
          statements: ({ inputs, outputs }) => {
            // 내부 템플릿의 \${inputs.xxx} / \${outputs.gsplat} 를 실제 이름으로 치환
            const resolve = (block) =>
              block
                .replace(/\$\{outputs\.gsplat\}/g, outputs.gsplat)
                .replace(/\$\{inputs\.([A-Za-z0-9_]+)\}/g, (_, key) => inputs[key]);
            const code = `
              ${outputs.gsplat} = ${inputs.gsplat};
              vec3 origCenter = ${inputs.gsplat}.center;

              // 1) scale (활성 박스만)
              if (${inputs.scaleEnable} > 0.5) {
                vec3 relS = origCenter - ${inputs.scaleCenter};
                vec3 absS = abs(relS);
                if (absS.x <= ${inputs.scaleHalfSize}.x
                 && absS.y <= ${inputs.scaleHalfSize}.y
                 && absS.z <= ${inputs.scaleHalfSize}.z) {
                  ${outputs.gsplat}.center = ${inputs.scaleCenter} + relS * ${inputs.scaleValue};
                  ${outputs.gsplat}.scales *= ${inputs.scaleValue};
                }
              }

              // 2) displace (N 슬롯 순회)
              ${slotBlocks.map(resolve).join("\n")}
            `;
            return dyno.unindentLines(code);
          },
        });
        return {
          gsplat: shader.apply(buildApplyInputs(gsplat)).gsplat,
        };
      }
    );
    splatMesh.updateGenerator();

    this.boxes = [];
    this.activeBox = null;
    this.boxCount = 0;
    this.defaultSize = new THREE.Vector3(0.5, 0.5, 0.5);
    this.wireframesVisible = true;
    this.fillEnabledGlobal = true;  // 전역 Fill 토글 (기본 on)

    this.raycaster = new THREE.Raycaster();

    // 이동 드래그 상태
    this.isDragging = false;
    this.dragPlane = new THREE.Plane();
    this.dragStartWorld = new THREE.Vector3();
    this.dragBaseDisplacement = new THREE.Vector3();

    // 선택(박스 생성) 드래그 상태
    this.isDrawing = false;
    this.drawStartPoint = new THREE.Vector3();
    this.drawPlane = new THREE.Plane();
    this.drawingBox = null; // 드래그 중 미리보기 박스
    this.defaultHeight = 0.5; // 박스 기본 높이

    // X(anchor) 드래그 상태 — 박스 원점 이동
    this.isAnchorDragging = false;
    this.anchorPlane = new THREE.Plane();
    this.anchorDragStart = new THREE.Vector3();
    this.anchorBaseOrigin = new THREE.Vector3();

    // 이벤트 바인딩
    const el = renderer.domElement;
    el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    el.addEventListener("pointerup", () => this.onPointerUp());
  }

  // 현재 모드 (외부에서 설정)
  mode = "camera";

  // ─── 박스 관리 ────────────────────────────────────────────

  toggleWireframes() {
    this.wireframesVisible = !this.wireframesVisible;
    this.boxes.forEach((b) => {
      b.wireframe.visible = this.wireframesVisible;
      if (b.label) b.label.visible = this.wireframesVisible;
    });
    return this.wireframesVisible;
  }

  // 런타임에서 soft edge 값 조정 — 브라우저 콘솔에서 editor.setSoftEdge(0.2) 형태로 튜닝 가능
  setSoftEdge(value) {
    const v = Math.max(0, Number(value) || 0);
    this.softEdgeValue = v;
    this.sharedEdit.softEdge = v;
    this.splatMesh.updateVersion();
    return v;
  }

  // Hide 기능 제거됨 (no-op — 호환용)
  setHideEnabled(_on) { /* no-op */ }

  // 전역 Fill 토글 — 모든 박스 fillMesh visible on/off
  setFillEnabled(on) {
    this.fillEnabledGlobal = !!on;
    this.boxes.forEach((b) => b.setFillEnabled(this.fillEnabledGlobal));
  }

  // 박스 주변 화면 픽셀 샘플링해 평균 배경 색 반환 (hex int).
  //   박스 wireframe 의 스크린 bbox 를 구하고 그 바로 바깥(벽/바닥) 에서 픽셀 수집.
  //   화면에 박스가 보여야 정확. 보이지 않으면 null.
  //   ⚠️ 샘플링 중에는 모든 Fill Plane 숨기고 Hide 끄기 — 우리가 그려놓은 Plane 색이
  //   다시 샘플링돼 피드백 루프가 생기는 걸 방지.
  async sampleBoxBackground(box) {
    // 모든 박스의 fillMesh 임시 숨김 — 기존 Plane 색이 다시 샘플에 섞이지 않도록
    const prevFillVis = this.boxes.map((b) => b.fillMesh.visible);
    this.boxes.forEach((b) => (b.fillMesh.visible = false));
    this.splatMesh.updateVersion();

    const restore = () => {
      this.boxes.forEach((b, i) => (b.fillMesh.visible = prevFillVis[i]));
      this.splatMesh.updateVersion();
    };

    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        try {
          this.renderer.render(this.scene, this.camera);
          const src = this.renderer.domElement;
          const off = document.createElement("canvas");
          off.width = src.width;
          off.height = src.height;
          const ctx = off.getContext("2d");
          ctx.drawImage(src, 0, 0);

          // 박스 원점 기준 8 corner
          const hs = box.originalSize.clone().multiplyScalar(0.5);
          const c = box.originPosition;
          const corners = [];
          for (const sx of [-1, 1])
            for (const sy of [-1, 1])
              for (const sz of [-1, 1])
                corners.push(
                  new THREE.Vector3(c.x + hs.x * sx, c.y + hs.y * sy, c.z + hs.z * sz)
                );

          // 스크린 투영
          const w = src.width;
          const h = src.height;
          const sp = corners.map((v) => {
            const p = v.clone().project(this.camera);
            return { x: (p.x + 1) * 0.5 * w, y: (1 - (p.y + 1) * 0.5) * h, z: p.z };
          });
          // 카메라 뒤 (z > 1) 점이 많으면 박스가 화면 밖
          if (sp.every((p) => p.z > 1 || p.z < -1)) {
            restore();
            resolve(null);
            return;
          }

          const minX = Math.min(...sp.map((p) => p.x));
          const maxX = Math.max(...sp.map((p) => p.x));
          const minY = Math.min(...sp.map((p) => p.y));
          const maxY = Math.max(...sp.map((p) => p.y));
          const sampleOffset = 18;

          const pts = [];
          // 바닥 아래
          for (let i = 0; i < 5; i++)
            pts.push({ x: minX + (maxX - minX) * (0.15 + i * 0.175), y: maxY + sampleOffset });
          // 양 옆
          for (let i = 0; i < 3; i++) {
            pts.push({ x: minX - sampleOffset, y: minY + (maxY - minY) * (0.3 + i * 0.2) });
            pts.push({ x: maxX + sampleOffset, y: minY + (maxY - minY) * (0.3 + i * 0.2) });
          }
          // 위
          for (let i = 0; i < 3; i++)
            pts.push({ x: minX + (maxX - minX) * (0.3 + i * 0.2), y: minY - sampleOffset });

          let r = 0, g = 0, b = 0, n = 0;
          for (const p of pts) {
            const x = Math.round(p.x), y = Math.round(p.y);
            if (x < 0 || x >= w || y < 0 || y >= h) continue;
            const d = ctx.getImageData(x, y, 1, 1).data;
            r += d[0]; g += d[1]; b += d[2]; n++;
          }
          if (n === 0) {
            restore();
            resolve(null);
            return;
          }
          r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
          restore();
          resolve((r << 16) | (g << 8) | b);
        } catch (err) {
          console.warn("[sampleBoxBackground] 실패:", err);
          restore();
          resolve(null);
        }
      });
    });
  }

  // 박스 하나의 Fill 색을 새로 샘플링해 적용
  async refreshFillColor(box) {
    const color = await this.sampleBoxBackground(box);
    if (color !== null) {
      box.setFillColor(color);
      console.log(
        `[fill] "${box.name}" → #${color.toString(16).padStart(6, "0")}`
      );
    } else {
      console.warn(`[fill] "${box.name}" 샘플링 실패 (박스가 화면 밖)`);
    }
  }

  createBox(position, size, opts = {}) {
    const { activate = true } = opts;
    this.boxCount++;
    const name = `영역 ${this.boxCount}`;
    const box = new BoxRegion(
      name,
      position,
      size,
      this.sharedEdit,
      this.scene,
      this.dummyMask
    );
    box.id = this.boxCount;
    box.wireframe.visible = this.wireframesVisible;
    if (box.label) box.label.visible = this.wireframesVisible;
    box.setFillEnabled(this.fillEnabledGlobal);
    this.boxes.push(box);
    // 이동 전(Plane 숨김 상태) 에 즉시 주변 색 샘플링 — 가장 깨끗한 타이밍
    this.refreshFillColor(box).catch(() => {});
    if (activate) this.selectBox(box);
    else this._syncBoxUniforms();
    this.splatMesh.updateVersion();
    return box;
  }

  // 두 박스의 visual 위치를 서로 교환 (displacement 조정 — 원점/AABB 는 유지)
  // visualA = originA + dispA, visualB = originB + dispB
  // 교환 후: newDispA 가 visualB 를 가리키도록, newDispB 가 visualA 를 가리키도록
  swapBoxesById(idA, idB) {
    const a = this.boxes.find((b) => b.id === idA);
    const b = this.boxes.find((b) => b.id === idB);
    if (!a || !b || a === b) return false;
    const visA = a.originPosition.clone().add(a.displacement);
    const visB = b.originPosition.clone().add(b.displacement);
    const newDispA = visB.clone().sub(a.originPosition);
    const newDispB = visA.clone().sub(b.originPosition);
    a.setDisplacement(newDispA);
    b.setDisplacement(newDispB);
    this._syncBoxUniforms();
    this.splatMesh.updateVersion();
    return true;
  }

  // 스크린 정규화 bbox([x1,y1,x2,y2], 0~1, 원점 좌상단) → 3D BoxRegion
  // 4꼭짓점 + 중심 총 5점을 raycast → splatMesh 교점으로 중심/크기 추정
  createBoxFromScreenBBox(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    const [x1, y1, x2, y2] = bbox;

    const samples = [
      [x1, y1],
      [x2, y1],
      [x1, y2],
      [x2, y2],
      [(x1 + x2) / 2, (y1 + y2) / 2],
    ];

    const points = [];
    for (const [u, v] of samples) {
      const ndc = new THREE.Vector2(u * 2 - 1, -(v * 2 - 1));
      const p = this.hitSplat(ndc);
      if (p) points.push(p);
    }

    if (points.length === 0) return null;

    let center;
    let size;
    if (points.length === 1) {
      center = points[0].clone();
      size = this.defaultSize.clone();
    } else {
      const min = new THREE.Vector3(Infinity, Infinity, Infinity);
      const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
      for (const p of points) {
        min.min(p);
        max.max(p);
      }
      center = min.clone().add(max).multiplyScalar(0.5);
      // XY 는 마스크가 픽셀 단위로 필터하므로 박스는 시각적 참조용. pad 는 작게.
      // Z 만 박스 역할 (뒷벽 Gaussian 제외) 이라 depth pad 를 약간 더 줌.
      const padXY = 1.1;
      const padZ = 1.3;
      size = new THREE.Vector3(
        Math.max((max.x - min.x) * padXY, 0.1),
        Math.max((max.y - min.y) * padXY, 0.3),
        Math.max((max.z - min.z) * padZ, 0.15)
      );
    }

    return this.createBox(center, size, { activate: false });
  }

  selectBox(box) {
    // 모든 박스의 displace 는 worldModifier 슬롯 루프가 담당하므로 SDF 이관 불필요.
    // 활성/비활성 전환은 scale 대상(활성만)과 selected 시각 효과에만 영향.
    if (this.activeBox && this.activeBox !== box) {
      this.activeBox.setSelected(false);
    } else if (this.activeBox) {
      this.activeBox.setSelected(false);
    }
    this.activeBox = box;
    if (box) box.setSelected(true);
    this._syncBoxUniforms();
    this.splatMesh.updateVersion();
  }

  removeActiveBox() {
    if (!this.activeBox) return;
    const idx = this.boxes.indexOf(this.activeBox);
    if (idx >= 0) {
      this.activeBox.remove(this.scene);
      this.boxes.splice(idx, 1);
      this.activeBox = null;
      this._syncBoxUniforms();
      this.splatMesh.updateVersion();
    }
  }

  // 탭1: 영역(박스) 크기 — wireframe/SDF/hitbox 만 변경, splat 불변
  updateActiveBoxSize(axis, value) {
    if (!this.activeBox) return;
    this.activeBox.size[axis] = value;
    this.activeBox.updateSize(this.activeBox.size);
    this.splatMesh.updateVersion();
  }

  // 탭2: 객체 스케일 배율 — 셰이더 uniform 갱신, 내부 splat 변형
  updateActiveBoxScale(axis, value) {
    if (!this.activeBox) return;
    this.activeBox.scaleFactor[axis] = value;
    this._syncBoxUniforms();
    this.splatMesh.updateVersion();
  }

  // scale (활성 박스만) + displace 슬롯 (모든 박스) 일괄 동기화
  _syncBoxUniforms() {
    const active = this.activeBox;

    // scale: 활성 박스만
    if (active) {
      this.scaleUniforms.enable.value = 1.0;
      this.scaleUniforms.center.value.copy(active.originPosition);
      this.scaleUniforms.halfSize.value.set(
        active.originalSize.x * 0.5,
        active.originalSize.y * 0.5,
        active.originalSize.z * 0.5
      );
      this.scaleUniforms.scale.value.copy(active.scaleFactor);
    } else {
      this.scaleUniforms.enable.value = 0.0;
    }

    // displace: 박스들을 슬롯에 순서대로 배정. MAX_BOXES 초과분은 경고.
    if (this.boxes.length > this.MAX_BOXES) {
      console.warn(
        `[VmdEditor] 박스 ${this.boxes.length}개 — ${this.MAX_BOXES}개 초과분은 이동 반영 안 됨`
      );
    }
    const n = Math.min(this.boxes.length, this.MAX_BOXES);
    for (let i = 0; i < n; i++) {
      const box = this.boxes[i];
      const s = this.boxSlots[i];
      s.enable.value = 1.0;
      s.center.value.copy(box.originPosition);
      s.halfSize.value.set(
        box.originalSize.x * 0.5,
        box.originalSize.y * 0.5,
        box.originalSize.z * 0.5
      );
      s.displace.value.copy(box.displacement);
      if (box.hasMask && box.mask && box.viewMatrix && box.projMatrix) {
        s.viewMatrix.value.copy(box.viewMatrix);
        s.projMatrix.value.copy(box.projMatrix);
        s.mask.value = box.mask;
        s.hasMask.value = 1.0;
      } else {
        s.mask.value = this.dummyMask;
        s.hasMask.value = 0.0;
      }
    }
    // 남은 슬롯 비활성화
    for (let i = n; i < this.MAX_BOXES; i++) {
      const s = this.boxSlots[i];
      s.enable.value = 0.0;
      s.mask.value = this.dummyMask;
      s.hasMask.value = 0.0;
    }
  }

  // 기존 이름 호환 — main.js 등 외부에서 호출할 수 있어 유지
  _syncScaleUniforms() {
    this._syncBoxUniforms();
  }

  // ─── 유틸리티 ─────────────────────────────────────────────

  getNDC(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  hitSplat(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.splatMesh, false);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }

  hitBox(ndc) {
    const hitboxes = this.boxes.map((b) => b.hitbox);
    if (hitboxes.length === 0) return null;
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(hitboxes, false);
    return hits.length > 0 ? hits[0].object.userData.boxRegion : null;
  }

  // ─── 포인터 이벤트 ────────────────────────────────────────

  // ─── 선택 모드: 드래그로 박스 그리기 ────────────────────

  onPointerDown(e) {
    if (this.mode === "camera") return;

    const ndc = this.getNDC(e);

    // X 모드: 박스 hitbox 클릭으로 드래그 시작 → 박스 원점 이동
    if (this.mode === "anchor") {
      const box = this.hitBox(ndc);
      if (box) {
        this.selectBox(box);
        this.isAnchorDragging = true;

        const boxPos = box.originPosition.clone().add(box.displacement);
        this.anchorPlane.set(new THREE.Vector3(0, 1, 0), -boxPos.y);

        this.raycaster.setFromCamera(ndc, this.camera);
        const inter = new THREE.Vector3();
        this.raycaster.ray.intersectPlane(this.anchorPlane, inter);
        this.anchorDragStart.copy(inter);
        this.anchorBaseOrigin.copy(box.originPosition);

        this.renderer.domElement.style.cursor = "grabbing";
      }
      return;
    }

    if (this.mode === "select") {
      const point = this.hitSplat(ndc);
      if (point) {
        this.isDrawing = true;
        this.drawStartPoint.copy(point);
        // 클릭 지점 높이의 수평면
        this.drawPlane.set(new THREE.Vector3(0, 1, 0), -point.y);

        // 미리보기 와이어프레임 생성
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const edges = new THREE.EdgesGeometry(geo);
        this.drawingBox = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({
            color: 0x00ff88,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
          })
        );
        this.drawingBox.position.copy(point);
        this.drawingBox.scale.set(0.001, 0.001, 0.001);
        this.drawingBox.renderOrder = 999;
        this.scene.add(this.drawingBox);
      }
      return;
    }

    if (this.mode === "move") {
      const box = this.hitBox(ndc);
      if (box) {
        this.selectBox(box);
        this.isDragging = true;

        const boxPos = box.originPosition.clone().add(box.displacement);
        this.dragPlane.set(new THREE.Vector3(0, 1, 0), -boxPos.y);

        this.raycaster.setFromCamera(ndc, this.camera);
        const inter = new THREE.Vector3();
        this.raycaster.ray.intersectPlane(this.dragPlane, inter);
        this.dragStartWorld.copy(inter);
        this.dragBaseDisplacement.copy(box.displacement);

        this.renderer.domElement.style.cursor = "grabbing";
      }
    }
  }

  onPointerMove(e) {
    const ndc = this.getNDC(e);
    this.raycaster.setFromCamera(ndc, this.camera);

    // ─── X(anchor) 모드: 드래그로 박스 원점 이동 ─────────
    if (this.isAnchorDragging && this.activeBox) {
      if (e.shiftKey) {
        const inter = new THREE.Vector3();
        const vertPlane = new THREE.Plane();
        const camDir = new THREE.Vector3();
        this.camera.getWorldDirection(camDir);
        camDir.y = 0;
        camDir.normalize();
        vertPlane.setFromNormalAndCoplanarPoint(
          camDir,
          this.activeBox.originPosition.clone().add(this.activeBox.displacement)
        );
        if (this.raycaster.ray.intersectPlane(vertPlane, inter)) {
          const delta = inter.clone().sub(this.anchorDragStart);
          const newOrigin = this.anchorBaseOrigin.clone();
          newOrigin.y += delta.y;
          this.activeBox.setOrigin(newOrigin);
          this._syncScaleUniforms();
          this.splatMesh.updateVersion();
        }
      } else {
        const inter = new THREE.Vector3();
        if (this.raycaster.ray.intersectPlane(this.anchorPlane, inter)) {
          const delta = inter.clone().sub(this.anchorDragStart);
          const newOrigin = this.anchorBaseOrigin.clone();
          newOrigin.x += delta.x;
          newOrigin.z += delta.z;
          this.activeBox.setOrigin(newOrigin);
          this._syncScaleUniforms();
          this.splatMesh.updateVersion();
        }
      }
      return;
    }

    // ─── 선택 모드: 드래그로 박스 크기 미리보기 ──────────
    if (this.isDrawing && this.drawingBox) {
      const inter = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.drawPlane, inter)) {
        const start = this.drawStartPoint;
        const sizeX = Math.abs(inter.x - start.x);
        const sizeZ = Math.abs(inter.z - start.z);
        const centerX = (start.x + inter.x) / 2;
        const centerZ = (start.z + inter.z) / 2;

        const w = Math.max(sizeX, 0.02);
        const d = Math.max(sizeZ, 0.02);
        const h = Math.max(w, d);

        // 시작점 = 직육면체 위에서 볼 때 왼쪽 앞 꼭짓점
        // 오른쪽 뒤로 박스가 자람
        this.drawingBox.position.set(
          start.x + sizeX / 2 * Math.sign(inter.x - start.x || 1),
          start.y - h / 2,
          start.z - sizeZ / 2 * Math.sign(-(inter.z - start.z) || 1)
        );
        this.drawingBox.scale.set(w, h, d);
      }
      return;
    }

    // ─── 이동 모드: 드래그로 이동 ────────────────────────
    if (!this.isDragging || !this.activeBox) return;

    let newDisp = null;
    if (e.shiftKey) {
      // Shift + 드래그: 높이(Y) 조절
      const inter = new THREE.Vector3();
      const vertPlane = new THREE.Plane();
      const camDir = new THREE.Vector3();
      this.camera.getWorldDirection(camDir);
      camDir.y = 0;
      camDir.normalize();
      vertPlane.setFromNormalAndCoplanarPoint(
        camDir,
        this.activeBox.originPosition.clone().add(this.activeBox.displacement)
      );
      if (this.raycaster.ray.intersectPlane(vertPlane, inter)) {
        const delta = inter.clone().sub(this.dragStartWorld);
        newDisp = this.dragBaseDisplacement.clone();
        newDisp.y += delta.y;
      }
    } else {
      // 기본: 수평(XZ) 이동
      const inter = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.dragPlane, inter)) {
        const delta = inter.clone().sub(this.dragStartWorld);
        newDisp = this.dragBaseDisplacement.clone();
        newDisp.x += delta.x;
        newDisp.z += delta.z;
      }
    }

    if (newDisp) {
      this.activeBox.setDisplacement(newDisp);
      this._syncBoxUniforms();
      this.splatMesh.updateVersion();
    }
  }

  onPointerUp() {
    // ─── X(anchor) 모드: 드래그 끝 ───────────────────────
    if (this.isAnchorDragging) {
      this.isAnchorDragging = false;
      if (this.mode === "anchor") {
        this.renderer.domElement.style.cursor = "grab";
      }
      return;
    }

    // ─── 선택 모드: 드래그 끝 → 박스 확정 ────────────────
    if (this.isDrawing && this.drawingBox) {
      const scale = this.drawingBox.scale;
      const minSize = 0.05;

      if (scale.x > minSize && scale.z > minSize) {
        const center = this.drawingBox.position.clone();
        const size = new THREE.Vector3(scale.x, scale.y, scale.z);
        this.createBox(center, size);
      }

      // 미리보기 정리
      this.scene.remove(this.drawingBox);
      this.drawingBox.geometry.dispose();
      this.drawingBox.material.dispose();
      this.drawingBox = null;
      this.isDrawing = false;
      return;
    }

    // ─── 이동 모드: 드래그 끝 ────────────────────────────
    if (this.isDragging) {
      this.isDragging = false;
      if (this.mode === "move") {
        this.renderer.domElement.style.cursor = "grab";
      }
    }
  }
}
