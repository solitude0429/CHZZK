# Firefox 자동 업데이트

이 저장소는 self-distributed/unlisted Firefox 확장을 내부 HTTPS update host로 업데이트합니다. `0.0.5`부터는 CHZZK live 전용 telemetry collector가 오류/구조 변동을 수집하고, Hermes 자동 운영 루프가 그 데이터를 보고 패치/릴리즈 후보를 만듭니다.

## 구조

- 확장 `manifest.json`의 `browser_specific_settings.gecko.update_url`:
  - `https://chzzk-updates.alpha-apple.dedyn.io/updates.json`
- `updates.json`과 signed XPI는 VPS nginx의 `/var/www/chzzk-updates/`에서 제공됩니다.
- GitHub Release는 서명 산출물의 원본 보관소입니다.
- VPS 배포 스크립트가 private GitHub Release에서 signed XPI를 내려받고 내부 update host에 복사합니다.
- `updates.json`에는 signed XPI의 `sha256` 해시가 함께 들어갑니다.

## Telemetry collector

- Report endpoint:
  - `https://chzzk-report.alpha-apple.dedyn.io/report`
- Local service:
  - `chzzk-telemetry-collector.service`
- Storage:
  - `/var/lib/chzzk-telemetry/reports-YYYYMMDD.ndjson`
- Summary command:

```bash
sudo /usr/local/sbin/chzzk-telemetry-summary --since=-24h
```

Collector는 CHZZK live scope, schema version, add-on ID/version, event type을 검증하고 저장 전 payload를 다시 sanitize합니다. signed CDN query string, token/auth/session-like query, page text, chat text, cookie/header/authentication data는 저장하지 않습니다.

## 첫 설치 주의

자동 업데이트는 `update_url`이 들어 있는 버전부터 동작합니다. `0.0.1`에는 `update_url`이 없었고, `0.0.2`~`0.0.3`은 update host 정리 전 실험용이었기 때문에, 자동 업데이트를 쓰려면 `0.0.4` 이상 signed XPI를 한 번 수동 설치해야 합니다.

Telemetry 기반 자동 패치 루프까지 쓰려면 `0.0.5` 이상 signed XPI를 설치해야 합니다.

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
   - update-site artifact 생성
5. VPS에서 내부 update host를 배포합니다.

```bash
npm run deploy:updates:internal
```

## 검증

배포 후 다음 URL이 열려야 합니다.

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
https://chzzk-report.alpha-apple.dedyn.io/healthz
```

로컬에서 update manifest를 만들고 검증하려면 signed XPI가 필요합니다.

```bash
npm run build:update-manifest
npm run validate:update-manifest
```

Firefox는 기본적으로 주기적으로 확장 업데이트를 확인합니다. 수동 확인은 `about:addons` → 톱니바퀴 메뉴 → 업데이트 확인에서 할 수 있습니다.
