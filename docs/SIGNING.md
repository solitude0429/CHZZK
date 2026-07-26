# Firefox 서명과 immutable Release

Firefox Release/Beta에서 일반 확장처럼 설치하려면 Mozilla 서명이 필요합니다. 개인용 배포는 AMO의 **unlisted** 채널을 사용합니다. 이 서명은 Firefox 설치 허가이며 NAVER 공식 승인을 뜻하지 않습니다.

## 신뢰 경계

- Repository variable `RELEASE_OPERATOR_LOGIN`은 릴리스를 실행할 정확한 GitHub 로그인입니다.
- `firefox-signing` environment는 protected `main`에서만 접근할 수 있습니다.
- `AMO_JWT_ISSUER`와 `AMO_JWT_SECRET` repository secret은 checkout이나 npm이 없는 sign step에서만 참조합니다.
- Repository immutable releases는 활성 상태여야 합니다.
- GitHub 관리자 token은 Actions secret으로 저장하지 않습니다. Actions의 일반 `GITHUB_TOKEN`에는 immutable-release 설정을 읽는 `Administration: read` 권한이 없기 때문입니다.

Mozilla Add-ons Developer Hub의 API key 화면에서 받은 값은 다음 repository secret에 값만 저장합니다.

- `JWT issuer` → `AMO_JWT_ISSUER`
- `JWT secret` → `AMO_JWT_SECRET`

자격 증명을 argv, checkout, artifact, 로그에 기록하지 않습니다.

## Operator bootstrap

릴리스 자격 증명과 repository JavaScript를 분리하기 위해 `scripts/admin-release-bootstrap.js`의 protected-`main` blob을 저장소 밖의 owner-only 경로에 mode `0500`으로 설치합니다. 설치/갱신은 release administrator token이 아니라 repository를 읽을 수 있는 별도 credential로 수행하고 다음을 확인합니다.

1. API에서 default branch와 branch protection을 읽고 exact head SHA를 고정합니다.
2. 그 SHA의 bootstrap content record를 받습니다.
3. Base64를 private temporary file에 decode한 뒤 `git hash-object --no-filters` 결과를 API의 blob SHA와 비교합니다.
4. `$HOME/.local/libexec/chzzk-release-bootstrap.mjs` 같은 checkout 밖의 owner-only 경로에 mode `0500`으로 원자적으로 설치합니다.
5. 임시 `GH_CONFIG_DIR`, cache, content record와 token 변수를 제거합니다.

Bootstrap은 실행할 때 caller의 GitHub CLI config, proxy/CA/Node injection 변수, Git config/hook/fsmonitor, caller-controlled `PATH`를 신뢰하지 않습니다. Root-owned `gh`/`git`, 실행마다 생성한 mode `0700` private GitHub CLI home, system-only `PATH`만 자식 프로세스에 전달합니다. Checkout의 `.git/config`나 `/nonexistent` 권한은 바꾸지 않습니다.

## 한 번의 릴리스 명령

버전 PR을 protected `main`에 병합하고 bootstrap을 그 exact head로 갱신한 뒤, clean exact-`main` checkout에서 `release` operation을 한 번 실행합니다.

```bash
(
  GH_TOKEN="$CHZZK_RELEASE_ADMIN_TOKEN"
  export GH_TOKEN PATH="/usr/local/bin:/usr/bin:/bin"
  unset ALL_PROXY BASH_ENV CHZZK_RELEASE_ADMIN_TOKEN CURL_CA_BUNDLE ENV \
    GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GITHUB_TOKEN HTTPS_PROXY \
    HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD NODE_EXTRA_CA_CERTS \
    NODE_OPTIONS NODE_PATH NO_PROXY REQUESTS_CA_BUNDLE SSL_CERT_DIR \
    SSL_CERT_FILE XDG_CONFIG_HOME all_proxy http_proxy https_proxy no_proxy
  exec /absolute/path/to/trusted/node \
    "$HOME/.local/libexec/chzzk-release-bootstrap.mjs" \
    release "solitude0429/CHZZK" "$PWD"
)
```

이 단일 command는 다음 순서를 끝까지 묶습니다.

1. 인증 주체, configured operator, protected remote default head, clean local head/branch, canonical version을 확인합니다.
2. Admin-only API에서 immutable releases가 `enabled: true`인지 확인합니다.
3. 예측 불가능한 128-bit dispatch nonce와 preflight timestamp를 포함한 제한된 `repository_dispatch`를 보냅니다.
4. Exact actor, source SHA, branch, workflow path/name, nonce-bound run title이 모두 일치하는 단 하나의 staging run을 bounded polling합니다. 대기 예산은 순차 job timeout 100분과 queue/environment approval 여유 80분을 합친 180분이며, 실패, 중복, malformed state, timeout은 finalization 전에 중단합니다.
5. 성공 뒤 remote head와 clean checkout을 처음부터 다시 확인하고, protected head에서 finalizer entrypoint를 API로 가져와 Git blob identity를 검증한 memory-only module로 실행합니다.
6. Finalizer는 모든 exact-source staging run이 완료됐고 최신 attempt가 성공했는지, 세 draft snapshot과 asset bytes/uploader/content type, deterministic local artifacts, build attestations가 모두 일치하는지 확인합니다.
7. 공개 직전에 admin-only API에서 immutable 설정을 다시 확인하고, 검증한 exact release ID만 `draft=false`로 전환한 뒤 exact immutable post-state를 요구합니다.

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

## PR 검토 게이트

Release/security 경로는 exact-head 자동 검토와 unresolved thread 0개를 요구합니다. 검토 event는 즉시 다시 평가됩니다. 게이트는 exact-head `APPROVED` review 또는 full-SHA를 포함한 unedited operator `@codex review` command 뒤에 trusted GitHub App이 남긴 최신 unedited clean-review comment를 인식합니다. Clean response 전체는 알려진 표준 template/footer와 일치해야 하며 같은 초의 request/response는 issue-comment ID로 순서를 판정합니다. Comment-bound `+1` fallback만 발생했다면 GitHub에는 reaction 전용 Actions event가 없으므로 한 번 수동 재평가합니다.

```bash
gh workflow run review-gate.yml \
  --repo solitude0429/CHZZK \
  --ref main \
  -f force_review=false \
  -f pr_number="<PR number>"
```

열린 PR 전체를 반복 실행하는 periodic reconciliation은 사용하지 않습니다.

## 배포 후

GitHub Release가 immutable이고 세 asset 검증이 끝난 뒤에만 `docs/UPDATES.md`의 내부 update-host 배포를 실행합니다. 배포 뒤에는 이전 signed XPI에서 새 signed XPI로 가는 stock-Firefox update mode를 통과시킵니다.
