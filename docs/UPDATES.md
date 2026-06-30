# Firefox 자동 업데이트

이 저장소는 self-distributed/unlisted Firefox 확장을 GitHub Release와 GitHub Pages로 업데이트합니다.

## 구조

- 확장 `manifest.json`의 `browser_specific_settings.gecko.update_url`:
  - `https://solitude0429.github.io/CHZZK/updates.json`
- `updates.json`은 GitHub Pages에 배포됩니다.
- `updates.json`의 `update_link`는 해당 버전의 GitHub Release signed XPI를 가리킵니다.
- `updates.json`에는 signed XPI의 `sha256` 해시가 함께 들어갑니다.

## 첫 설치 주의

자동 업데이트는 `update_url`이 들어 있는 버전부터 동작합니다. `0.0.1`에는 `update_url`이 없었기 때문에, 자동 업데이트를 쓰려면 `0.0.2` 이상 signed XPI를 한 번 수동 설치해야 합니다.

이전에 더 높은 번호의 실험 버전을 설치했다면 Firefox 업데이트 경로로 `0.0.x`가 들어가지 않습니다. 그 경우 기존 확장을 제거한 뒤 최신 signed XPI를 설치하세요.

## 릴리즈 절차

1. 버전을 올립니다.

```bash
npm version patch --no-git-tag-version
```

2. 변경 사항을 PR로 병합합니다.
3. GitHub Actions에서 `Sign and publish Firefox add-on` workflow를 실행합니다.
4. workflow가 다음을 수행합니다.
   - `npm run verify`
   - AMO unlisted signing
   - signed XPI 파일명 정규화
   - GitHub Release 생성/갱신
   - `updates.json` 생성
   - GitHub Pages 배포

## 검증

배포 후 다음 URL이 열려야 합니다.

```text
https://solitude0429.github.io/CHZZK/updates.json
```

로컬에서 update manifest를 만들고 검증하려면 signed XPI가 필요합니다.

```bash
npm run build:update-manifest
npm run validate:update-manifest
```

Firefox는 기본적으로 주기적으로 확장 업데이트를 확인합니다. 수동 확인은 `about:addons` → 톱니바퀴 메뉴 → 업데이트 확인에서 할 수 있습니다.
