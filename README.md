# CHZZK

개인용 Firefox WebExtension 프로젝트입니다. 시작점은 MIT 라이선스의 `bass9030/FUCK-CHZZK-GRID`이지만,
현재 구조는 기존 확장과 다르게 **화질 메뉴를 속여 표시하지 않고**, 네트워크 레벨에서 CHZZK HLS playlist 요청을
네이버가 제공하는 최고 목표 화질로 정규화합니다.

## 목표

- **네이버 라이브 스트리밍 커넥터/NLiveConnector 설치 없이** CHZZK 고화질 시청을 가능하게 합니다.
- 어떤 화질이 선택되어 있더라도 낮은 화질 HLS playlist 요청을 최고 목표 화질인 `1080p`로 redirect합니다.
- 화질 메뉴의 `480p` 항목을 `1080p with CHZZK GRID™`처럼 표시하지 않습니다.
- DOM을 조작하지 않으므로 CHZZK 플레이어 DOM 구조가 바뀌어도 핵심 동작이 깨지지 않도록 합니다.
- 확장 아이콘은 CHZZK 공식 favicon을 사용합니다.

## 동작 방식

확장은 content script/background injection 없이 static DNR ruleset만 사용합니다.

```text
chunklist_144p.m3u8  ┐
chunklist_240p.m3u8  │
chunklist_270p.m3u8  │
chunklist_360p.m3u8  ├─→ chunklist_1080p.m3u8
chunklist_480p.m3u8  │
chunklist_720p.m3u8  ┘
/360p/chunklist.m3u8 ─→ /1080p/chunklist.m3u8
/720p/chunklist.m3u8 ─→ /1080p/chunklist.m3u8
```

이미 `1080p`인 playlist 요청은 그대로 둡니다. URL query/hash는 redirect 시 보존되어 signed URL tail을 잃지 않습니다.

## 개발

```bash
npm ci
npm run verify
```

개별 검증:

```bash
npm run validate:manifest
npm run lint
npm run lint:webext
npm test
npm run build
```

## Firefox 임시 프로필에서 실행

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

실제 PC에서 테스트할 때는 메인 프로필 대신 임시 프로필을 권장합니다.

## 사용 방법

1. `about:debugging#/runtime/this-firefox`에서 임시로 확장을 로드하거나 릴리즈 ZIP을 설치합니다.
2. CHZZK 라이브 페이지를 엽니다.
3. 화질 메뉴에서는 아무 화질이나 선택해도 됩니다. 확장이 낮은 HLS playlist 요청을 `1080p`로 redirect합니다.
4. 개발자도구 Network 탭에서 `chunklist_1080p.m3u8` 또는 `/1080p/...m3u8` 요청이 계속 표시되는지 확인합니다.

## NLiveConnector 팝업이 계속 뜰 때

네이버 라이브 스트리밍 커넥터(NLiveConnector)를 제거한 뒤 사용하세요. 제거 후에도
`naverliveconnector` 링크 허용 팝업이 계속 뜨면 `reg/fix-live-connector.reg` 내용을 확인한 뒤 Windows에서 적용할 수 있습니다.

## 라이선스/출처

- 원본 프로젝트: `bass9030/FUCK-CHZZK-GRID`
- Chrome 포팅 참고: `refracta/FUCK-CHZZK-GRID-CHROME`
- CHZZK 공식 favicon: `https://ssl.pstatic.net/static/nng/glive/icon/favicon.png`
- 라이선스: MIT
- 자세한 내용: `LICENSE`, `NOTICE`
