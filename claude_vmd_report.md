# Claude 기반 VMD 자동 박스 지정 기능 — 기획서

## 1. Context / 목적

현재 `vmd_test/`는 사용자가 마우스를 드래그해 수동으로 박스 영역을 그리고, 그 안의 splat을 이동(displace)시키는 VMD 프로토타입. 여기에 **Claude Vision(AWS Bedrock 경유)을 붙여 "지금 보이는 화면에서 이 물건 찾아줘" 같은 자연어 요청으로 박스를 자동 지정**하게 한다.

- 시나리오 A: 채팅 입력("종이컵", "물컵" 등) + **[Claude]** 버튼 → 해당 물체만 박스 지정
- 시나리오 B: **[전체]** 버튼 → 화면에 보이는 모든 물체를 박스 지정
- 공통: 버튼 클릭 시점의 뷰를 캡처 → `captures/`에 PNG만 저장(디버그용) → Bedrock Claude Vision에 전달 → bbox 좌표를 받아 3D BoxRegion 즉시 생성
- 감지 결과(JSON 응답)는 **저장하지 않음**. 디스크에 남는 건 캡처 PNG뿐.

---

## 2. 아키텍처 — **Vite 단일 서버 (Option A)**

```
[Vite Dev Server : port 8080]
  ├─ 정적 자산 서빙 (vmd_test/ + ../spark/node_modules/three + ../spark/dist)
  ├─ configureServer 미들웨어로 /api/detect POST 핸들링
  │    1. base64 PNG 디코드
  │    2. captures/YYYYMMDD-HHMMSS.png 저장
  │    3. AnthropicBedrock(@anthropic-ai/bedrock-sdk) 호출
  │    4. JSON 파싱 + IoU 기반 중복 제거
  │    5. { capture_id, detections } 응답
  └─ .env의 AWS_BEARER_TOKEN_BEDROCK은 서버 프로세스만 읽음 (브라우저 노출 X)

[브라우저]
  ├─ import "three", "@sparkjsdev/spark" ← Vite alias로 해석
  ├─ 기존 에디터 (카메라/선택/이동 모드)
  ├─ 신규 Claude 패널 (텍스트 + [Claude] / [전체])
  └─ fetch POST /api/detect → 받은 bbox를 3D로 변환해 BoxRegion 생성
```

- **명령어 하나**로 끝: `npm run dev` (= `vite --port 8080`).
- **분리 안 해도 되는 이유**: Vite의 `configureServer` 훅으로 같은 프로세스에 API 라우트 주입. 토큰은 Node 프로세스 메모리에만 존재, 브라우저에는 응답 JSON만 전달.
- **Bedrock 직접 호출이 아닌 이유**: 브라우저에서 Bedrock 직호출 시 (1) 토큰 유출, (2) CORS 차단. 그래서 같은 서버 안의 미들웨어에서 프록시.

---

## 3. API 계약

### 요청
```
POST /api/detect
Content-Type: application/json

{
  "image_base64": "<PNG base64, 헤더 제외>",
  "mode": "target" | "all",
  "target": "종이컵"        // mode === "target" 일 때만
}
```

### 응답
```
{
  "capture_id": "20260421-103412",
  "detections": [
    { "label": "종이컵", "bbox": [0.32, 0.48, 0.41, 0.62] }
  ]
}
```
- `bbox = [x1, y1, x2, y2]`, 이미지 크기에 대해 0~1 정규화, 원점 좌상단.
- 미발견 시 `detections: []`.

---

## 4. Bedrock 호출 (서버 미들웨어 내부)

- **SDK**: `@anthropic-ai/bedrock-sdk` (Node).
- **모델**: `us.anthropic.claude-sonnet-4-6` 기본. `.env`의 `BEDROCK_MODEL_ID`로 오버라이드 가능 (예: Opus 4.7 승격).
- **리전**: `AWS_REGION` (기본 `us-west-2`).
- **인증**: `AWS_BEARER_TOKEN_BEDROCK` — 환경변수 한 줄로 끝. AWS SDK v3가 자동 인식.
- **프롬프트 캐싱**: 시스템 블록에 `cache_control: {"type": "ephemeral"}`.

```ts
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

const client = new AnthropicBedrock({
  awsRegion: process.env.AWS_REGION ?? "us-west-2",
});

const resp = await client.messages.create({
  model: process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-6",
  max_tokens: 1024,
  system: [{
    type: "text", text: SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
  }],
  messages: [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
      { type: "text", text: userInstruction },
    ],
  }],
});
```

