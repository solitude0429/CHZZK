# CHZZK

개인용 Firefox WebExtension 프로젝트입니다. 화질 메뉴를 속여 표시하지 않고, CHZZK live tab에서 관측된 신뢰 가능한 HLS 요청에만 탭 단위 session DNR redirect를 설치합니다.

## 현재 버전

- `0.0.2`
- `0.0.1` 설치 검증 이후 자동 업데이트 인프라를 추가한 첫 패치입니다.
- 이후 변경은 patch/minor 단위로 올립니다.

## 목표

- **네이버 라이브 스트리밍 커넥터/NLiveConnector 설치 없이** CHZZK 고화질 시청을 시도합니다.
- 현재 target보다 낮은 숫자 화질 HLS playlist 요청을 `policy/quality-policy.json`의 `targetQuality`로 redirect합니다.
- 화질 메뉴의 `480p` 항목을 `1080p with CHZZK GRID™`처럼 표시하지 않습니다.
- DOM을 조작하지 않고, content script/page injection/`scripting` 권한 없이 동작합니다.
- redirect는 항상-on static ruleset이 아니라 **CHZZK live tab에서 HLS 요청이 관측된 뒤 해당 tab에만 설치되는 session rule**입니다.
- 확장 아이콘은 CHZZK favicon을 사용합니다.

## 아키텍처

### 1. Global static DNR 제거

`manifest.json`에는 `declarative_net_request.rule_resources`가 없습니다. 즉 브라우저 시작부터 모든 CDN 요청에 항상 켜져 있는 static redirect rule을 싣지 않습니다.

### 2. Session-scoped redirect

background runtime은 다음 조건을 모두 만족하는 요청을 관측했을 때만 `declarativeNetRequest.updateSessionRules()`로 session rule을 설치합니다.

- `tabId`가 유효함
- page context가 `https://chzzk.naver.com/live/...`
- request domain이 정책상 허용된 CDN domain
- resource type이 `media` 또는 `xmlhttprequest`
- method가 `GET`
- HLS URL에서 숫자 화질 segment를 파싱 가능
- 현재 화질이 `minRedirectQuality` 이상이고 `targetQuality`보다 낮음

설치된 rule은 해당 `tabId`에만 적용되고, tab이 닫히면 제거됩니다. 브라우저 재시작 시 session rule은 유지되지 않습니다.

### 3. Future-proof quality range

현재 target `1080p`, min `100p` 기준:

```text
100p~1079p playlist  → 1080p playlist
1080p playlist       → 그대로 유지
1440p playlist       → 그대로 유지
```

따라서 현재 CHZZK의 360/480/720뿐 아니라 나중에 540/900/1000p 같은 낮은 중간 화질이 생겨도 별도 코드 수정 없이 같은 정책으로 처리됩니다. 반대로 1440p 같은 더 높은 화질이 관측되면 diagnostics analyzer가 target 변경을 제안합니다.

## 개발

```bash
npm ci
npm run verify
```

개별 검증:

```bash
npm run check:generated
npm run validate:manifest
npm run validate:project
npm run lint
npm run lint:webext
npm test
npm run audit:deps
npm run build
npm run audit:package
```

runtime 파일 `background.js`, `diagnostics.js`는 생성물입니다. 직접 수정하지 말고 `src/runtime/*`, `src/shared/*`, `policy/quality-policy.json`을 수정한 뒤 `npm run build:runtime`를 실행하세요.

## Firefox 임시 프로필에서 실행

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

실제 PC에서 테스트할 때는 메인 프로필 대신 임시 프로필을 권장합니다.

## 사용 방법

1. `about:debugging#/runtime/this-firefox`에서 임시로 확장을 로드하거나, 서명된 XPI를 설치합니다.
2. CHZZK live 페이지를 엽니다.
3. 낮은 화질 HLS 요청이 처음 관측되면 해당 tab에 session redirect rule이 설치됩니다.
4. 이후 같은 tab의 낮은 숫자 화질 HLS playlist 요청은 target quality로 redirect됩니다.
5. 확장 popup에서 active tab/rule, decision reason, redacted HLS 샘플/quality 통계를 확인할 수 있습니다.

## 네이버 패치 대응 흐름

1. 확장 popup에서 diagnostics JSON을 복사합니다.
2. 저장소에서 다음을 실행합니다.

```bash
npm run diagnostics:analyze -- diagnostics.json
```

3. 더 높은 target이 관측되면 다음 명령으로 policy를 갱신할 수 있습니다.

```bash
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

URL shape가 변경된 경우에는 redacted fixture를 추가하고 `src/shared/quality.js` / `src/shared/session-rules.js` 테스트를 먼저 추가한 뒤 수정합니다.

## 정식 서명 설치

Firefox Release/Beta에 일반 설치하려면 Mozilla 서명이 필요합니다. 개인용이면 AMO unlisted 채널을 사용합니다. 자세한 절차는 `docs/SIGNING.md`를 확인하세요.

`0.0.2`부터는 자동 업데이트용 `update_url`이 들어 있습니다. update manifest는 GitHub Pages의 `https://solitude0429.github.io/CHZZK/updates.json`에 배포되고, signed XPI는 GitHub Release asset으로 배포됩니다. 자세한 구조와 릴리즈 절차는 `docs/UPDATES.md`를 확인하세요.

주의: Mozilla unlisted signing은 Firefox 설치 가능성을 위한 서명이지, 네이버가 공식 승인한 프로그램이라는 의미가 아닙니다.

## NLiveConnector 팝업이 계속 뜰 때

네이버 라이브 스트리밍 커넥터/NLiveConnector를 제거한 뒤 사용하세요. 제거 후에도 `naverliveconnector` 링크 허용 팝업이 계속 뜨면 `reg/fix-live-connector.reg` 내용을 확인한 뒤 Windows에서 적용할 수 있습니다.

## 운영 문서

- `docs/OPERATIONS.md` — 릴리즈/사고대응/패치대응 runbook
- `docs/SECURITY.md` — 민감정보 처리와 threat model
- `docs/SIGNING.md` — Firefox unlisted signing 절차
- `docs/TESTING.md` — 자동/수동 검증 절차
- `docs/TROUBLESHOOTING.md` — 문제 진단 절차
- `docs/UPDATES.md` — Firefox 자동 업데이트 구조와 릴리즈 절차

## 라이선스

- 라이선스: MIT
- 자세한 내용: `LICENSE`, `NOTICE`
