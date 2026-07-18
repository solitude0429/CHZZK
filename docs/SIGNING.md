# Firefox 서명/정식 설치

Firefox Release/Beta에서 일반 확장처럼 설치하려면 Mozilla 서명이 필요합니다. 개인용으로 AMO 검색 목록에 공개하지 않을 때는 **unlisted** 채널로 서명합니다. 이 서명은 Firefox 설치 허가이며 NAVER 공식 승인을 뜻하지 않습니다.

## 자격 증명

Mozilla Add-ons Developer Hub의 API key 화면에서 다음 값을 GitHub repository secret으로 저장합니다.

- `JWT issuer` 값 → `AMO_JWT_ISSUER`
- `JWT secret` 값 → `AMO_JWT_SECRET`

라벨, 따옴표, `NAME=value` 형태가 아니라 값만 저장합니다. 자격 증명은 argv, 파일, artifact, 로그에 기록하지 않습니다.

## 릴리스 workflow

1. 버전을 올린 PR을 `main`에 병합합니다.
2. 저장소 관리자/릴리스 운영자는 아래 절차로 protected `main`에서 저장소 밖에 설치한 operator bootstrap을 Actions 밖의 깨끗한 exact-`main` checkout에서 `dispatch` 모드로 실행합니다. 이 명령은 credential이 checkout JavaScript에 닿지 않은 채 현재 인증 주체, 원격 protected default branch의 정확한 commit, 로컬 version, repository immutable-releases 설정을 한 번에 고정한 뒤에만 제한된 `repository_dispatch`를 보냅니다. 다음 실행 블록보다 먼저 이 문서 아래의 **Bootstrap 설치/갱신** 블록을 릴리스 자격 증명 없이 완료합니다.

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

3. workflow는 직접 `workflow_dispatch`할 수 없습니다. 30분 이내의 `chzzk-release-preflight-v1` handoff에 대해 configured operator, exact payload key set, protected default ref, source SHA, canonical version을 모두 검증하고 하나라도 불명확하면 실패합니다.
4. workflow는 다음 권한 경계를 유지합니다.
   - `prepare`: read-only checkout, `npm ci`, 전체 검증, 결정적 unsigned ZIP과 release metadata 생성, signer/client를 protected commit의 Git blob에 재고정
   - AMO 작업 전: 같은 version의 모든 release/tag 상태를 검사해 exact source commit/target commitish, tag 귀속, 허용된 asset 이름, 이미 존재하는 source/metadata/signed asset의 바이트를 검증. compatible draft만 재개
   - `sign`: checkout과 npm 실행 없이 검증된 artifact만 내려받고, `firefox-signing` environment를 통과한 signer step에서만 AMO secret 사용
   - `verify-signed`: secret 없이 signed XPI 구조, exact Mozilla metadata 파일 집합, ZIP resource bounds를 확인하고 `manifest.json`은 lossless semantic JSON으로, 나머지 runtime 파일은 prepared ZIP/metadata와 바이트 단위로 비교. 이어서 checksum-pinned stock Firefox를 설치하고 기본 서명 강제 상태에서 final AMO-signed XPI를 영구 설치해 ID/version/update URL/`SIGNEDSTATE_SIGNED`를 확인
   - `attest`: AMO secret/checkout 없이 세 release asset에 provenance attestation 생성
   - `stage`: checkout/npm/secret 없이 `contents: write`만 사용해 compatible draft에 정확한 세 asset을 채우고 바이트를 재검증. Actions 안에서는 공개하지 않음
5. workflow가 성공한 뒤, protected `main`에서 검증해 저장소 바깥에 설치한 operator-controlled bootstrap을 사용합니다. 로컬 checkout의 `scripts/finalize-release.js`를 직접 실행하지 않습니다. Bootstrap은 자격 증명으로 repository JavaScript를 실행하기 전에 GitHub API에서 protected default-branch head를 확인하고, 그 exact SHA의 `scripts/finalize-release.js` blob을 받아 Git blob ID를 검증한 뒤 메모리 `data:` URL로만 실행합니다.

### Bootstrap 설치/갱신

Bootstrap 설치/갱신은 릴리스 자격 증명을 주입하기 전에 다음처럼 수행합니다. 신뢰하는 credential source에서 이 public repository를 읽을 수 있는 별도 `CHZZK_BOOTSTRAP_TOKEN`을 먼저 주입하며, release administrator token을 재사용하지 않습니다. 이 절차는 caller의 GitHub CLI config와 checkout 파일을 사용하지 않고 protected head의 bootstrap blob을 직접 받아 외부 경로에 mode `0500`으로 설치합니다.

