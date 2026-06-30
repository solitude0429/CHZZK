# CHZZK

개인용 Firefox WebExtension 프로젝트입니다. 시작점은 MIT 라이선스의 `bass9030/FUCK-CHZZK-GRID`이며,
프로젝트명과 사용자 표시 이름은 `CHZZK`으로 정리했습니다.

## 목표

- CHZZK 라이브 페이지에서 사용자가 접근 가능한 고화질 재생을 더 안정적으로 선택합니다.
- CHZZK 플레이어 DOM/URL 형식이 조금 바뀌어도 깨지지 않도록 테스트 가능한 구조로 바꿉니다.
- 빌드, lint, manifest 검증, unit test를 CI에서 돌립니다.

## 범위

이 저장소는 개인 사용과 실험을 위한 브라우저 확장입니다. DRM, 계정/구독/지역 제한, 결제/접근제어 우회,
원격 코드 실행, 토큰/쿠키 수집은 구현하지 않습니다. 로그에는 signed URL query, 쿠키, 토큰 같은 민감값을
남기지 않는 방향으로 작업합니다.

## 개발

```bash
npm ci
npm run verify
```

개별 검증:

```bash
npm run validate:manifest
npm run lint
npm test
npm run build
```

## Firefox 임시 프로필에서 실행

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

실제 PC에서 테스트할 때는 메인 프로필 대신 임시 프로필을 권장합니다.

## 수동 확인 포인트

1. `about:debugging#/runtime/this-firefox`에서 임시로 확장을 로드합니다.
2. CHZZK 라이브 페이지를 엽니다.
3. 화질 메뉴에서 `CHZZK` 배지가 붙은 항목을 선택합니다.
4. 개발자도구 Network 탭에서 실제 HLS 요청 품질을 확인합니다.
5. 콘솔에서 `[CHZZK] observed HLS qualities` 로그를 확인합니다. 이 로그는 query/hash를 제거한 URL만 표시합니다.
6. 문제가 있으면 URL query/cookie/token은 제거하고 DOM/HLS fixture만 저장합니다.

## 라이선스/출처

- 원본 프로젝트: `bass9030/FUCK-CHZZK-GRID`
- 라이선스: MIT
- 자세한 내용: `LICENSE`, `NOTICE`
