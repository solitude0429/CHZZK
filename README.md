# CHZZK

개인용 Firefox WebExtension 프로젝트입니다. 화질 메뉴를 속여 표시하지 않고, CHZZK live tab에서 관측된 신뢰 가능한 HLS playlist 요청에만 탭 단위 session DNR redirect를 설치합니다.

## 현재 버전

- `0.0.6`
- telemetry/session-rule hardening을 릴리즈 산출물에 반영한 패치입니다.
- collector 전송은 기본 local-only이며, popup에서 명시적으로 켠 category만 외부 collector로 전송합니다.
- 이후 변경은 patch/minor 단위로 올립니다.

## 현재 동작 요약

이 확장은 CHZZK/NAVER가 제공하는 모든 방송의 실제 최고 화질을 보장하지 않습니다. 현재 정책은 `policy/quality-policy.json`의 `targetQuality`를 기준으로 동작합니다.

현재 기본 정책:

```text
targetQuality: 1080p
minRedirectQuality: 100p
trustedRequestDomains: akamaized.net, navercdn.com, pstatic.net
```

동작 방식은 다음과 같습니다.

- CHZZK live tab에서 신뢰 가능한 CDN의 HLS playlist 요청을 관측합니다.
- URL path에서 `chunklist_720p.m3u8` 또는 `/720p/...m3u8` 같은 숫자 화질 label을 파싱합니다.
- 현재 화질이 `minRedirectQuality` 이상이고 `targetQuality`보다 낮으면, 해당 tab에만 session DNR redirect rule을 설치합니다.
- 설치된 rule은 이후 같은 tab의 낮은 숫자 화질 playlist 요청을 `targetQuality` 값으로 재작성합니다.
- `targetQuality` 이상으로 보이는 요청은 재작성하지 않습니다.

즉 현재 release의 화질 정책은 “무조건 최고 화질 강제”가 아니라 **낮은 숫자 HLS playlist 요청을 설정된 target인 `1080p`로 시도하도록 재작성**하는 구조입니다.

## 목표와 비목표

### 목표

- 네이버 라이브 스트리밍 커넥터/NLiveConnector 설치 없이, CHZZK live HLS 요청을 설정된 target quality로 재작성하는 것을 시도합니다.
- 화질 메뉴의 `480p` 항목을 `1080p with CHZZK GRID™`처럼 속여 표시하지 않습니다.
- DOM을 조작하지 않고, `scripting` 권한 없이 동작합니다.
- redirect는 항상-on static ruleset이 아니라 **CHZZK live tab에서 HLS 요청이 관측된 뒤 해당 tab에만 설치되는 session rule**입니다.
- 확장 아이콘은 CHZZK favicon을 사용합니다.

### 비목표

- CHZZK/NAVER가 현재 제공하지 않는 화질을 만들어내지 않습니다.
- 모든 방송에서 `1080p`가 실제 재생 가능하다고 보장하지 않습니다.
- player UI의 화질 메뉴를 조작하거나 가짜 화질 label을 표시하지 않습니다.
- global static DNR rule로 모든 CDN 요청을 상시 redirect하지 않습니다.

## 아키텍처

### 1. Global static DNR 제거

`manifest.json`에는 `declarative_net_request.rule_resources`가 없습니다. 즉 브라우저 시작부터 모든 CDN 요청에 항상 켜져 있는 static redirect rule을 싣지 않습니다.

### 2. Session-scoped redirect

background runtime은 다음 조건을 모두 만족하는 요청을 관측했을 때만 `declarativeNetRequest.updateSessionRules()`로 session rule을 설치합니다.

- `tabId`가 유효하고 owned session rule ID 범위 안에 있음
- page context가 `https://chzzk.naver.com/live/...`
- request domain이 정책상 허용된 CDN domain
- resource type이 `media` 또는 `xmlhttprequest`
- method가 `GET`
- HLS URL에서 숫자 화질 segment를 파싱 가능
- 현재 화질이 `minRedirectQuality` 이상이고 `targetQuality`보다 낮음

설치된 rule은 해당 `tabId`에만 적용되고, tab이 닫히면 제거됩니다. Firefox가 tab URL 변경을 노출하는 경우 CHZZK live 밖으로 이동할 때도 제거합니다. 브라우저 재시작 시 session rule은 유지되지 않습니다.

### 3. CHZZK-only telemetry

CHZZK live 페이지에서만 다음 정보를 수집할 수 있습니다.

- redacted HLS quality/decision 통계
- session rule 오류 요약
- live page DOM 구조 fingerprint/tag count/class token summary
- page error/unhandled rejection 요약

외부 collector 전송은 기본값이 꺼져 있습니다. popup에서 `collector 전송 사용`을 켠 뒤 diagnostics/structure/errors category를 개별적으로 켠 경우에만 collector로 전송합니다.

수집 범위는 `https://chzzk.naver.com/live/*`와 신뢰 CDN HLS 요청으로 제한됩니다. URL query string, signed CDN 정책값, chat text, 페이지 텍스트, 쿠키, 인증정보는 보내지 않습니다.

