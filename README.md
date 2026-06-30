# CHZZK

개인용 Firefox WebExtension 프로젝트입니다. 시작점은 MIT 라이선스의 `bass9030/FUCK-CHZZK-GRID`이지만,
현재 구조는 기존 확장과 다르게 **화질 메뉴를 속여 표시하지 않고**, 네트워크 레벨에서 CHZZK HLS playlist 요청을
네이버가 제공하는 최고 목표 화질로 정규화합니다.

## 목표

- **네이버 라이브 스트리밍 커넥터/NLiveConnector 설치 없이** CHZZK 고화질 시청을 가능하게 합니다.
- 어떤 화질이 선택되어 있더라도 target보다 낮은 숫자 화질 HLS playlist 요청을 최고 목표 화질로 redirect합니다.
- 현재 target은 `policy/quality-policy.json`의 `1080p`입니다.
- 화질 메뉴의 `480p` 항목을 `1080p with CHZZK GRID™`처럼 표시하지 않습니다.
- DOM을 조작하지 않으므로 CHZZK 플레이어 DOM 구조가 바뀌어도 핵심 동작이 깨지지 않도록 합니다.
- 확장 아이콘은 CHZZK 공식 favicon을 사용합니다.

## 동작 방식

확장은 generated static DNR ruleset을 사용합니다. Rule은 현재 화질 목록을 하나씩 열거하지 않고,
`targetQuality`보다 낮은 숫자 화질 범위를 regex로 생성합니다.

예: target `1080p`, min `100p`일 때:

```text
100p~1079p playlist  → 1080p playlist
1080p playlist       → 그대로 유지
1440p playlist       → 그대로 유지
```

따라서 현재 CHZZK의 360/480/720뿐 아니라 나중에 540/900/1000p 같은 낮은 중간 화질이 생겨도 별도 코드 수정 없이
`1080p`로 redirect됩니다. 반대로 나중에 `1440p` 같은 더 높은 화질이 관측되면 diagnostics analyzer가 target 변경을 제안합니다.

## 개발

```bash
npm ci
npm run verify
```

개별 검증:

```bash
npm run render:rules
npm run validate:manifest
npm run lint
npm run lint:webext
npm test
npm run build
```

`rules.json`은 생성물입니다. 직접 수정하지 말고 `policy/quality-policy.json`을 수정한 뒤 `npm run render:rules`를 실행하세요.

## Firefox 임시 프로필에서 실행

```bash
npx web-ext run --source-dir . --firefox-profile /tmp/chzzk-firefox-profile
```

실제 PC에서 테스트할 때는 메인 프로필 대신 임시 프로필을 권장합니다.

## 사용 방법

1. `about:debugging#/runtime/this-firefox`에서 임시로 확장을 로드하거나, 서명된 XPI를 설치합니다.
2. CHZZK 라이브 페이지를 엽니다.
3. 화질 메뉴에서는 아무 화질이나 선택해도 됩니다. 확장이 낮은 HLS playlist 요청을 target quality로 redirect합니다.
4. 개발자도구 Network 탭에서 `chunklist_1080p.m3u8` 또는 `/1080p/...m3u8` 요청이 계속 표시되는지 확인합니다.
5. 확장 아이콘을 눌러 diagnostics popup에서 redacted HLS 샘플/quality 통계를 확인할 수 있습니다.

## 네이버 패치 대응 흐름

1. 확장 popup에서 diagnostics JSON을 복사합니다.
2. 저장소에서 다음을 실행합니다.

```bash
npm run diagnostics:analyze -- diagnostics.json
```

3. 더 높은 target이 관측되면 다음 명령으로 policy와 `rules.json`을 갱신할 수 있습니다.

```bash
npm run diagnostics:analyze -- diagnostics.json --apply
npm run verify
```

## 정식 서명 설치

Firefox Release/Beta에 일반 설치하려면 Mozilla 서명이 필요합니다. 개인용이면 AMO unlisted 채널을 사용합니다.
자세한 절차는 `docs/SIGNING.md`를 확인하세요.

## NLiveConnector 팝업이 계속 뜰 때

네이버 라이브 스트리밍 커넥터(NLiveConnector)를 제거한 뒤 사용하세요. 제거 후에도
`naverliveconnector` 링크 허용 팝업이 계속 뜨면 `reg/fix-live-connector.reg` 내용을 확인한 뒤 Windows에서 적용할 수 있습니다.

## 라이선스/출처

- 원본 프로젝트: `bass9030/FUCK-CHZZK-GRID`
- Chrome 포팅 참고: `refracta/FUCK-CHZZK-GRID-CHROME`
- CHZZK 공식 favicon: `https://ssl.pstatic.net/static/nng/glive/icon/favicon.png`
- 라이선스: MIT
- 자세한 내용: `LICENSE`, `NOTICE`
