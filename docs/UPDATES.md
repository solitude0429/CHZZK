# Firefox 자동 업데이트

CHZZK는 Mozilla 서명된 unlisted XPI를 자체 HTTPS update host에서 배포한다.
Firefox는 `manifest.json`의 고정 `update_url`에서 `updates.json`을 읽는다.

```text
https://chzzk.home.arpa:8443/updates.json
```

## Release에서 update host까지

1. 로컬 operator가 `gh` keyring으로 exact protected `main`과 immutable Release를
   확인한다.
2. `gh release verify`와 canonical metadata 검증으로 tag, source SHA, 세 asset과
   build provenance를 결박한다.
3. asset을 private local temporary directory에 받고 activator의 전체 import
   graph와 `jszip`을 esbuild로 self-contained ESM file에 묶어 고유 SCP deployment
   bundle을 만든다.
4. Router를 경유하는 내부 `ssh server` 경로로 bundle을 보내 hidden transactional
   activation을 실행한다. GitHub credential은 서버로 보내지 않는다.
5. 서버 filesystem, loopback backend, Caddy와 PC production HTTPS에서 version,
   MIME, JSON, links와 SHA-256을 readback한다.
6. 실제 Windows PC의 disposable Firefox profile에서 이전 signed XPI가 고정
   `update_url`을 통해 새 signed XPI로 업데이트되는지 확인한다.

일반 제품 변경에서는 `ship`이 이 전체 과정을 수행한다.

```powershell
npm run chzzk -- deploy [version] --json
```

version을 생략하면 현재 canonical immutable Release를 사용한다. 이미 같은
generation과 stable links가 정확하면 성공한 idempotent no-op으로 끝난다.

## 배포 구조

각 version은 immutable directory에 배치한다.

```text
<target>/
  releases/
    <version>/
      chzzk-<version>-signed.xpi
      chzzk-<version>-release-metadata.json
      chzzk-<version>.zip
      updates.json
      index.html
      provenance.json
  current -> releases/<version>
  updates.json -> current/updates.json
  index.html -> current/index.html
  provenance.json -> current/provenance.json
```

`updates.json`과 landing-page link는 root-absolute immutable version path를
사용한다. `current`와 stable links를 journal 아래에서 원자적으로 바꾸므로
manifest와 XPI가 서로 다른 generation을 가리키지 않는다.

## 로컬 검증과 전송

`deploy`는 쓰기 전에 다음을 강제한다.

- 로그인한 `gh` identity와 pinned repository ID;
- exact tag가 가리키는 source commit과 release metadata source commit 일치;
- published Release의 `isImmutable: true`;
- 정확히 세 canonical asset과 valid GitHub build provenance;
- signed XPI structure, add-on ID, version, update URL, minimum Firefox와 signed state;
- private temporary directory, bounded file sizes와 exact SHA-256;
- bare import가 없는 self-contained bundled activator와 정확히 세 asset;
- 내부 SSH alias가 정확히 `server`이고 remote target이
  `/srv/admin/chzzk-updates`인지 확인.

전송 파일명에는 예측 불가능한 nonce를 포함한다. 기존 remote path를 덮어쓰지
않고, server activation이 성공·실패한 뒤에도 해당 작업이 만든 exact staging
path만 제거한다. 서버 Node는 bundled activator만 실행하므로 CHZZK checkout,
`node_modules`, `gh` login이나 GitHub token을 요구하지 않는다.

## 서버 activation

서버-side hidden operation은 bundle 안의 metadata와 artifact를 다시 검증하고
다음을 강제한다.

- symlink ancestor, foreign ownership와 group/world-writable managed path 거부;
- 고정 `admin` owner와 target boundary;
- process-bound advisory lock과 bounded wait;
- mutation 전에 fsync된 private rollback journal;
- file data와 parent directory fsync;
- 새 immutable release directory를 완성한 뒤 stable links 전환;
- backend와 Caddy에서 exact `updates.json`, XPI MIME/hash와 link readback;
- post-activation 검증 실패 시 이전 link snapshot 복구;
- SIGKILL/reboot 뒤 다음 실행에서 미완료 journal 복구 후 재시도.

Server release directory는 자동 삭제하지 않는다. 이전 generation은 명시적
rollback과 old-to-new Firefox update 검증에 필요하다.

## PC production-path readback

PC의 허용된 직접 통신은 Windows QoS DSCP 3 policy를 사용한다. Firefox와
PowerShell은 허용되지만 `curl.exe`는 Router gate에서 timeout될 수 있으므로
PowerShell HTTPS 결과를 기준으로 한다.

```powershell
$manifest = Invoke-WebRequest `
  -Uri "https://chzzk.home.arpa:8443/updates.json" `
  -UseBasicParsing `
  -TimeoutSec 15
$manifest.StatusCode
$manifest.Headers["Content-Type"]
$manifest.Content | ConvertFrom-Json
```

다음을 exact Release와 비교한다.

- `updates.json` status 200, JSON MIME와 canonical schema;
- version, add-on ID, minimum Firefox와 immutable update link;
- XPI status 200, `application/x-xpinstall` MIME, size와 SHA-256;
- `current`, `updates.json`, `index.html`, `provenance.json` symlink targets;
- metadata source repository/SHA와 provenance asset digests;
- landing page의 모든 local link.

## Disposable Firefox update gate

Update mode는 이전 signed XPI에 이미 고정된 production `update_url`을 사용한다.
별도 base-URL override를 받지 않으며 signature 또는 update trust preference를
낮추지 않는다.

```bash
CHZZK_OLD_SIGNED_XPI="/absolute/path/to/previous-signed.xpi" \
CHZZK_RELEASE_METADATA="/absolute/path/to/chzzk-<version>-release-metadata.json" \
CHZZK_SIGNED_SMOKE_MODE=update \
CHZZK_SIGNED_XPI="/absolute/path/to/chzzk-<version>-signed.xpi" \
FIREFOX_BINARY="/absolute/path/to/firefox" \
GECKODRIVER_BINARY="/absolute/path/to/geckodriver" \
npm run test:firefox-signed-smoke
```

실제 운영 gate는 checked-in Windows wrapper를 사용하며 exact
`permanent-signed-active`와 final `none-found`를 요구한다. 새 disposable
profile만 만들고 task-created input, result, process와 profile만 제거한다. 사용자의
설치 profile, cookies, identifiers와 complete signed media URLs은 읽거나
artifact/log에 남기지 않는다.

## Rollback

Rollback은 사용자가 대상 version을 명시했을 때만 수행한다.

```powershell
npm run chzzk -- rollback <version> --json
```

Operator는 대상 GitHub Release와 server generation의 metadata, provenance와
digests를 다시 검증한다. 새 배포와 같은 lock, journal, atomic stable-link 전환과
readback을 사용한다. 대상 generation이 없거나 byte identity가 다르면 수동 symlink
명령으로 우회하지 않고 fail-closed한다.

## 네트워크 장애

정상 운영 경로는 PC→Router→Server의 내부 WireGuard/SSH와 HTTPS다. 이 경로가
실패하면 PC와 Router에서 DNS, route, VPN, key와 SSH를 먼저 확인한다. 공개 SSH
timeout은 내부 경로가 정상인 동안 blocker가 아니다. 자동 배포와 rollback은 OCI에
접근하지 않으며, OCI는 두 정상 SSH 경로가 모두 불가능한 별도 승인 긴급 복구
절차에만 사용한다.
