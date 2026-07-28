# Firefox 서명과 immutable Release

Firefox Release/Beta에서 일반 확장처럼 설치하려면 Mozilla 서명이 필요합니다. 개인용 배포는 AMO의 **unlisted** 채널을 사용합니다. 이 서명은 Firefox 설치 허가이며 NAVER 공식 승인을 뜻하지 않습니다.

## 신뢰 경계

- Repository variable `RELEASE_OPERATOR_LOGIN`은 릴리스를 실행할 정확한 GitHub 로그인입니다.
- `firefox-signing` environment는 protected branch에서만 접근할 수 있고, 현재 release workflow의 별도 authorization은 exact protected default-branch head만 허용합니다.
- `AMO_JWT_ISSUER`와 `AMO_JWT_SECRET`은 완전한 한 쌍으로 Repository Actions secret 또는 `firefox-signing` environment secret에 저장하며, checkout이나 npm이 없는 sign step에서만 참조합니다. 어느 scope에도 하나만 남은 부분 쌍을 두지 않습니다. Environment에 같은 이름의 secret이 있으면 GitHub가 그 값을 우선합니다.
- Repository immutable releases는 활성 상태여야 합니다.
- GitHub 관리자 token은 Actions secret으로 저장하지 않습니다. Actions의 일반 `GITHUB_TOKEN`에는 immutable-release 설정을 읽는 `Administration: read` 권한이 없기 때문입니다.

Mozilla Add-ons Developer Hub의 API key 화면에서 받은 값은 다음 두 이름을 한 쌍으로 유지합니다.

- `JWT issuer` → `AMO_JWT_ISSUER`
- `JWT secret` → `AMO_JWT_SECRET`

자격 증명을 argv, checkout, artifact, 로그에 기록하지 않습니다.

기존의 완전한 Repository secret 한 쌍은 복사하거나 삭제하지 않고 그대로 사용할 수 있습니다. 완전한 environment 한 쌍도 지원하며, 두 scope에 모두 완전한 쌍이 있으면 GitHub 규칙에 따라 environment 값이 우선합니다. Configurator는 secret 값이나 쓰기 API를 사용하지 않고 이름·scope·environment 정책만 읽습니다. `firefox-signing` 보호 정책이 다르거나, 어느 scope에도 완전한 쌍이 없거나, 어느 scope에든 하나만 남은 부분 쌍이 있는 경우에는 dry-run에 수동 복구를 표시하며 `--apply`는 다른 설정까지 포함한 전체 변경을 시작 전에 거부합니다.

## Operator bootstrap

릴리스 자격 증명과 repository JavaScript를 분리하기 위해 `scripts/admin-release-bootstrap.js`의 protected-`main` blob을 저장소 밖의 owner-only 경로에 mode `0500`으로 설치합니다. 설치/갱신은 release administrator token이 아니라 repository를 읽을 수 있는 별도 credential로 수행하고 다음을 확인합니다.

1. API에서 default branch와 branch protection을 읽고 exact head SHA를 고정합니다.
2. 그 SHA의 bootstrap content record를 받습니다.
3. Base64를 private temporary file에 decode한 뒤 `git hash-object --no-filters` 결과를 API의 blob SHA와 비교합니다.
4. `$HOME/.local/libexec/chzzk-release-bootstrap.mjs` 같은 checkout 밖의 owner-only 경로에 mode `0500`으로 원자적으로 설치합니다.
5. 임시 `GH_CONFIG_DIR`, cache, content record와 token 변수를 제거합니다.

Bootstrap은 실행할 때 caller의 GitHub CLI config, proxy/CA/Node injection 변수, Git config/hook/fsmonitor, caller-controlled `PATH`를 신뢰하지 않습니다. Root-owned `gh`/`git`, 실행마다 생성한 mode `0700` private tool home, system-only `PATH`만 자식 프로세스에 전달합니다. Git과 GitHub CLI가 같은 readable private home을 사용하므로 service-account home이 없거나 접근 불가능해도 checkout의 `.git/config`나 `/nonexistent` 권한을 바꾸지 않습니다. Unit regression은 inaccessible caller home에서 실제 system Git의 stderr가 비어 있고 status가 성공하는지 확인합니다.

## 한 번의 릴리스 명령

버전 PR을 protected `main`에 병합하고 bootstrap을 그 exact head로 갱신한 뒤, clean exact-`main` checkout에서 `release` operation을 한 번 실행합니다.

```bash
(
  trap - DEBUG 2>/dev/null || true
  set +x
  set +v
  GH_TOKEN="$CHZZK_RELEASE_ADMIN_TOKEN"
  export GH_TOKEN PATH="/usr/local/bin:/usr/bin:/bin"
  unset ALL_PROXY BASH_ENV CHZZK_RELEASE_ADMIN_TOKEN CURL_CA_BUNDLE ENV \
    GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GITHUB_TOKEN HOME HTTPS_PROXY \
    HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD NODE_EXTRA_CA_CERTS \
    NODE_OPTIONS NODE_PATH NO_PROXY REQUESTS_CA_BUNDLE SSL_CERT_DIR \
    SSL_CERT_FILE XDG_CONFIG_HOME all_proxy http_proxy https_proxy no_proxy
  exec /absolute/path/to/trusted/node \
    "/absolute/protected/chzzk-release-bootstrap.mjs" \
    release "solitude0429/CHZZK" "$PWD"
)
```

이 단일 command는 다음 순서를 끝까지 묶습니다.

