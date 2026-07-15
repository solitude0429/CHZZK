# Firefox 서명/정식 설치

Firefox Release/Beta에서 일반 확장처럼 설치하려면 Mozilla 서명이 필요합니다. 개인용으로 AMO 검색 목록에 공개하지 않을 때는 **unlisted** 채널로 서명합니다. 이 서명은 Firefox 설치 허가이며 NAVER 공식 승인을 뜻하지 않습니다.

## 자격 증명

Mozilla Add-ons Developer Hub의 API key 화면에서 다음 값을 GitHub repository secret으로 저장합니다.

- `JWT issuer` 값 → `AMO_JWT_ISSUER`
- `JWT secret` 값 → `AMO_JWT_SECRET`

라벨, 따옴표, `NAME=value` 형태가 아니라 값만 저장합니다. 자격 증명은 argv, 파일, artifact, 로그에 기록하지 않습니다.

## 릴리스 workflow

1. 버전을 올린 PR을 `main`에 병합합니다.
2. Actions → **Sign and publish unlisted Firefox release** → **Run workflow**를 선택합니다.
3. workflow는 `main` protected ref인지 확인한 뒤 다음 권한 경계를 유지합니다.
   - `prepare`: read-only checkout, `npm ci`, 전체 검증, 결정적 unsigned ZIP과 release metadata 생성, signer/client를 protected commit의 Git blob에 재고정
   - `sign`: checkout과 npm 실행 없이 검증된 artifact만 내려받고, `firefox-signing` environment를 통과한 signer step에서만 AMO secret 사용
   - `verify-signed`: secret 없이 signed XPI의 `manifest.json`은 semantic JSON으로, 나머지 runtime 파일은 prepared ZIP/metadata와 바이트 단위로 비교
   - `attest`: AMO secret/checkout 없이 세 release asset에 provenance attestation 생성
   - `publish`: checkout/npm/secret 없이 `contents: write`만 사용해 immutable Release 게시
4. Release에는 정확히 다음 세 asset만 게시됩니다.
   - `chzzk-<version>.zip`
   - `chzzk-<version>-release-metadata.json`
   - `chzzk-<version>-signed.xpi`

같은 tag가 이미 있으면 source commit, 세 asset, signed contents, attestation이 모두 동일한 immutable Release인 경우에만 verified no-op으로 성공합니다. 한 바이트라도 다르면 실패하며 `--clobber`로 덮어쓰지 않습니다. 운영자는 dispatch 전에 admin-only API로 저장소의 immutable releases 설정이 활성 상태인지 확인합니다. workflow는 draft를 먼저 만들고, 기존 asset의 바이트를 검증하면서 누락된 asset만 업로드해 중단된 compatible draft를 재개한 뒤 공개합니다. 공개 직후 서버의 `immutable: true`와 정확한 asset set을 다시 검증합니다. 제한된 `GITHUB_TOKEN`에 Administration 권한을 추가하지 않습니다.

## Native AMO client

`sign` job은 `web-ext`, `npm`, 프로젝트 build를 실행하지 않습니다. `scripts/sign-unlisted.js`와 `scripts/lib/amo-client.js`가 Node 내장 API만 사용해 다음을 수행합니다.

1. prepared ZIP SHA-256 검증
2. version list를 `filter=all_with_unlisted`로 끝까지 순회하며 exact target version을 조회하고 page 간 중복도 거부
3. target version이 없을 때만 AMO upload/validation 후 `POST /api/v5/addons/addon/<add-on id>/versions/`에 top-level upload UUID를 보내 unlisted version 생성
4. 이미 존재하는 exact unlisted version 또는 새 version의 승인 상태를 polling하며 version/channel/ID가 요청과 정확히 일치하는지 매 응답에서 검증
5. 허용된 `addons.mozilla.org` HTTPS download URL과 각 redirect hop 검증
6. unlisted 파일 권한 검사를 위해 정확한 첫 `addons.mozilla.org/.../downloads/file/...` 요청에만 새 AMO JWT를 보내고, 이후 redirect hop에서는 Authorization을 제거
7. signed XPI를 mode `0600`으로 원자적 저장

AMO 자격 증명은 signer step의 환경에만 주입되고 즉시 `process.env`에서 제거됩니다. 파생 JWT를 사용하는 `https://addons.mozilla.org/api/v5/` 요청은 redirect를 거부합니다. AMO의 unlisted download endpoint는 add-on developer 인증을 요구하므로 첫 download 요청만 exact host/path allowlist를 통과한 뒤 JWT를 사용하고, manual redirect 이후의 CDN 요청에는 JWT를 전달하지 않습니다.

Signer의 전체 network/polling budget은 10분이며 API fetch, JSON body, signed-XPI fetch/body가 응답하지 않아도 이 deadline에서 abort/실패합니다. 따라서 25분 `sign` job timeout보다 먼저 통제된 오류를 반환합니다.

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

서명 승인을 기다리다 job이 중단되더라도 재실행은 exact unlisted target version을 조회해 polling/download부터 재개하며 새 upload/version을 만들지 않습니다. 기존 version이 listed이거나 버전·ID 응답이 일치하지 않으면 실패합니다. AMO가 `manifest.json`의 whitespace/key order를 정규화하는 것은 semantic equality로 허용하지만, manifest 의미나 다른 runtime 바이트가 달라지면 후속 `verify-signed` 단계에서 게시 전에 거부됩니다. 이미 게시된 GitHub Release 재실행은 source commit과 `--source-digest` provenance까지 확인하는 immutable reuse 경로로만 처리합니다.
