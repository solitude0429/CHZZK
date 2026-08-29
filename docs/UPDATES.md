# Firefox 자동 업데이트

CHZZK는 Mozilla 서명된 unlisted XPI를 자체 HTTPS update host에서 배포합니다. Firefox는 `manifest.json`의 고정 `update_url`에서 `updates.json`을 읽습니다.

## Release에서 update host까지

1. External operator bootstrap의 단일 `release` operation이 protected clean exact head와 immutable-release 설정을 확인하고 nonce-bound staging run을 dispatch합니다.
2. Workflow는 deterministic source/metadata를 만들고 AMO에서 unlisted XPI를 서명합니다.
3. Signed XPI를 checksum-pinned stock Firefox에 영구 설치해 ID, version, update URL, `SIGNEDSTATE_SIGNED`를 확인합니다.
4. 세 release asset에 build provenance attestation을 생성합니다.
5. Exact draft에 세 asset을 채우고 원격 바이트를 재검증합니다.
6. Bootstrap이 exact actor/source/branch/workflow/nonce run의 성공을 bounded polling한 뒤 protected finalizer를 실행합니다.
7. Finalizer가 세 stable draft snapshot과 attestations를 확인하고, 공개 직전에 admin-only immutable 설정을 다시 확인한 다음 exact release ID만 게시합니다.
8. 공개 뒤 exact `isImmutable`/tag/assets를 확인하고, internal deploy client가 같은 source digest를 다시 검증해 update host에 transactionally 배포합니다.

GitHub administrator token은 Actions에 전달하지 않습니다. AMO secret job과 `contents: write` stage job도 분리됩니다.

## 배포 구조

각 버전은 immutable directory에 배치합니다.

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

`updates.json`과 landing-page 링크는 root-absolute immutable version path를 사용합니다. `current` symlink를 한 번만 원자적으로 전환하므로 stable manifest와 versioned XPI가 섞이지 않습니다.

Deploy client는 다음을 강제합니다.

- exact clean source checkout과 release metadata source commit 일치;
- published Release의 `isImmutable: true`;
- 정확히 세 canonical asset과 provenance attestation;
- signed XPI 구조와 stock-Firefox 검증에 사용한 metadata parity;
- symlink ancestor, foreign ownership, group/world-writable managed path 거부;
- process-bound advisory lock과 bounded wait;
- mutation 전에 fsync된 private rollback journal;
- file data와 parent directory fsync;
- post-activation content/link 검증 실패 시 이전 generation 복구;
- SIGKILL/reboot 뒤 다음 실행에서 이전 generation 복구 후 재시도.

## 배포 명령

Live update-host 변경은 별도의 승인된 operational batch로 수행합니다. Exact 파일 backup과 before/after 검증을 준비한 뒤 실행합니다.

먼저 protected exact `main`의 `scripts/internal-update-deploy-bootstrap.js` content record를 받아 Git blob SHA와 byte identity를 검증하고, checkout 밖의 owner-only 경로에 mode `0500`인 `.mjs` 파일로 설치합니다. Checkout의 deployment JavaScript나 npm script를 직접 실행하지 않습니다. 이미 실행 중인 신뢰된 관리자 셸에서 tracing을 먼저 끄고 token을 비공개 셸 변수로 복사하며, builtin `unset`으로 dynamic-loader·shell-startup·Node·proxy/CA 변수를 제거한 뒤에만 `/usr/bin/env`를 시작합니다. Bootstrap은 clean-parent marker와 stdin token만 받고 두 번째 `/usr/bin/env -i`와 absolute system Node로 다시 시작한 다음, 전달된 checkout이 trusted Git의 canonical worktree top-level 및 pinned repository origin과 정확히 일치하는지 확인합니다. 그 전체 checkout을 기준으로 자기 realpath가 밖의 `.mjs`이고 현재 operator 소유의 exact mode `0500` 파일이며 부모 디렉터리도 operator 전용인지 검증합니다. 이어서 private GitHub CLI home과 root-owned absolute Git/GitHub CLI를 사용하고, canonical 저장소 ID·protected remote default head·operator·clean local head/branch를 결박한 뒤 그 commit의 deployment entrypoint와 전체 local import graph를 API에서 받아 Git blob identity로 검증해 sealed module로 실행합니다. 다운로드 작업 디렉터리는 부모가 소유한 private execution tree 아래에 있으므로 자식의 terminal failure에도 부모가 전체를 제거합니다.

