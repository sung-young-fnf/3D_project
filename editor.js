import * as THREE from "three";
import {
  SplatEdit,
  SplatEditSdf,
  SplatEditSdfType,
} from "@sparkjsdev/spark";

// ─── 단일 BOX 영역 ─────────────────────────────────────────
class BoxRegion {
  constructor(name, position, size, sharedEdit, scene) {
    this.name = name;
    this.size = size.clone();
    this.originPosition = position.clone();
    this.displacement = new THREE.Vector3(0, 0, 0);
    this.sharedEdit = sharedEdit;

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
  }

  setSelected(active) {
    this.wireframe.material.color.setHex(active ? 0xffff00 : 0x00ffff);
    this.wireframe.material.opacity = active ? 1.0 : 0.7;
  }

  setDisplacement(d) {
    this.displacement.copy(d);
    this.sdf.displace.copy(d);
    const pos = this.originPosition.clone().add(d);
    this.wireframe.position.copy(pos);
    this.hitbox.position.copy(pos);
  }

  updateSize(size) {
    this.size.copy(size);
    this.sdf.scale.copy(size);
    this.wireframe.scale.copy(size);
    this.hitbox.scale.copy(size);
  }

  remove(scene) {
    scene.remove(this.wireframe);
    scene.remove(this.hitbox);
    this.sharedEdit.remove(this.sdf);
    this.wireframe.geometry.dispose();
    this.wireframe.material.dispose();
    this.hitbox.geometry.dispose();
    this.hitbox.material.dispose();
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
    this.sharedEdit = new SplatEdit({
      name: "vmd-boxes",
      softEdge: 0,
      sdfSmooth: 0,
    });
    splatMesh.add(this.sharedEdit);

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
    });
    return this.wireframesVisible;
  }

  createBox(position, size) {
    this.boxCount++;
    const name = `영역 ${this.boxCount}`;
    const box = new BoxRegion(
      name,
      position,
      size,
      this.sharedEdit,
      this.scene
    );
    box.wireframe.visible = this.wireframesVisible;
    this.boxes.push(box);
    this.selectBox(box);
    this.splatMesh.updateVersion();
    return box;
  }

  selectBox(box) {
    if (this.activeBox) this.activeBox.setSelected(false);
    this.activeBox = box;
    if (box) box.setSelected(true);
  }

  removeActiveBox() {
    if (!this.activeBox) return;
    const idx = this.boxes.indexOf(this.activeBox);
    if (idx >= 0) {
      this.activeBox.remove(this.scene);
      this.boxes.splice(idx, 1);
      this.activeBox = null;
      this.splatMesh.updateVersion();
    }
  }

  updateActiveBoxSize(axis, value) {
    if (!this.activeBox) return;
    this.activeBox.size[axis] = value;
    this.activeBox.updateSize(this.activeBox.size);
    this.splatMesh.updateVersion();
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
        const newDisp = this.dragBaseDisplacement.clone();
        newDisp.y += delta.y;
        this.activeBox.setDisplacement(newDisp);
        this.splatMesh.updateVersion();
      }
    } else {
      // 기본: 수평(XZ) 이동
      const inter = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.dragPlane, inter)) {
        const delta = inter.clone().sub(this.dragStartWorld);
        const newDisp = this.dragBaseDisplacement.clone();
        newDisp.x += delta.x;
        newDisp.z += delta.z;
        this.activeBox.setDisplacement(newDisp);
        this.splatMesh.updateVersion();
      }
    }
  }

  onPointerUp() {
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