```bash
(
  set -euo pipefail
  test -n "${CHZZK_BOOTSTRAP_TOKEN:-}"
BOOTSTRAP_API_TOKEN="$CHZZK_BOOTSTRAP_TOKEN"
OPERATOR_HOME="$HOME"
unset ALL_PROXY BASH_ENV CURL_CA_BUNDLE ENV GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN \
  GITHUB_TOKEN GH_TOKEN HTTPS_PROXY HTTP_PROXY LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD \
  NODE_EXTRA_CA_CERTS NODE_OPTIONS NODE_PATH NO_PROXY REQUESTS_CA_BUNDLE SSL_CERT_DIR \
  SSL_CERT_FILE XDG_CONFIG_HOME all_proxy http_proxy https_proxy no_proxy
unset CHZZK_BOOTSTRAP_TOKEN
while IFS='=' read -r ENVIRONMENT_NAME _; do
  case "$ENVIRONMENT_NAME" in
    GH_* | GITHUB_* | GIT_*) unset "$ENVIRONMENT_NAME" ;;
  esac
done < <(/usr/bin/env)
export PATH="/usr/local/bin:/usr/bin:/bin"
GH_BINARY="/usr/local/bin/gh"
JQ_BINARY="/usr/bin/jq"
for SYSTEM_BINARY in \
  "$GH_BINARY" "$JQ_BINARY" /usr/bin/base64 /usr/bin/chmod /usr/bin/env \
  /usr/bin/git /usr/bin/install /usr/bin/mkdir /usr/bin/mktemp /usr/bin/rm \
  /usr/bin/stat /usr/bin/tr; do
  test -f "$SYSTEM_BINARY"
  test -x "$SYSTEM_BINARY"
  test "$(/usr/bin/stat -c %u "$SYSTEM_BINARY")" = "0"
  SYSTEM_MODE="$(/usr/bin/stat -c %a "$SYSTEM_BINARY")"
  (( (8#$SYSTEM_MODE & 022) == 0 ))
done
REPOSITORY="solitude0429/CHZZK"
BOOTSTRAP_DIR="$OPERATOR_HOME/.local/libexec"
BOOTSTRAP_PATH="$BOOTSTRAP_DIR/chzzk-release-bootstrap.mjs"
BOOTSTRAP_GH_HOME="$(/usr/bin/mktemp -d)"
/usr/bin/chmod 0700 "$BOOTSTRAP_GH_HOME"
/usr/bin/mkdir -m 0700 "$BOOTSTRAP_GH_HOME/cache" "$BOOTSTRAP_GH_HOME/config"
BRANCH_STATE="$(/usr/bin/mktemp)"
BOOTSTRAP_RECORD="$(/usr/bin/mktemp)"
BOOTSTRAP_TMP="$(/usr/bin/mktemp)"
trap '/usr/bin/rm -f "$BRANCH_STATE" "$BOOTSTRAP_RECORD" "$BOOTSTRAP_TMP"; /usr/bin/rm -rf "$BOOTSTRAP_GH_HOME"' EXIT
export GH_CONFIG_DIR="$BOOTSTRAP_GH_HOME/config" GH_HOST="github.com" \
  GH_PAGER="cat" GH_PROMPT_DISABLED="1" GH_TOKEN="$BOOTSTRAP_API_TOKEN" \
  HOME="$BOOTSTRAP_GH_HOME" XDG_CACHE_HOME="$BOOTSTRAP_GH_HOME/cache"
unset BOOTSTRAP_API_TOKEN
BRANCH="$("$GH_BINARY" api "repos/$REPOSITORY" --jq .default_branch)"
BRANCH_URI="$(printf '%s' "$BRANCH" | "$JQ_BINARY" -sRr @uri)"
"$GH_BINARY" api "repos/$REPOSITORY/branches/$BRANCH_URI" >"$BRANCH_STATE"
test "$("$JQ_BINARY" -r .protected "$BRANCH_STATE")" = "true"
SOURCE_SHA="$("$JQ_BINARY" -r .commit.sha "$BRANCH_STATE")"
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]
"$GH_BINARY" api \
  "repos/$REPOSITORY/contents/scripts/admin-release-bootstrap.js?ref=$SOURCE_SHA" \
  >"$BOOTSTRAP_RECORD"
"$JQ_BINARY" -e \
  '.type == "file" and .path == "scripts/admin-release-bootstrap.js" and .encoding == "base64"' \
  "$BOOTSTRAP_RECORD" >/dev/null
"$JQ_BINARY" -r .content "$BOOTSTRAP_RECORD" \
  | /usr/bin/tr -d '\r\n' \
  | /usr/bin/base64 --decode >"$BOOTSTRAP_TMP"
test "$(/usr/bin/git hash-object --no-filters "$BOOTSTRAP_TMP")" = \
  "$("$JQ_BINARY" -r .sha "$BOOTSTRAP_RECORD")"
/usr/bin/install -d -m 0700 "$BOOTSTRAP_DIR"
/usr/bin/install -m 0500 "$BOOTSTRAP_TMP" "$BOOTSTRAP_PATH"
)
```