collector endpoint:

```text
https://chzzk-report.alpha-apple.dedyn.io/report
```

### 4. Quality policy range

현재 target `1080p`, min `100p` 기준:

```text
100p~1079p playlist  → 1080p playlist로 재작성 시도
1080p playlist       → 그대로 유지
1440p playlist       → 그대로 유지
```

이 범위는 현재 menu 값 목록을 직접 나열하지 않고 숫자 범위로 생성됩니다. 따라서 540/900/1000p 같은 중간 화질 label이 관측돼도 `targetQuality`보다 낮으면 같은 정책을 적용합니다. 반대로 1440p처럼 target보다 높은 label이 관측되면 diagnostics analyzer가 policy 상향 필요 여부를 제안할 수 있습니다.

## 개발

```bash
npm ci
npm run verify
```

개별 검증:

```bash
npm run format:check
npm run check:generated
npm run validate:manifest
npm run validate:project
npm run lint
npm run lint:webext
npm test
npm run test:ops
npm run audit:deps
npm run build
npm run audit:package
```

runtime 파일 `background.js`, `diagnostics.js`, `site-observer.js`는 생성물입니다. 직접 수정하지 말고 `src/runtime/*`, `src/shared/*`, `policy/quality-policy.json`을 수정한 뒤 `npm run build:runtime`를 실행하세요.

## Firefox 임시 프로필에서 실행

source checkout을 임시 로드할 때는 먼저 runtime bundle을 생성하세요.

```bash
npm ci
npm run build:runtime
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

실제 PC에서 테스트할 때는 메인 프로필 대신 임시 프로필을 권장합니다.

## 사용 방법

1. 서명된 XPI를 설치합니다. 개발 중 source checkout을 로드한다면 위의 `npm run build:runtime`을 먼저 실행합니다.
2. CHZZK live 페이지를 엽니다.
3. 낮은 화질 HLS playlist 요청이 처음 관측되면 해당 tab에 session redirect rule이 설치됩니다.
4. 이후 같은 tab의 낮은 숫자 화질 HLS playlist 요청은 `targetQuality`로 재작성됩니다.
5. 확장 popup에서 active tab/rule, decision reason, redacted HLS 샘플/quality 통계를 확인할 수 있습니다.
6. 외부 collector가 필요할 때만 popup의 telemetry 설정에서 collector와 필요한 category를 켭니다.

## 네이버 패치 대응 흐름

1. 확장 popup에서 diagnostics JSON을 복사합니다.
2. 저장소에서 다음을 실행합니다.

```bash
npm run diagnostics:analyze -- diagnostics.json
```

3. 더 높은 target이 필요하다고 판단되면 다음 명령으로 policy를 갱신할 수 있습니다.

```bash
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

URL shape가 변경된 경우에는 redacted fixture를 추가하고 `src/shared/quality.js` / `src/shared/session-rules.js` 테스트를 먼저 추가한 뒤 수정합니다.

## 정식 서명 설치

Firefox Release/Beta에 일반 설치하려면 Mozilla 서명이 필요합니다. 개인용이면 AMO unlisted 채널을 사용합니다. 자세한 절차는 `docs/SIGNING.md`를 확인하세요.

`0.0.4`부터는 자동 업데이트용 `update_url`이 들어 있습니다. `0.0.5`부터는 CHZZK live 전용 telemetry collector가 구조/오류 변동을 수집해 자동 패치 루프의 입력으로 사용할 수 있습니다. update manifest와 signed XPI는 내부 HTTPS update host의 `https://chzzk-updates.alpha-apple.dedyn.io/` 아래에 배포됩니다. 자세한 구조와 릴리즈 절차는 `docs/UPDATES.md`를 확인하세요.

주의: Mozilla unlisted signing은 Firefox 설치 가능성을 위한 서명이지, 네이버가 공식 승인한 프로그램이라는 의미가 아닙니다.

## NLiveConnector 팝업이 계속 뜰 때

네이버 라이브 스트리밍 커넥터/NLiveConnector를 제거한 뒤 사용하세요. 제거 후에도 `naverliveconnector` 링크 허용 팝업이 계속 뜨면 `reg/fix-live-connector.reg` 내용을 확인한 뒤 Windows에서 적용할 수 있습니다.

## 운영 문서

- `docs/AUTO_UPDATE_LOOP.md` — CHZZK-only telemetry collector와 Hermes 자동 패치 루프
- `docs/HARDENING.md` — telemetry/session-rule hardening 요약
- `docs/OPERATIONS.md` — 릴리즈/사고대응/패치대응 runbook
- `docs/SECURITY.md` — 민감정보 처리와 threat model
- `docs/SIGNING.md` — Firefox unlisted signing 절차
- `docs/TESTING.md` — 자동/수동 검증 절차
- `docs/TROUBLESHOOTING.md` — 문제 진단 절차
- `docs/UPDATES.md` — Firefox 자동 업데이트 구조와 릴리즈 절차

## 라이선스

- 라이선스: MIT
- 자세한 내용: `LICENSE`, `NOTICE`
