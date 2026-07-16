# Firefox 자동 업데이트

이 저장소는 AMO unlisted signed Firefox 확장을 내부 HTTPS update host로 self-distribute합니다. 확장 진단은 브라우저 로컬 저장소에만 남고 외부 collector를 사용하지 않습니다.

## 신뢰 체인

1. `prepare` job이 protected `main` source commit에서 정확한 runtime allowlist만 mode `0700` staging에 복사합니다.
2. staging에서 결정적 unsigned ZIP과 `release-metadata.json`을 생성합니다. metadata에는 add-on ID, 버전, 최소 Firefox 버전, runtime file digest, source commit, source repository가 들어갑니다.
3. 최소 권한 `sign` job이 ZIP/metadata/signer digest를 다시 확인한 뒤 AMO secret으로 exact ZIP만 제출합니다.
4. 별도 read-only job이 signed XPI의 exact ZIP/runtime/signature-metadata 구조를 검증합니다. `manifest.json` number는 lossless decimal token으로 비교하고, 나머지 runtime은 prepared ZIP과 바이트 단위로 검증합니다. 이 단계는 Mozilla signature authenticity를 주장하지 않습니다.
5. 같은 read-only job이 checksum-pinned stock Firefox를 준비하고 기본 서명 설정을 바꾸지 않은 disposable profile에 final AMO-signed XPI를 영구 설치해 Mozilla signed state와 exact identity를 확인합니다.
6. 별도 attestation job이 source ZIP, metadata, signed XPI를 같은 source commit과 signing workflow에 묶습니다. 구조 검사와 stock-Firefox gate가 모두 성공하기 전에는 실행되지 않습니다.
7. Actions 밖의 운영자 preflight가 admin-only API로 repository immutable-releases 설정의 `enabled: true`, exact default-branch commit/version을 고정한 뒤에만 제한된 dispatch를 보냅니다. Workflow의 `stage` job은 compatible partial draft만 재개해 세 asset을 채우고 바이트를 재검증하지만 공개하지 않습니다.
8. Workflow 성공 뒤 같은 clean exact-default-head checkout의 out-of-band finalizer가 Git fsmonitor/hooks/config override를 비활성화하고 finalizer blob을 exact `HEAD`와 검증합니다. 인증된 operator의 protected remote default head와 일치함을 import 전에 확인한 뒤 verified data-URL graph를 실행합니다. 모든 exact-source staging run이 완료되고 최신 run/attempt가 성공했는지 확인하며, deterministic source/metadata, staged signed XPI, 세 attestation을 다시 검증합니다. 다른 durable same-authority release writer가 없는 경계에서 공개 직전에 admin-only API의 `enabled: true`를 다시 확인한 뒤 즉시 exact release ID를 publish하고 exact immutable post-state를 요구합니다.
9. VPS deploy client가 Release의 `isImmutable: true`를 독립적으로 다시 요구하고 tag commit, 정확한 asset set, 세 attestation, release metadata를 검증한 뒤 update host를 원자적으로 전환합니다.

## Update host 구조

`manifest.json`의 고정 update URL:

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
```

배포 layout:

```text
/var/www/chzzk-updates/
├── .deploy-state/                    # mode 0700 lock/recovery state
├── current -> releases/<version>
├── index.html -> current/index.html
├── provenance.json -> current/provenance.json
├── updates.json -> current/updates.json
└── releases/<version>/
    ├── chzzk-<version>.zip
    ├── chzzk-<version>-release-metadata.json
    ├── chzzk-<version>-signed.xpi
    ├── index.html
    ├── provenance.json
    └── updates.json