그 다음 clean exact-`main` checkout에서 최소 권한 `GH_TOKEN`과 관리자가 신뢰하는 절대 Node 경로를 사용해 외부 bootstrap을 실행합니다.

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

Bootstrap은 caller의 `node_modules/.bin`, `HOME` 기반 GitHub CLI config, ambient `GITHUB_TOKEN`/`GITHUB_ENTERPRISE_TOKEN`/`GH_ENTERPRISE_TOKEN`을 제거하고 root-owned system `git`/`gh`, 실행 동안만 존재하는 mode `0700`의 private `GH_CONFIG_DIR`/cache, system-only `PATH`, 비활성화된 Git fsmonitor/hooks/global/system config만 사용합니다. Protected head의 entrypoint가 메모리에서 시작된 뒤에도 checkout이 clean인지, finalizer source에 `assume-unchanged`/`skip-worktree`가 없는지, 각 working-tree byte가 exact `HEAD` blob과 같은지 다시 검증합니다. 검증된 library blob의 local import는 중첩 data URL로 봉인되어 mutable working-tree path를 다시 읽지 않습니다. 해당 import graph는 Node 내장 모듈과 추적된 dependency-free helper만 사용하고 `node_modules`를 로드하지 않으며, library는 외부 trusted command runner 없이는 즉시 실패합니다. Finalizer는 현재 인증 주체와 `RELEASE_OPERATOR_LOGIN`, remote default head, local clean state/version을 다시 묶고 local allowlist의 exact bytes를 descriptor 기반으로 고정합니다. 모든 exact-source staging run이 완료돼야 하며 가장 최신 run/attempt가 성공해야 합니다. 따라서 과거 실패 뒤 최신 성공 재시도는 허용하지만 최신 실패나 남아 있는 queued/in-progress run은 공개를 차단합니다. Draft asset은 GitHub API의 canonical name/size/`sha256:` digest/content type/Actions-bot uploader와 실제 다운로드 바이트를 대조하고, dependency-free ZIP verifier로 source/signed runtime 및 metadata를 local bytes에 묶습니다. 세 remote asset snapshot(초기, attestation 후, 공개 직전)의 release/asset ID와 digest를 검증한 다음, 공개 직전에 admin-only immutable-releases API가 다시 `enabled: true`인지 확인하고 곧바로 검증된 exact release ID에 `PATCH draft=false`를 실행합니다. 마지막으로 exact tag/source/assets와 `immutable: true`를 재검증합니다. Publish 응답이 유실돼도 서버 post-state가 exact immutable Release일 때만 성공으로 복구하며 원격 release/tag를 삭제하지 않습니다.

GitHub가 문서화한 immutable publication은 draft 생성 → asset 첨부 → draft 공개 순서이며 release `PATCH`에는 unsafe conditional request가 지원되지 않습니다. 따라서 finalizer를 실행할 때에는 staging workflow가 완전히 종료되어 그 `GITHUB_TOKEN`이 만료된 상태여야 하고, finalizer credential 외의 durable `contents: write` credential이나 동시 release writer가 없어야 합니다. 같은 publication 권한의 credential 노출이 의심되면 공개하지 말고 먼저 credential을 폐기·회전합니다.

6. Release에는 정확히 다음 세 asset만 게시됩니다.

- `chzzk-<version>.zip`
- `chzzk-<version>-release-metadata.json`
- `chzzk-<version>-signed.xpi`

