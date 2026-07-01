# Firefox 자동 업데이트

이 저장소는 self-distributed/unlisted Firefox 확장을 내부 HTTPS update host로 업데이트합니다. 최신 확장 런타임은 외부 telemetry collector를 사용하지 않고, CHZZK live HLS 요청에서 생성한 redacted diagnostics를 브라우저 로컬 확장 저장소에만 보관합니다.

## 구조

- 확장 `manifest.json`의 `browser_specific_settings.gecko.update_url`:
  - `https://chzzk-updates.alpha-apple.dedyn.io/updates.json`
- `updates.json`과 signed XPI는 VPS nginx의 `/var/www/chzzk-updates/`에서 제공됩니다.
- GitHub Release는 서명 산출물의 원본 보관소입니다.
- `Sign and publish Firefox add-on` workflow가 signed XPI, source zip, update-site artifact를 생성하고 GitHub Release를 생성/갱신합니다.
- VPS 배포 스크립트가 private GitHub Release에서 signed XPI/source ZIP을 내려받고, GitHub artifact attestation이 예상 source commit과 signing workflow에 묶여 있는지 검증한 뒤 내부 update host에 복사합니다.
- `updates.json`에는 signed XPI의 `sha256` 해시가 함께 들어갑니다.

## 데이터/진단

- 확장 popup은 active tab rule, last decision, redacted HLS samples, observed qualities만 보여줍니다.
- 외부 collector 전송 UI와 manifest data collection consent는 제거되었습니다.
- Firefox manifest는 `data_collection_permissions.required: ["none"]`을 선언합니다.
- 과거 collector 운영 스크립트가 저장소에 남아 있더라도, 최신 확장 런타임/manifest/package에는 collector endpoint permission이 포함되지 않습니다.

## 첫 설치 주의

자동 업데이트는 `update_url`이 들어 있는 버전부터 동작합니다. 기존 설치본에 `update_url`이 없었다면 signed XPI를 한 번 수동 설치해야 합니다.

이전에 더 높은 번호의 실험 버전을 설치했다면 Firefox 업데이트 경로로 `0.0.x`가 들어가지 않습니다. 그 경우 기존 확장을 제거한 뒤 최신 signed XPI를 설치하세요.

## 릴리즈 절차

1. 버전을 올립니다.

```bash
npm version patch --no-git-tag-version
```

2. 변경 사항을 PR로 병합합니다.
3. `main`에 `manifest.json`, `package.json`, `package-lock.json`, 또는 `.github/workflows/sign-unlisted.yml` 변경이 push되면 `Sign and publish Firefox add-on` workflow가 실행됩니다. 수동 실행이 필요하면 Actions → `Sign and publish Firefox add-on` → Run workflow를 사용합니다.
4. workflow가 다음을 수행합니다.
   - `npm run verify`
   - protected ref / `firefox-signing` environment gate 확인
   - AMO unlisted signing
   - signed XPI 파일명 정규화
   - GitHub artifact attestation 생성
   - GitHub Release 생성/갱신
   - update-site artifact 생성
5. VPS에서 내부 update host를 배포합니다.

배포 host의 GitHub CLI는 `gh attestation verify`를 지원해야 합니다. 배포 시 기본값은 현재 checkout commit을 source digest로 사용하며, 필요하면 `CHZZK_SOURCE_COMMIT`, `CHZZK_SOURCE_REPOSITORY`, `CHZZK_SIGNING_WORKFLOW_REF`로 명시합니다.

```bash
npm run deploy:updates:internal
```

## 검증

배포 후 다음 URL이 열려야 합니다.

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
```

로컬에서 update manifest를 만들고 검증하려면 signed XPI가 필요합니다.

```bash
npm run build:update-manifest
npm run validate:update-manifest
```

Firefox는 기본적으로 주기적으로 확장 업데이트를 확인합니다. 수동 확인은 `about:addons` → 톱니바퀴 메뉴 → 업데이트 확인에서 할 수 있습니다.