**시스템 프롬프트**
```
너는 3D Gaussian Splatting으로 렌더된 매장/공간 이미지를 분석하는 어시스턴트다.
규칙:
- 반드시 유효한 JSON 배열만 출력한다. 설명, 마크다운 펜스, 코멘트 금지.
- 스키마: [{"label": "<물체명>", "bbox": [x1, y1, x2, y2]}]
- 좌표는 이미지 크기 기준 0~1 정규화, 원점은 좌상단.
- 물체를 찾지 못했으면 빈 배열 [] 만 출력한다.
- 배경(벽, 바닥, 천장), 가림막, 원경은 절대 포함하지 않는다.
```

**유저 메시지**
- `mode=target`: `"이미지에서 \"{target}\"에 해당하는 물체를 모두 찾아 bbox를 반환하라."`
- `mode=all`: `"이미지에 보이는 모든 구별 가능한 개별 물체를 찾아 각각 bbox를 반환하라."`

---

## 5. 중복 제거 정책

서버 미들웨어에서 응답 직전에 수행.

- **다른 label**: 겹쳐도 둘 다 유지.
- **같은 label**: IoU ≥ 0.5면 면적 큰 것 하나만 남김.

---

## 6. 2D bbox → 3D BoxRegion 변환 (`editor.js`)

`createBoxFromScreenBBox(bbox)` 신규 메서드:
1. bbox 4 꼭짓점 NDC 변환.
2. 각 꼭짓점 → Raycaster → splatMesh 교점.
3. 교점 ≥ 2: 중심 = 평균, `size.x/size.z` = XZ bounding + 10% padding, `size.y` = max(y 범위, 0.3).
4. 교점 1: 기본 `defaultSize(0.5)`.
5. 교점 0: skip.
6. `createBox(center, size, {activate:false})` 호출해 **active 상태로 만들지 않음**.

---

## 7. UI (`index.html`)

우측 하단 Claude 패널:
```
┌──────────────────────────────┐
│ Claude 물체 감지             │
│ [찾을 물건 입력_______]      │
│ [ 🔍 Claude ] [ 전체 ]       │
│ 상태: idle / 분석 중… / ok   │
└──────────────────────────────┘
```
- 입력 빈 값이면 [Claude] 비활성.
- 호출 중엔 두 버튼 disabled + 스피너.
- 에러 시 빨간 텍스트.

---

## 8. 캡처 저장

- 폴더: `vmd_test/captures/` (gitignore).
- 저장: **PNG만**. 파일명 `YYYYMMDD-HHMMSS.png`.
- 감지 결과 JSON은 저장하지 않음.

---

## 9. 파일 구조

```
vmd_test/
├── index.html              (수정)
├── main.js                 (수정)
├── editor.js               (수정)
├── captures/               (신규, gitignore)
├── vite.config.ts          (신규)
├── package.json            (신규)
├── tsconfig.json           (신규, 미들웨어 ts 컴파일용)
├── .env                    (신규, gitignore)
├── .env.example            (신규)
├── claude_vmd_report.md    (이 문서)
└── .gitignore              (captures/, .env, node_modules/ 추가)
```

---

## 10. 시크릿 / .env

`vmd_test/.env`:
```
AWS_BEARER_TOKEN_BEDROCK=<발급받은 토큰>
AWS_REGION=us-west-2
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6
```
- Vite dev 프로세스가 `dotenv/config`로 읽어 `process.env`에 주입. 브라우저에는 **절대 노출되지 않음**.
- `.gitignore`에 `.env` 포함 — 토큰 커밋 방지.

---

## 11. vite.config.ts 요지

- `resolve.alias`:
  - `three` → `../spark/node_modules/three/build/three.module.js`
  - `three/addons/` → `../spark/node_modules/three/examples/jsm/`
  - `@sparkjsdev/spark` → `../spark/dist/spark.module.js`
- `server.fs.allow`: `['.', '../spark']` (root 밖 리소스 서빙 허용).
- `optimizeDeps.exclude`: `['three', '@sparkjsdev/spark']`.
- `plugins`: `configureServer` 훅에서 `/api/detect` 라우트 등록 + Bedrock 호출 + 캡처 저장 + IoU 중복 제거.

---

## 12. 실행 방법

```bash
cd /Users/bagseong-yeong/Desktop/3d_project/vmd_test
npm install                     # 최초 1회
cp .env.example .env            # 토큰 입력
npm run dev                     # vite --port 8080
# → http://localhost:8080/
```

---

## 13. 리스크 / 검증 포인트

