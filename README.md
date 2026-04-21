# F&F STORE - VMD 프로토타입

Spark 기반 3D Gaussian Splatting 가상 매장 에디터. 매장 공간 splat 위에 박스 영역을 지정해 물체를 이동·스케일하고, Claude Vision 으로 화면 속 객체를 자동 감지·박싱할 수 있는 도구.

---

## 실행 방법

### 1. 의존성 설치 (최초 1회)

Spark 폴더 클론
```bash
git clone https://github.com/sparkjsdev/spark.git
```

루트에서:
```bash
npm install
```

spark 라이브러리는 Rust 빌드를 피하기 위해:
```bash
cd spark
npm install --ignore-scripts
cd ..
```

### 2. 환경변수 설정

`.env` 생성 후 Bedrock 토큰 입력:
```
AWS_BEARER_TOKEN_BEDROCK=<발급받은 토큰>
AWS_REGION=
BEDROCK_MODEL_ID=
```

### 3. 3D 에셋 배치

프로젝트 루트에 **`space.spz`** 파일을 직접 넣어야 합니다. 이 파일은 리포지토리에 포함되지 않으므로 사용자가 별도 확보:

```
3D_project/
└── space.spz   ← 여기에 직접 복사
```

`main.js` 의 `new SplatMesh({ url: "/space.spz" })` 가 이 파일을 참조합니다. 다른 splat 파일을 쓰려면 main.js 의 url 경로를 함께 수정하세요.

### 4. 개발 서버 실행

```bash
npx vite --port 8080
```
→ http://localhost:8080/

## 조작법

### 모드 (단축키)

| 키 | 모드 | 동작 |
|----|------|------|
| **Q** | 카메라 | WASD 이동 + 마우스 시점 변경 (기본값) |
| **B** | 선택 | 드래그로 새 BOX 영역 생성 |
| **V** | 이동 | 박스 드래그로 **내부 splat 이동** (+ Shift 드래그 = 높이 조절) |
| **X** | 재배치 | 박스 드래그로 **박스 자체를 이동** (displacement/scaleFactor 는 유지, +Shift 드래그 = 높이 조절) |
| **ESC** | 카메라 | 현재 모드 취소 |
| **Delete / Backspace** | — | 활성 박스 삭제 |

> **V vs X 차이**
> - V: 박스 내용(splat) 을 다른 곳으로 움직임 (`displacement` 변경)
> - X: AI가 잘못 잡은 박스를 진짜 물체 위로 옮김 (`originPosition` 변경 → SDF·AABB 전체 translate)

상단 툴바의 **Q 카메라 / B 선택 / V 이동 / X 재배치** 버튼으로도 동일하게 모드 진입 가능.

### 속성 패널 (박스 선택 시 우측)

**영역 크기 탭**: `X/Y/Z` 슬라이더로 박스 wireframe·SDF·hitbox 크기만 변경 (splat 불변)

**객체 스케일 탭**: `X/Y/Z` 슬라이더로 박스 내부 splat 만 배율 적용 (0.1 ~ 5.0, 기본 1.0)

| 버튼 | 동작 |
|------|------|
| 삭제 (Delete) | 활성 박스 제거 |

### AI Vision 자동 감지 (우하단 패널)

| 입력 | 동작 |
|------|------|
| 입력창 + 🔍 Claude | 입력한 물건을 화면에서 찾아 bbox 지정 (`영역 N · 라벨` 이름) |
| 전체 | 화면 속 모든 구별 가능한 물체를 bbox 로 지정 |
| Enter 키 | 🔍 Claude 트리거 |

- 자동 생성 박스는 cyan 기본색 (activeBox 덮어쓰지 않음)
- 같은 label IoU ≥ 0.5 시 면적 큰 것 하나만 유지 (중복 제거)
- 응답 시간 / 생성 박스 수 가 상태 텍스트에 표시됨
- 캡처 이미지는 `captures/YYYYMMDD-HHMMSS-mmm.jpg` 로 저장 (디버그용, gitignore)
- 서버 60초, 클라이언트 65초 타임아웃

---

## 파일 구조

```
3D_project/
├── index.html           UI 레이아웃 (툴바 / 좌우 패널 / Claude 패널)
├── main.js              씬 초기화, 모드 관리, 이벤트 바인딩, Claude 연동
├── editor.js            VmdEditor + BoxRegion (SDF + dyno worldModifier)
├── vite.config.js       Vite 설정 + /api/detect 미들웨어 (Bedrock 프록시)
├── space.spz            3D Gaussian Splatting 에셋 (매장 공간)
├── captures/            Claude 호출 시 캡처 이미지 (gitignore)
├── .env                 Bedrock 토큰 (gitignore)
├── .env.example         환경변수 템플릿
└── spark/               Spark 라이브러리 (로컬 체크아웃)
    ├── dist/            pre-built ESM 번들
    └── node_modules/
        └── three/       import map 소스
```

---

## 기술 스택

- **렌더링**: Spark (3D Gaussian Splatting on THREE.js WebGL2) + dyno 셰이더 그래프
- **빌드**: Vite 6 (dev 서버 + `configureServer` 훅으로 API 미들웨어)
- **AI**: AWS Bedrock (Claude Sonnet/Opus) via `@anthropic-ai/bedrock-sdk`
- **3D**: three.js 0.180