```

`updates.json`의 `update_link`는 immutable version directory의 signed XPI를 가리킵니다. `current` symlink 하나를 원자적으로 전환하므로 stable manifest와 versioned XPI가 섞이지 않습니다. 기존 target/releases directory mode는 변경하지 않습니다. `.deploy-state`는 web worker가 읽을 수 없는 mode `0700`이며 process-bound advisory lock과 fsync된 이전 link snapshot을 보관합니다. 활성화 중 일반 오류뿐 아니라 SIGKILL/재부팅으로 프로세스가 사라져도 lock은 자동 해제되고, 다음 실행이 이전 generation을 복구한 뒤 재시도합니다.

## 버전 규칙

canonical Semantic Versioning `a.b.c`를 사용합니다. 각 component는 `0` 또는 0이 아닌 숫자로 시작하며 최대 9자리입니다. prerelease/build metadata와 leading zero는 허용하지 않습니다.

- MAJOR: 기존 사용자에게 비호환인 변경
- MINOR: 하위 호환 기능 추가
- PATCH: 하위 호환 버그/보안 수정

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
npm run build:runtime
npm run verify
```

## 릴리스와 배포

1. 버전 변경과 생성 파일을 PR에 포함합니다.
2. CI의 unit/security/package gate와 실제 Firefox temporary-profile E2E를 통과시킵니다.
3. PR을 `main`에 병합합니다.
4. `docs/SIGNING.md`에 따라 protected `main`에서 검증해 저장소 밖에 설치한 operator bootstrap을 Actions 밖의 clean exact-default-head checkout에서 `dispatch` 모드로 실행합니다. Checkout JavaScript를 직접 실행하지 않으며 release workflow에는 UI `workflow_dispatch`가 없습니다.

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
    dispatch "solitude0429/CHZZK" "$PWD"
)
```

5. Workflow가 exact draft staging까지 성공한 뒤, `docs/SIGNING.md` 절차로 protected `main`에서 검증해 저장소 밖에 설치한 operator bootstrap을 같은 clean checkout에서 실행합니다. Checkout의 `scripts/finalize-release.js`를 직접 실행하지 않습니다.

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
    finalize "solitude0429/CHZZK" "$PWD"
)
```

6. Immutable Release 검증이 성공한 뒤 clean `main` checkout에서 명시적으로 배포합니다.

```bash
CHZZK_VERSION="<version>" \
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
npm run deploy:updates:internal
```

Deploy client는 로컬 `package.json`이나 `manifest.json`으로 `updates.json`을 만들지 않습니다. verifier가 반환한 동일한 metadata/source/signed byte buffer만 activation까지 사용하며 validated path를 다시 읽지 않습니다. Release가 immutable이 아니거나 tag commit과 metadata source digest가 다르면 실패합니다.

## 검증

배포 후 다음을 모두 확인합니다.

- `updates.json`: HTTP 200, `application/json`
- `update_link`: HTTP 200, `application/x-xpinstall`
- `update_hash`: hosted signed XPI SHA-256과 동일
- add-on ID, version, `strict_min_version`: release metadata/signed manifest와 동일
- update link path: `/releases/<version>/chzzk-<version>-signed.xpi`

실제 Firefox 엔진의 unsigned synthetic functional-only E2E:

```bash
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-functional-e2e
```

이 테스트는 격리된 Developer Edition profile에서 실제 `webRequestBlocking` 재생 redirect와 `AddonManager.findUpdates` 기능을 검증할 뿐 authenticity gate가 아닙니다. fixture XPI는 테스트 전용 unsigned artifact이므로 해당 profile에서만 signature/update certificate 검사를 끕니다.

실제 배포 artifact는 `docs/TESTING.md`의 `test:firefox-signed-smoke`를 추가로 통과해야 합니다. install mode는 최종 AMO-signed XPI를 stock Firefox 기본 서명 설정으로 영구 설치합니다. update mode는 배포 후 이전 signed version의 production `update_url`을 통해 최종 version으로 갱신합니다. 필요한 signed XPI가 없으면 명시적으로 실패하며 skip하지 않습니다.

## 첫 설치와 사용자 확인

`update_url`이 없는 매우 오래된 설치본은 signed XPI를 한 번 수동 설치해야 합니다. 이후에는 실행 중인 Firefox에서 `about:addons`의 업데이트 확인을 사용합니다. 검증을 위해 profile XPI를 직접 덮어쓰거나 Firefox를 종료하지 않습니다.