1. **Claude vision 정확도** — splat 노이즈 영향. 첫 테스트 후 프롬프트 튜닝 또는 Opus 승격.
2. **3D 정합성** — 4점 raycast로 보수적 bbox. 사용자가 이동 모드로 미세 조정.
3. **지연** — 2~8초. 버튼 disabled + 스피너.
4. **비용** — 호출당 $0.01~0.05 (Sonnet).
5. **토큰 수명** — 만료 시 `.env` 갱신 후 dev 서버 재시작.
6. **좌표 clamp** — Claude 응답 `[0,1]` 범위 강제.

---

## 14. 확정 정책

- 자동 생성 박스는 active로 만들지 않음 (cyan 기본색).
- 같은 label + IoU ≥ 0.5 → 면적 큰 것 하나.
- 감지 결과 JSON 저장 안 함. PNG 캡처만.

---

## 15. 구현 단계

1. `package.json`, `vite.config.ts`, `.env.example`, `.gitignore` 업데이트.
2. Vite 미들웨어에 `/api/detect` 스켈레톤 (PNG 저장만, `detections: []`).
3. AnthropicBedrock 호출 + JSON 파싱 + IoU dedupe.
4. 프론트 Claude 패널 UI.
5. `createBoxFromScreenBBox` + non-active 옵션.
6. E2E 스모크 테스트, 프롬프트 튜닝.

---

## 16. 검증 체크리스트

- [ ] `npx vite --port 8080` 한 번으로 전체 동작.
- [ ] Claude 패널에서 "종이컵" + [Claude] → 해당 물체에 BoxRegion 생성.
- [ ] [전체] → 여러 BoxRegion 일괄 생성.
- [ ] 자동 생성 박스는 cyan 기본색(active X).
- [ ] 같은 label 중복 IoU ≥ 0.5 → 하나만.
- [ ] `captures/`에 PNG만 쌓임.
- [ ] `.env`, `captures/`가 git에 올라가지 않음.
- [ ] 기존 모드(카메라/선택/이동/삭제/속성) 정상 동작.



 그 하기전에 단계를 표형태로  먼저 보여줘봐                    
                                                              
⏺ #: 1                                                          
  단계: 의존성 설정                                             
  파일: vmd_test/package.json                                   
  내용: vite, @anthropic-ai/bedrock-sdk, dotenv              
  비고: 이미 생성됨                                             
  ────────────────────────────────────────                      
  #: 2                                                       
  단계: 환경변수 템플릿                                         
  파일: vmd_test/.env.example                                   
  내용: AWS_BEARER_TOKEN_BEDROCK, AWS_REGION, BEDROCK_MODEL_ID  
  비고: 실제 .env는 사용자가 채움                               
  ────────────────────────────────────────                    
  #: 3                                                          
  단계: .gitignore 업데이트
  파일: vmd_test/.gitignore                                     
  내용: captures/, .env, node_modules/, dist/ 추가            
  비고: 토큰 커밋 방지                
  ────────────────────────────────────────
  #: 4                                                          
  단계: Vite 설정 + API 미들웨어
  파일: vmd_test/vite.config.ts                                 
  내용: three/spark alias + /api/detect 핸들러 (캡처 저장 +   
    Bedrock 호출 + IoU dedupe)        
  비고: 핵심 파일
  ────────────────────────────────────────
  #: 5                                                          
  단계: 프론트 UI
  파일: vmd_test/index.html                                     
  내용: 우측 하단 Claude 패널 (입력 + 버튼 2개 + 상태) CSS·HTML
    추가                              
  비고: 기존 구조 유지
  ────────────────────────────────────────
  #: 6                                                          
  단계: 에디터 확장
  파일: vmd_test/editor.js                                      
  내용: createBox(...)에 activate 옵션,                       
    createBoxFromScreenBBox(bbox) 메서드 신규
  비고: 자동 생성 박스 non-active
  ────────────────────────────────────────
  #: 7                                                          
  단계: 프론트 로직
  파일: vmd_test/main.js                                        
  내용: 캔버스 캡처 helper, fetch 호출, bbox→3D 변환, 버튼/입력
    이벤트 바인딩                     
  비고: 로딩/에러 UI
  ────────────────────────────────────────
  #: 8                                                          
  단계: 의존성 설치
  파일: —                                                       
  내용: npm install (background)                              
  비고: 수 분 소요 가능               
  ────────────────────────────────────────
  #: 9                                                          
  단계: 스모크 테스트
  파일: —                                                       
  내용: npm run dev → 브라우저 접속 후 기존 기능 회귀 + API   
    라우트 응답 확인                  
  비고: 실제 Bedrock 호출은 .env 채운 후 사용자 측에서
  ────────────────────────────────────────
  #: 10                                                         
  단계: 커밋
  파일: —                                                       
  내용: feat: Claude Bedrock 자동 박스 지정 기능              
  비고: .env/captures/ 제외 확인   