배포 polyglot launcher는 fixed protected system path인 `/usr/bin/node` 또는 `/run/current-system/sw/bin/node`만 허용하며 Git/GitHub CLI도 NixOS system profile을 포함한 고정 후보만 사용합니다. Repository-settings launcher는 계속 `/usr/bin/node`만 요구합니다. 어느 launcher도 `PATH`에서 실행 파일을 검색하지 않습니다.

```bash
(
  if [ -n "${GITHUB_ACTIONS-}" ]; then exit 1; fi
  trap - DEBUG 2>/dev/null || true
  set +x
  set +v
  chzzk_deploy_token="$CHZZK_DEPLOY_READ_TOKEN"
  unset ALL_PROXY BASH_ENV CDPATH CHZZK_DEPLOY_READ_TOKEN CURL_CA_BUNDLE ENV \
    GH_ENTERPRISE_TOKEN GH_TOKEN GITHUB_ENTERPRISE_TOKEN GITHUB_TOKEN GLOBIGNORE HOME \
    HTTPS_PROXY HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD \
    NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH NO_PROXY PS4 \
    REQUESTS_CA_BUNDLE SSL_CERT_DIR SSL_CERT_FILE XDG_CONFIG_HOME \
    all_proxy http_proxy https_proxy no_proxy
  export -n BASHOPTS SHELLOPTS 2>/dev/null || true
  printf '%s\n' "$chzzk_deploy_token" |
    /usr/bin/env -i CHZZK_UPDATE_DEPLOY_PARENT_BOUNDARY=1 \
      LANG=C.UTF-8 LC_ALL=C.UTF-8 \
      PATH=/run/current-system/sw/bin:/usr/local/bin:/usr/bin:/bin \
      "/absolute/protected/chzzk-internal-update-deploy-bootstrap.mjs" \
      "<version>" \
      "solitude0429/CHZZK" \
      "$PWD" \
      "/srv/admin/chzzk-updates"
  chzzk_deploy_status=$?
  unset chzzk_deploy_token
  exit "$chzzk_deploy_status"
)
```

Deploy client는 local `package.json`이나 `manifest.json`에서 `updates.json`을 재구성하지 않습니다. Verifier가 반환한 동일한 metadata/source/signed byte buffer만 activation까지 사용합니다.

## 검증

배포 뒤 다음을 확인합니다.

- `updates.json` JSON/MIME와 canonical schema;
- XPI MIME, version, add-on ID, minimum Firefox version;
- update link가 immutable version path를 가리키는지;
- landing page의 모든 local link가 실제 파일로 해석되는지;
- stable symlink가 새 generation을 일관되게 가리키는지;
- raw logs나 signed media URL이 생성되지 않았는지.

마지막으로 이전 signed XPI를 설치한 disposable stock-Firefox profile에서 update mode를 실행합니다.

```bash
npm run setup:firefox-signed-smoke
CHZZK_OLD_SIGNED_XPI="/absolute/path/to/previous-signed.xpi" \
CHZZK_RELEASE_METADATA="/absolute/path/to/chzzk-<version>-release-metadata.json" \
CHZZK_SIGNED_SMOKE_MODE=update \
CHZZK_SIGNED_XPI="/absolute/path/to/chzzk-<version>-signed.xpi" \
FIREFOX_BINARY="$PWD/dist/signed-smoke-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/signed-smoke-tools/geckodriver" \
npm run test:firefox-signed-smoke
```

Update mode는 이전 signed XPI에 이미 고정된 production `update_url`을 사용하므로 별도 base-URL override를 받지 않습니다. Signature/update trust preference를 낮추지 않으며 profile, cookies, identifiers, complete signed media URLs를 artifact나 log에 남기지 않습니다.