같은 tag가 이미 있으면 source commit, 세 asset, signed contents, attestation이 모두 동일한 immutable Release인 경우에만 verified no-op으로 성공합니다. 한 바이트라도 다르면 실패하며 `--clobber`로 덮어쓰지 않습니다. AMO 호출보다 먼저 stale/foreign/extra/different-byte draft와 orphan/mismatched tag를 거부합니다. workflow는 기존 asset을 덮어쓰지 않고 compatible draft의 누락 asset만 채웁니다. 공개는 finalizer만 수행하며 공개 뒤 서버의 `immutable: true`와 정확한 asset set을 다시 검증합니다.

관리자 `gh` 인증은 이 저장소 하나에만 제한하고 `GET /repos/{owner}/{repo}/immutable-releases`, repository dispatch, draft staging/finalization에 필요한 최소 repository 권한만 부여합니다. 이 자격 증명은 Actions secret이나 workflow에 넣지 않습니다. Actions의 일반 `GITHUB_TOKEN`에는 Administration 권한이 없으며 이를 넓은 admin PAT로 교체하지 않습니다. `RELEASE_OPERATOR_LOGIN` repository variable은 이 out-of-band 인증 주체와 정확히 일치해야 합니다.

## 저장소 review gate 설정

Release/security-sensitive PR은 workflow/scripts/runtime/package 파일뿐 아니라 `README.md`와 모든 `docs/**`를 포함하는 broad path 분류와 `security-review-required`/`release-review-required` label을 함께 사용합니다. gate는 `AUTOMATED_REVIEW_LOGIN`의 정확한 계정(`chatgpt-codex-connector[bot]`)이 남긴 다음 clean signal 중 하나와 unresolved review thread 0개를 요구합니다.

- `APPROVED` review의 `commit_id`가 현재 PR head SHA와 정확히 일치
- `RELEASE_OPERATOR_LOGIN`이 작성하고 full current head SHA를 포함한 PR issue comment에 reviewer가 `+1` reaction을 남김
- 위 exact-head operator request 뒤에 reviewer가 canonical `Didn't find any major issues` issue comment를 남기고, 단 하나의 `Reviewed commit` 10~40자리 hex prefix가 현재 head와 일치

두 번째 경로에서는 reaction timestamp가 GitHub가 기록한 현재 PR activity timestamp(`updated_at`), request comment update, 그리고 같은 exact head의 마지막 `COMMENTED`/`CHANGES_REQUESTED` finding review보다 늦어야 합니다. 세 번째 경로에서는 exact reviewer identity, 미편집 comment, canonical clean heading, 단 하나의 reviewed-commit prefix, 최신 reviewer comment 여부를 모두 확인합니다. Clean body 전체는 heading, blank line, commit marker와 optional single terminal newline만 포함하거나 현재 connector의 정확한 고정 informational footer만 추가할 수 있으며 다른 trailing text는 거부합니다. Gate는 head/activity/label, 전체 issue comments, exact-head request reactions, reviews, thread ID/resolution을 서로 반대 순서로 두 번 수집하고 canonical evidence 자체가 byte-equivalent일 때만 두 번째 snapshot을 평가합니다. 따라서 GitHub의 초 단위 `updated_at`이 같아도 수집 중 생긴 review/thread/reaction 변화는 실패하며, 두 번째 순서에서는 reaction을 마지막에 다시 읽습니다. Clean comment 생성 시각은 latest exact-head request와 같은 head의 마지막 finding review보다 늦고 현재 PR `updated_at`과 정확히 같아야 하므로, 이후 PR activity나 reviewer message가 생기면 새 clean signal 전까지 다시 실패합니다. 따라서 아직 PR head가 아니던 commit SHA에 미리 받은 evidence나 이전 clean signal을 뒤의 finding에 재사용할 수 없습니다. `COMMENTED`와 `CHANGES_REQUESTED` 자체는 completion evidence가 아닙니다. PR 자체에 달린 issue-level `+1`도 commit SHA를 담지 않으므로 인정하지 않습니다. identity, SHA/prefix, state, full-body shape, repeated snapshot stability, 또는 필요한 timestamp가 없거나 malformed이면 gate는 실패합니다.

