# CHZZK

개인용 Firefox WebExtension 프로젝트입니다. 시작점은 MIT 라이선스의 `bass9030/FUCK-CHZZK-GRID`이며,
프로젝트명과 사용자 표시 이름은 `CHZZK`으로 정리했습니다.

## 목표

- **네이버 라이브 스트리밍 커넥터/NLiveConnector 설치 없이** CHZZK 고화질 시청을 가능하게 합니다.
- 원본 `FUCK-CHZZK-GRID`의 핵심 방식처럼, 플레이어의 `480p` 화질 항목을 고화질 우회 항목으로 표시하고
  HLS playlist 요청의 `480p` 경로를 `1080p`로 redirect합니다.
- CHZZK 플레이어 DOM/URL 형식이 조금 바뀌어도 깨지지 않도록 테스트 가능한 구조로 유지합니다.
- 빌드, lint, manifest 검증, unit test를 CI에서 돌립니다.

## 동작 방식

1. CHZZK 라이브 페이지에서 `inject.js`가 화질 메뉴의 `480p` 항목을 `1080p with CHZZK GRID™`로 표시합니다.
2. 사용자가 이 항목을 선택하면 플레이어는 내부적으로 480p playlist를 요청합니다.
3. 확장의 static DNR rule이 `chunklist_480p.m3u8` 또는 `/480p/...m3u8` 요청을 `1080p` 경로로 redirect합니다.
4. 따라서 네이버 라이브 스트리밍 커넥터 설치 없이 1080p HLS playlist 요청이 발생하는지 Network 탭에서 확인할 수 있습니다.

## 범위

이 저장소는 개인 사용과 실험을 위한 브라우저 확장입니다. 원격 코드 실행, 토큰/쿠키 수집은 구현하지 않습니다.
로그에는 signed URL query, 쿠키, 토큰 같은 민감값을 남기지 않는 방향으로 작업합니다.

## 개발

```bash
npm ci
npm run verify
```

개별 검증:

```bash
npm run bundle:inject
npm run validate:manifest
npm run lint
npm run lint:webext
npm test
npm run build
```

`inject.js`는 빌드 산출물입니다. 런타임 로직은 `src/inject-main.js`와 `src/shared/*.js`를 수정한 뒤
`npm run bundle:inject`로 갱신합니다.

## Firefox 임시 프로필에서 실행

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

실제 PC에서 테스트할 때는 메인 프로필 대신 임시 프로필을 권장합니다.

## 사용 방법

1. `about:debugging#/runtime/this-firefox`에서 임시로 확장을 로드하거나 릴리즈 ZIP을 설치합니다.
2. CHZZK 라이브 페이지를 엽니다.
3. 화질 메뉴에서 `1080p with CHZZK GRID™` 항목을 선택합니다.
4. 개발자도구 Network 탭에서 `chunklist_1080p.m3u8` 또는 `/1080p/...m3u8` 요청이 계속 표시되는지 확인합니다.

## NLiveConnector 팝업이 계속 뜰 때

네이버 라이브 스트리밍 커넥터(NLiveConnector)를 제거한 뒤 사용하세요. 제거 후에도
`naverliveconnector` 링크 허용 팝업이 계속 뜨면 `reg/fix-live-connector.reg` 내용을 확인한 뒤 Windows에서 적용할 수 있습니다.

## 라이선스/출처

- 원본 프로젝트: `bass9030/FUCK-CHZZK-GRID`
- Chrome 포팅 참고: `refracta/FUCK-CHZZK-GRID-CHROME`
- 라이선스: MIT
- 자세한 내용: `LICENSE`, `NOTICE`
