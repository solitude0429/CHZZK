# Firefox 서명/정식 설치

Firefox Release/Beta에서 일반 확장처럼 설치하려면 Mozilla 서명이 필요합니다. 개인용으로 AMO 검색 목록에 공개하지 않을 때는 **unlisted** 채널로 서명합니다. 이 서명은 Firefox 설치 허가이며 NAVER 공식 승인을 뜻하지 않습니다.

## 자격 증명

Mozilla Add-ons Developer Hub의 API key 화면에서 다음 값을 GitHub repository secret으로 저장합니다.

- `JWT issuer` 값 → `AMO_JWT_ISSUER`
- `JWT secret` 값 → `AMO_JWT_SECRET`

라벨, 따옴표, `NAME=value` 형태가 아니라 값만 저장합니다. 자격 증명은 argv, 파일, artifact, 로그에 기록하지 않습니다.

## 릴리스 workflow

1. 버전을 올린 PR을 `main`에 병합합니다.
2. 저장소 관리자/릴리스 운영자는 Actions 밖의 깨끗한 `main` checkout에서 아래 preflight를 실행합니다. 이 명령은 현재 인증 주체, 원격 default branch의 정확한 commit, 로컬 version, repository immutable-releases 설정을 한 번에 고정한 뒤에만 제한된 `repository_dispatch`를 보냅니다.

```bash
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" npm run release:dispatch
```

3. workflow는 직접 `workflow_dispatch`할 수 없습니다. 30분 이내의 `chzzk-release-preflight-v1` handoff에 대해 configured operator, exact payload key set, protected default ref, source SHA, canonical version을 모두 검증하고 하나라도 불명확하면 실패합니다.
4. workflow는 다음 권한 경계를 유지합니다.
   - `prepare`: read-only checkout, `npm ci`, 전체 검증, 결정적 unsigned ZIP과 release metadata 생성, signer/client를 protected commit의 Git blob에 재고정
   - AMO 작업 전: 같은 version의 모든 release/tag 상태를 검사해 exact source commit/target commitish, tag 귀속, 허용된 asset 이름, 이미 존재하는 source/metadata/signed asset의 바이트를 검증. compatible draft만 재개
   - `sign`: checkout과 npm 실행 없이 검증된 artifact만 내려받고, `firefox-signing` environment를 통과한 signer step에서만 AMO secret 사용
   - `verify-signed`: secret 없이 signed XPI 구조, exact Mozilla metadata 파일 집합, ZIP resource bounds를 확인하고 `manifest.json`은 lossless semantic JSON으로, 나머지 runtime 파일은 prepared ZIP/metadata와 바이트 단위로 비교. 이어서 checksum-pinned stock Firefox를 설치하고 기본 서명 강제 상태에서 final AMO-signed XPI를 영구 설치해 ID/version/update URL/`SIGNEDSTATE_SIGNED`를 확인
   - `attest`: AMO secret/checkout 없이 세 release asset에 provenance attestation 생성
   - `publish`: checkout/npm/secret 없이 `contents: write`만 사용해 immutable Release 게시
5. Release에는 정확히 다음 세 asset만 게시됩니다.
   - `chzzk-<version>.zip`
   - `chzzk-<version>-release-metadata.json`
   - `chzzk-<version>-signed.xpi`

같은 tag가 이미 있으면 source commit, 세 asset, signed contents, attestation이 모두 동일한 immutable Release인 경우에만 verified no-op으로 성공합니다. 한 바이트라도 다르면 실패하며 `--clobber`로 덮어쓰지 않습니다. AMO 호출보다 먼저 stale/foreign/extra/different-byte draft와 orphan/mismatched tag를 거부합니다. workflow는 기존 asset을 덮어쓰지 않고 compatible draft의 누락 asset만 채웁니다. 공개 직후 서버의 `immutable: true`와 정확한 asset set을 다시 검증합니다.

관리자 preflight의 `gh` 인증은 이 저장소 하나에만 제한하고 `GET /repos/{owner}/{repo}/immutable-releases`용 Administration read와 repository dispatch용 Contents write만 부여합니다. 이 자격 증명은 Actions secret이나 workflow에 넣지 않습니다. Actions의 일반 `GITHUB_TOKEN`에는 Administration 권한이 없으며 이를 넓은 admin PAT로 교체하지 않습니다. `RELEASE_OPERATOR_LOGIN` repository variable은 이 out-of-band 인증 주체와 정확히 일치해야 합니다.

## 저장소 review gate 설정

Release/security-sensitive PR은 path 분류와 `security-review-required`/`release-review-required` label을 함께 사용합니다. gate는 현재 PR head에 대해 configured GitHub App의 정확한 check run이 completed/success이고 모든 review thread가 resolved일 때만 `CHZZK review completion` check를 성공시킵니다. required check는 아무 actor의 같은 이름 status가 아니라 GitHub Actions App ID에 고정합니다. push 후 예전 check/review는 인정하지 않습니다. review app이 authoritative completion check를 제공하지 않거나 app slug/check 이름이 비어 있으면 성공을 추정하지 않고 실패합니다.

관리자는 Actions 밖에서 아래 script로 설정을 먼저 검증하고, 의도적으로 적용할 때만 `--apply`를 사용합니다. script는 기존 default-branch check를 보존하면서 source-bound strict required check, stale-review dismissal, 최소 1개의 last-push approval, conversation resolution, administrator enforcement, review-bypass 없음, labels, repository variables를 적용/검증합니다. 이 저장소 작업 중에는 실행하지 않습니다.

```bash
export CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK"
export CHZZK_REVIEW_APP_SLUG="<configured-review-app-slug>"
export CHZZK_REVIEW_CHECK_NAME="<authoritative-completion-check>"
export CHZZK_RELEASE_OPERATOR_LOGIN="<release-operator-login>"
npm run configure:review-gate
npm run configure:review-gate -- --apply
```

thread resolution 뒤 자동 event가 발생하지 않는 경우 **Review completion gate** workflow의 manual reevaluation만 사용합니다. 이 manual entry point는 release dispatch 권한이 없습니다.

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

Signature metadata aggregate는 512 KiB 이하입니다. signed XPI compressed 16 MiB, source ZIP compressed 8 MiB, entry compressed 2 MiB, entry uncompressed 4 MiB, archive aggregate uncompressed 8 MiB, compression ratio 100:1 상한을 JSZip inflation 전에 적용합니다. Mozilla signature authenticity는 자체 COSE/JAR 구현이 아니라 `docs/TESTING.md`의 stock-Firefox permanent-install gate가 판정합니다. Release workflow의 `verify-signed` job이 final AMO-signed XPI에 이 gate를 실행하며, 성공하기 전에는 attestation과 publication이 시작되지 않습니다.

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