workflow는 `pull_request_target`, review/review-comment, issue-comment event에서 trusted default branch만 checkout하며 PR code를 실행하지 않습니다. reaction 전용 Actions event가 없으므로 PR `opened`/`synchronize`에서는 bounded polling하고, 15분 schedule은 open non-draft PR마다 동일 workflow의 quiet reconciliation dispatch를 보냅니다. `force_review=true` 수동 run만 run-ID가 포함된 고유 non-cancelable group에서 generation-bound failure check를 게시하고, 같은 PR의 기존 ordinary/forced-evaluation evidence runs를 취소해 종료를 확인한 뒤 failure marker를 다시 게시합니다. 다른 force request는 이 취소 대상에서 제외됩니다. 그 다음 `security-review-required` label을 durable하게 기록하고 같은 generation을 가진 forced reevaluation을 명시적으로 dispatch하므로 label API visibility가 늦어도 review 요구가 유지됩니다. 이 evidence follow-up은 ordinary PR activity와 같은 cancelable concurrency group을 사용하므로 더 최신 review/comment/thread event가 stale forced success를 취소합니다. Status publication step은 trusted default branch checker를 다시 실행해 두 번 수집한 최종 evidence를 검증한 뒤에만 check state를 읽고 게시하며, cached evaluate output을 success 근거로 사용하지 않습니다. check 선택은 monotonic check-run ID를 기준으로 하고 상태 변경이 필요할 때에는 POST 직전에 check state를 다시 읽습니다. Reconciliation은 evidence 결과가 바뀐 경우에만 exact-head `CHZZK review completion` check를 새로 게시하므로 reaction 생성·삭제 후 stale success/failure가 자동으로 교정됩니다. 강제 gate를 해제하려면 label을 명시적으로 제거합니다. 어느 review entry point에도 release dispatch 권한은 없습니다.

관리자는 Actions 밖에서 아래 script의 dry-run으로 exact change plan을 확인하고, 의도적으로 적용할 때만 `--apply`를 사용합니다. script는 기존 default-branch required status check를 보존하면서 GitHub Actions App에 source-bound된 strict `CHZZK review completion`, conversation resolution, administrator enforcement, labels, `AUTOMATED_REVIEW_LOGIN`/`RELEASE_OPERATOR_LOGIN` repository variable만 적용하고 다시 검증합니다. 이미 exact한 resource는 변경하지 않으므로 반복 적용은 no-op입니다. sole owner가 자기 PR을 approve할 수 없으므로 approving-review count, last-push approval, code-owner approval 같은 approval protection은 설정하지 않습니다. 이 저장소 작업 중에는 실제 API를 호출하지 않습니다.

```bash
export CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK"
export CHZZK_AUTOMATED_REVIEW_LOGIN="chatgpt-codex-connector[bot]"
export CHZZK_RELEASE_OPERATOR_LOGIN="<release-operator-login>"
npm run configure:review-gate
npm run configure:review-gate -- --apply
```

thread resolution 직후 즉시 확인해야 하면 manual reevaluation을 사용할 수 있습니다. Delayed reaction의 생성·삭제는 15분 quiet reconciliation이 자동으로 다시 평가합니다. 어느 entry point에도 release dispatch 권한은 없습니다.

## Native AMO client

`sign` job은 `web-ext`, `npm`, 프로젝트 build를 실행하지 않습니다. `scripts/sign-unlisted.js`와 `scripts/lib/amo-client.js`가 Node 내장 API만 사용해 다음을 수행합니다.

1. prepared ZIP SHA-256 검증
2. version list를 `filter=all_with_unlisted`로 끝까지 순회하며 exact target version을 조회하고 page 간 중복도 거부
3. target version이 없을 때만 AMO upload/validation 후 `POST /api/v5/addons/addon/<add-on id>/versions/`에 top-level upload UUID를 보내 unlisted version 생성
4. 이미 존재하는 exact unlisted version 또는 새 version의 승인 상태를 polling하며 version/channel/ID가 요청과 정확히 일치하는지 매 응답에서 검증
5. 허용된 `addons.mozilla.org` HTTPS download URL과 각 redirect hop 검증
6. 승인된 exact developer-file URL의 일시적 404만 하나의 10분 signing deadline과 60회 상한 안에서 재시도
7. 매 시도마다 승인 URL에서 새 JWT로 시작하고, 이후 redirect hop에서는 Authorization을 제거
8. signed XPI body를 16 MiB 상한으로 streaming하며 Content-Length가 초과하면 body를 읽기 전에 cancel
9. signed XPI를 mode `0600`으로 원자적 저장