1. 인증 주체, configured operator, protected remote default head, clean local head/branch, canonical version을 확인합니다.
2. Admin-only API에서 immutable releases가 `enabled: true`인지 확인합니다.
3. 예측 불가능한 128-bit dispatch nonce와 preflight timestamp를 포함한 제한된 `repository_dispatch`를 보냅니다.
4. Active workflow metadata의 고정 ID/name/path를 먼저 결박한 뒤 exact actor, source SHA, branch, workflow ID/path, nonce-bound run title이 모두 일치하는 단 하나의 staging run을 bounded polling합니다. 개별 run의 `name`은 GitHub가 동적 `run-name`으로 반환할 수 있으므로 신뢰 경계에 사용하지 않습니다. 대기 예산은 순차 job timeout 100분과 queue/environment 여유 80분을 합친 180분이며, 실패, 중복, malformed state, timeout은 finalization 전에 중단합니다.
5. 성공 뒤 remote head와 clean checkout을 처음부터 다시 확인하고, protected head에서 finalizer entrypoint를 API로 가져와 Git blob identity를 검증한 memory-only module로 실행합니다.
6. Finalizer는 모든 exact-source staging run이 완료됐고 최신 attempt가 성공했는지, 세 draft snapshot과 asset bytes/uploader/content type, deterministic local artifacts, build attestations가 모두 일치하는지 확인합니다.
7. 공개 직전에 protected default head, operator identity, clean local branch/head, canonical version을 처음부터 다시 결박하고 admin-only API에서 immutable 설정을 다시 확인합니다. 그 뒤 protected default head를 마지막 외부 read로 한 번 더 읽어 exact source SHA임을 확인하고, 모두 같을 때만 검증한 exact release ID를 `draft=false`로 전환한 뒤 exact immutable post-state를 요구합니다.

`dispatch`와 `finalize` operation은 중단된 transaction의 명시적 복구용으로 남습니다. 일반 릴리스에는 `release`를 사용합니다. Default branch가 대기 중 전진하거나 checkout이 바뀌면 자동 finalization은 실패하며, 새 exact head에서 의도적으로 다시 시작해야 합니다.

## Actions staging chain

`sign-unlisted.yml`은 직접 수동 실행할 수 없고 fresh administrator preflight dispatch만 받습니다.

1. `authorize`: exact payload key set, operator, protected ref, source SHA, nonce, timestamp, canonical version을 확인합니다.
2. `prepare`: read-only checkout에서 `npm ci`, 전체 `npm run verify`, deterministic source ZIP과 release metadata를 만들고 기존 release state를 검사합니다.
3. `sign`: checkout/npm 없이 digest로 고정한 dependency-free signer와 prepared artifact만 사용합니다.
4. `verify-signed`: secret 없이 signed XPI 구조/runtime bytes를 검사하고 checksum-pinned stock Firefox의 기본 서명 강제 상태에서 영구 설치합니다.
5. `attest`: source ZIP, metadata, signed XPI에 build provenance attestation을 만듭니다.
6. `stage`: checkout/npm/secret 없이 `contents: write`만 사용해 compatible draft에 정확히 세 asset만 채우고 원격 bytes를 다시 비교합니다.
7. `complete`: verified immutable reuse 또는 전체 sign → verify → attest → stage chain만 성공으로 인정합니다.

Actions는 Release를 공개하지 않습니다. 같은 tag가 이미 있으면 source commit과 세 asset이 모두 같은 immutable Release인 경우에만 verified no-op입니다. 기존 asset을 덮어쓰거나 `--clobber`하지 않습니다.

## Release 자산

Release에는 정확히 다음 세 파일만 존재합니다.

- `chzzk-<version>.zip`
- `chzzk-<version>-release-metadata.json`
- `chzzk-<version>-signed.xpi`

검증기는 canonical 이름, 크기, entry 수, compression ratio, ZIP64/multi-disk, path, comment, signature metadata를 제한합니다. `manifest.json`은 lossless semantic JSON으로, 나머지 runtime 파일은 prepared ZIP과 byte 단위로 비교합니다. Mozilla 서명 authenticity는 자체 암호 구현이 아니라 stock Firefox의 `SIGNEDSTATE_SIGNED` 판정으로 확인합니다.

## PR 검토

Release/security 변경도 다른 변경과 같은 protected-branch 검증을 사용합니다. Native pull-request protection은 모든 `main` 변경에 PR을 요구하되 required approval count는 0으로 유지합니다. 마지막 source push 뒤 final diff의 고위험 영향을 먼저 정리해 PR body와 모든 고위험 메모를 확정하고 PR을 Ready로 전환합니다. 그 다음 active Codex task에서 exact current full PR head의 final diff를 직접 검토하고, GitHub review record가 그 head를 식별하게 합니다. 이 리뷰 뒤 source push가 생기면 body와 고위험 메모 확정, Ready 상태, 네 deterministic check, final Codex review를 새 head에서 다시 수행합니다. Sole-owner가 자기 PR을 승인할 수 없으므로 approval count는 요구하지 않으며, 별도 GitHub bot review도 중복 실행하지 않습니다. 대신 `verify`, Firefox E2E, dependency review, CodeQL을 모두 exact head에서 통과시키고 unresolved conversation을 0개로 유지합니다. 모든 gate 통과 뒤에는 owner 또는 owner가 명시적으로 권한을 준 operating agent가 exact head를 다시 확인하고 squash merge합니다. 범위가 정해진 작업을 끝내거나 병합하라는 owner 지시는 추가 확인 없이 충분한 권한이지만, GitHub auto-merge와 무인 generic merge automation은 계속 금지합니다.

## 배포 후

GitHub Release가 immutable이고 세 asset 검증이 끝난 뒤에만 `docs/UPDATES.md`의 내부 update-host 배포를 실행합니다. 배포 뒤에는 이전 signed XPI에서 새 signed XPI로 가는 stock-Firefox update mode를 통과시킵니다.
