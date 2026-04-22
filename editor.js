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
  constructor(name, position, size, sharedEdit, scene) {
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
    this.sdf.displace.copy(d);
    const pos = this.originPosition.clone().add(d);
    this.wireframe.position.copy(pos);
    this.hitbox.position.copy(pos);
    this._updateLabelPos();
  }

  updateSize(size) {
    this.size.copy(size);
    this.sdf.scale.copy(size);
    this.wireframe.scale.copy(size);
    this.hitbox.scale.copy(size);
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
    this._updateLabelPos();
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
  }

  remove(scene) {
    scene.remove(this.wireframe);
    scene.remove(this.hitbox);
    scene.remove(this.label);
    this.sharedEdit.remove(this.sdf);
    this.wireframe.geometry.dispose();
    this.wireframe.material.dispose();
    this.hitbox.geometry.dispose();
    this.hitbox.material.dispose();
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

    // ── 활성 박스 통합 shader (MVP: 한 번에 1개 박스만) ──
    // 역할:
    //   1) 객체 스케일: 박스 AABB 내 Gaussian 을 중심 기준 scale 배율로 확장/축소
    //   2) 마스크 기반 displace: 박스 AABB 안 + 마스크 "흰색" 인 Gaussian 만 이동
    //      (마스크 없으면 weight=1 로 AABB 전체 이동 — 기존 동작 호환)
    //
    // 비활성 박스의 displace 는 SplatEditSdf 의 sdf.displace 로 처리 (혼용 정책).
    // 활성 박스는 selectBox() 에서 sdf.displace=0 으로 두고 이 worldModifier 가 전담.

    // 더미 1×1 흰색 텍스처 — 마스크 없는 박스에 바인딩 (항상 weight=1 반환)
    this.dummyMask = new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      THREE.RGBAFormat
    );
    this.dummyMask.needsUpdate = true;

    this.boxUniforms = {
      enable:     dyno.dynoFloat(0.0),
      center:     dyno.dynoVec3(new THREE.Vector3()),
      halfSize:   dyno.dynoVec3(new THREE.Vector3(1, 1, 1)),
      scale:      dyno.dynoVec3(new THREE.Vector3(1, 1, 1)),
      displace:   dyno.dynoVec3(new THREE.Vector3()),
      viewMatrix: dyno.dynoMat4(new THREE.Matrix4()),
      projMatrix: dyno.dynoMat4(new THREE.Matrix4()),
      mask:       dyno.dynoSampler2D(this.dummyMask),
      hasMask:    dyno.dynoFloat(0.0),
    };
    // 기존 코드 호환 (외부에서 scaleUniforms 참조 가능성)
    this.scaleUniforms = this.boxUniforms;

    splatMesh.worldModifier = dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => {
        const shader = new dyno.Dyno({
          inTypes: {
            gsplat:     dyno.Gsplat,
            enable:     "float",
            center:     "vec3",
            halfSize:   "vec3",
            scale:      "vec3",
            displace:   "vec3",
            viewMatrix: "mat4",
            projMatrix: "mat4",
            mask:       "sampler2D",
            hasMask:    "float",
          },
          outTypes: { gsplat: dyno.Gsplat },
          statements: ({ inputs, outputs }) =>
            dyno.unindentLines(`
              ${outputs.gsplat} = ${inputs.gsplat};
              if (${inputs.enable} > 0.5) {
                vec3 origCenter = ${inputs.gsplat}.center;
                vec3 relPos = origCenter - ${inputs.center};
                vec3 absRel = abs(relPos);
                // 박스 AABB 는 Z 방향만 체크 — 물체 뒤편 Gaussian (벽 등) 을 걸러냄.
                // XY 는 마스크가 픽셀 단위로 정확히 필터하므로 박스로 다시 자를 필요 없음.
                //   → 박스를 XY 로 작게 그려도 물체가 잘리지 않음.
                // 스케일 처리는 여전히 XYZ 박스 안에서만 적용 (기존 객체 스케일 탭 동작 유지).
                bool inBoxFull =
                     absRel.x <= ${inputs.halfSize}.x
                  && absRel.y <= ${inputs.halfSize}.y
                  && absRel.z <= ${inputs.halfSize}.z;
                bool inBoxZ = absRel.z <= ${inputs.halfSize}.z;

                if (inBoxFull) {
                  // 1) 객체 스케일 (박스 중심 기준 relPos 확대) — XYZ 박스 안에서만
                  ${outputs.gsplat}.center = ${inputs.center} + relPos * ${inputs.scale};
                  ${outputs.gsplat}.scales *= ${inputs.scale};
                }

                if (inBoxZ) {
                  // 2) 마스크 기반 displace — Z 만 박스, XY 는 마스크가 담당
                  //    이진화(step) 로 Gaussian 이 "완전 이동 / 완전 정지" 둘 중 하나가 되도록.
                  //    JPEG 경계 그라디언트로 인한 "지렁이처럼 끌림" 방지.
                  float weight = 1.0;
                  if (${inputs.hasMask} > 0.5) {
                    vec4 clip = ${inputs.projMatrix} * ${inputs.viewMatrix} * vec4(origCenter, 1.0);
                    if (clip.w > 0.0) {
                      vec2 ndc = clip.xy / clip.w;
                      vec2 uv = ndc * 0.5 + 0.5;
                      uv.y = 1.0 - uv.y;
                      if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
                        float maskVal = texture(${inputs.mask}, uv).r;
                        weight = step(0.5, maskVal);
                      } else {
                        weight = 0.0;
                      }
                    } else {
                      weight = 0.0;
                    }
                  } else {
                    // 마스크 없는 박스: XY 체크가 없으면 씬 전체가 이동 대상이 됨 → 위험.
                    //   → 마스크 없는 박스만 기존대로 XYZ AABB 체크 (박스 안 전체 이동).
                    weight = inBoxFull ? 1.0 : 0.0;
                  }
                  ${outputs.gsplat}.center += ${inputs.displace} * weight;
                }
              }
            `),
        });
        return {
          gsplat: shader.apply({
            gsplat,
            enable:     this.boxUniforms.enable,
            center:     this.boxUniforms.center,
            halfSize:   this.boxUniforms.halfSize,
            scale:      this.boxUniforms.scale,
            displace:   this.boxUniforms.displace,
            viewMatrix: this.boxUniforms.viewMatrix,
            projMatrix: this.boxUniforms.projMatrix,
            mask:       this.boxUniforms.mask,
            hasMask:    this.boxUniforms.hasMask,
          }).gsplat,
        };
      }
    );
    splatMesh.updateGenerator();

    this.boxes = [];
    this.activeBox = null;
    this.boxCount = 0;
    this.defaultSize = new THREE.Vector3(0.5, 0.5, 0.5);
    this.wireframesVisible = true;

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

  createBox(position, size, opts = {}) {
    const { activate = true } = opts;
    this.boxCount++;
    const name = `영역 ${this.boxCount}`;
    const box = new BoxRegion(
      name,
      position,
      size,
      this.sharedEdit,
      this.scene
    );
    box.id = this.boxCount;
    box.wireframe.visible = this.wireframesVisible;
    if (box.label) box.label.visible = this.wireframesVisible;
    this.boxes.push(box);
    if (activate) this.selectBox(box);
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
    // swap 은 SDF displace 경로로 진행. 활성 박스가 참여했다면 worldModifier 로 재이관.
    if (this.activeBox === a || this.activeBox === b) {
      this.activeBox.sdf.displace.set(0, 0, 0);
      this._syncBoxUniforms();
    }
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
      // pad 1.4: 마스크 기반 필터링을 쓰므로 박스는 넉넉히. 물체 경계 Gaussian 이
      // 박스 AABB 밖으로 빠져 이동 대상에서 제외되는 "잘린 물체" 문제를 줄임.
      const pad = 1.4;
      size = new THREE.Vector3(
        Math.max((max.x - min.x) * pad, 0.15),
        Math.max((max.y - min.y) * pad, 0.4),
        Math.max((max.z - min.z) * pad, 0.15)
      );
    }

    return this.createBox(center, size, { activate: false });
  }

  selectBox(box) {
    // 이전 활성 박스 "굳히기": worldModifier displace 를 SDF 로 이관
    //   → 비활성된 박스도 이동 결과가 유지됨
    if (this.activeBox && this.activeBox !== box) {
      this.activeBox.sdf.displace.copy(this.activeBox.displacement);
      this.activeBox.setSelected(false);
    } else if (this.activeBox) {
      this.activeBox.setSelected(false);
    }
    this.activeBox = box;
    if (box) {
      box.setSelected(true);
      // 새 활성: SDF displace 를 0 으로 두고 worldModifier 가 이어받음
      box.sdf.displace.set(0, 0, 0);
    }
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

  // 활성 박스의 AABB 판정 범위 + scale/displace/mask 를 dyno uniform 에 반영
  _syncBoxUniforms() {
    const box = this.activeBox;
    if (!box) {
      this.boxUniforms.enable.value = 0.0;
      this.boxUniforms.hasMask.value = 0.0;
      this.boxUniforms.mask.value = this.dummyMask;
      return;
    }
    this.boxUniforms.enable.value = 1.0;
    this.boxUniforms.center.value.copy(box.originPosition);
    this.boxUniforms.halfSize.value.set(
      box.originalSize.x * 0.5,
      box.originalSize.y * 0.5,
      box.originalSize.z * 0.5
    );
    this.boxUniforms.scale.value.copy(box.scaleFactor);
    this.boxUniforms.displace.value.copy(box.displacement);

    if (box.hasMask && box.mask && box.viewMatrix && box.projMatrix) {
      this.boxUniforms.viewMatrix.value.copy(box.viewMatrix);
      this.boxUniforms.projMatrix.value.copy(box.projMatrix);
      this.boxUniforms.mask.value = box.mask;
      this.boxUniforms.hasMask.value = 1.0;
    } else {
      this.boxUniforms.mask.value = this.dummyMask;
      this.boxUniforms.hasMask.value = 0.0;
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
      // 활성 박스는 worldModifier 가 displace 전담 — SDF displace 는 0 유지
      this.activeBox.sdf.displace.set(0, 0, 0);
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