AMO 자격 증명은 signer step의 환경에만 주입되고 즉시 `process.env`에서 제거됩니다. 파생 JWT를 사용하는 `https://addons.mozilla.org/api/v5/` 요청은 redirect를 거부합니다. AMO의 unlisted download endpoint는 add-on developer 인증을 요구하므로 첫 download 요청만 exact host/path allowlist를 통과한 뒤 JWT를 사용하고, manual redirect 이후의 CDN 요청에는 JWT를 전달하지 않습니다.

Signer의 전체 network/polling budget은 10분이며 poll interval은 100~60,000 ms safe integer만 허용합니다. API JSON은 response당 1 MiB와 nesting depth 64로 제한되고, API fetch, JSON body, signed-XPI fetch/body가 응답하지 않아도 같은 deadline에서 abort/실패합니다. 401/403, 승인 URL이 아닌 hop의 404, untrusted redirect, 그 밖의 non-404 status는 즉시 실패합니다.

## 구조 검사와 Firefox authenticity gate

`npm run verify:signed-release-structure`는 암호 검증기가 아닙니다. 이 검사는 runtime allowlist/metadata digest, raw ZIP path, ZIP64/multi-disk 금지, 중앙 디렉터리 size/ratio, 그리고 다음 exact Mozilla metadata 이름과 보수적 크기 범위만 확인합니다.

- `META-INF/cose.manifest`: 256 B~256 KiB
- `META-INF/cose.sig`: 512 B~64 KiB
- `META-INF/manifest.mf`: 256 B~256 KiB
- `META-INF/mozilla.sf`: 64 B~16 KiB
- `META-INF/mozilla.rsa`: 512 B~64 KiB

Signature metadata aggregate는 512 KiB 이하입니다. signed XPI compressed 16 MiB, source ZIP compressed 8 MiB, entry compressed 2 MiB, entry uncompressed 4 MiB, archive aggregate uncompressed 8 MiB, compression ratio 100:1 상한을 JSZip inflation 전에 적용합니다. ZIP archive/entry comment, 첫 local header 앞 또는 local entry 사이의 미계상 바이트도 거부합니다. Mozilla signature authenticity는 자체 COSE/JAR 구현이 아니라 `docs/TESTING.md`의 stock-Firefox permanent-install gate가 판정합니다. Release workflow의 `verify-signed` job이 final AMO-signed XPI에 이 gate를 실행하며, 성공하기 전에는 attestation과 draft staging이 시작되지 않습니다. 공개는 이후 out-of-band finalizer가 수행합니다.

## 로컬 서명

일반 릴리스에는 GitHub workflow를 사용합니다. AMO API를 진단해야 할 때만 별도 버전으로 로컬 서명을 수행합니다. `prepare:release`는 지정한 source digest가 현재 `HEAD`와 같고 tracked worktree/index가 깨끗할 때만 실행됩니다.

```bash
npm ci
npm run verify
CHZZK_SOURCE_DIGEST="$(git rev-parse HEAD)" \
CHZZK_SOURCE_REPOSITORY="solitude0429/CHZZK" \
npm run prepare:release

AMO_API_KEY="$AMO_JWT_ISSUER" \
AMO_API_SECRET="$AMO_JWT_SECRET" \
CHZZK_RELEASE_METADATA="dist/release/chzzk-<version>-release-metadata.json" \
CHZZK_UNSIGNED_XPI="dist/release/chzzk-<version>.zip" \
CHZZK_SIGNED_OUTPUT_DIR="dist/signed" \
npm run sign:unlisted
```

서명 승인을 기다리다 job이 중단되더라도 재실행은 exact unlisted target version을 조회해 polling/download부터 재개하며 새 upload/version을 만들지 않습니다. 기존 version이 listed이거나 버전·ID 응답이 일치하지 않으면 실패합니다. AMO가 `manifest.json`의 whitespace/key order와 동등한 number exponent 표기를 정규화하는 것은 lossless semantic equality로 허용하지만, unsafe integer/underflow/precision collision이나 `-0`/`0` 차이, manifest 의미, 다른 runtime 바이트가 달라지면 후속 structural 단계에서 게시 전에 거부됩니다. 이미 게시된 GitHub Release 재실행은 source commit과 `--source-digest` provenance까지 확인하는 immutable reuse 경로로만 처리합니다.
