# Firefox 서명과 immutable Release

Firefox Release/Beta에 일반 확장 프로그램으로 설치하려면 Mozilla 서명이
필요하다. CHZZK는 AMO의 unlisted 채널을 사용한다. 이 서명은 Firefox 설치
허가이며 NAVER 공식 승인이나 보증을 뜻하지 않는다.

## 신뢰 경계

- GitHub 운영자는 이 PC의 `gh` keyring에 로그인된 정확한
  `RELEASE_OPERATOR_LOGIN`이어야 한다.
- 운영 명령은 repository ID, protected remote `main`의 exact head와 UTC
  `YY.M.D` version을 매 mutation 전에 다시 읽는다.
- GitHub 관리자 권한이나 raw token은 Actions, artifact, argv, 환경 변수, checkout,
  log 또는 서버로 전달하지 않는다.
- `AMO_JWT_ISSUER`와 `AMO_JWT_SECRET`은 완전한 한 쌍으로 Repository Actions
  secret 또는 protected `firefox-signing` environment secret에만 둔다. 부분 pair,
  서로 다른 scope의 충돌과 보호되지 않은 environment는 fail-closed한다.
- Repository immutable releases는 활성 상태여야 한다. 같은 tag나 asset을
  overwrite하거나 `--clobber`하지 않는다.

## 운영 명령

일반 제품 변경은 `ship`이 서명과 게시를 포함하므로 별도 명령이 필요 없다.
이미 protected `main`에 병합된 canonical version을 복구하거나 이어서 게시할 때만
`release`를 직접 사용한다.

```powershell
npm run chzzk -- status --json
npm run chzzk -- release --json
```

`status`는 read-only다. `release`는 같은 source와 asset의 완료 상태를
idempotent no-op으로 인정하고, 같은 source SHA의 진행 중 run이나 compatible
draft만 resume한다. 다른 source의 같은 tag, 중복 run, 예상 밖 asset 또는
불완전한 secret policy는 쓰기 전에 중단한다.

## Actions 서명 단계

`Build signed Firefox release` workflow는 protected `main`의
`workflow_dispatch`만 받으며 다음 required string input을 사용한다.

- `source_sha`
- `version`
- `nonce`

run title은 `Release assets <nonce>`다. 로컬 operator는 exact workflow ID,
source SHA, version, nonce와 run ID를 결박하고 다른 run을 재사용하지 않는다.

Workflow는 다음 신뢰 단계를 분리한다.

1. exact protected source와 canonical version을 검증한다.
2. read-only checkout에서 `npm ci`, 전체 `npm run verify`, deterministic source
   ZIP과 release metadata를 만든다.
3. checkout과 npm이 없는 secret job이 dependency-free AMO client로 unlisted XPI를
   서명한다.
4. secret 없는 job이 XPI structure와 runtime bytes를 검증하고 checksum-pinned
   stock Firefox의 기본 signature enforcement로 영구 설치해
   `SIGNEDSTATE_SIGNED`를 요구한다.
5. source ZIP, metadata와 signed XPI 각각에 GitHub build provenance를 만든다.
6. 정확히 세 canonical file을
   `chzzk-release-assets-<source_sha>` run artifact로 출력한다.

Workflow는 GitHub Release를 생성, draft, 수정 또는 게시하지 않으며
`contents: write` 관리자 역할을 갖지 않는다. CI, CodeQL, Dependency review와 이
서명 workflow의 네 Actions만 유지한다.

## 로컬 게시

Workflow 성공 뒤 `release` operator가 다음을 수행한다.

1. exact run artifact를 private temporary directory에 내려받는다.
2. 파일명이 다음 세 개와 정확히 일치하는지 확인한다.

   - `chzzk-<version>.zip`
   - `chzzk-<version>-release-metadata.json`
   - `chzzk-<version>-signed.xpi`

3. metadata source repository/SHA/version, deterministic ZIP, XPI add-on ID,
   update URL, minimum Firefox, signed state와 각 provenance를 검증한다.
4. 게시 직전에 operator identity, protected `main` head, tag, Release와
   immutable-release 설정을 다시 읽는다.
5. exact tag와 asset bytes로 Release를 게시하고 immutable post-state를 요구한다.
6. `gh release verify "v<version>" --repo solitude0429/CHZZK`로 Release
   attestation과 세 digest를 readback한다.

Temporary artifact와 evidence는 bounded하며 성공·실패 후 task가 만든 경로만
제거한다. source ZIP, metadata 또는 signed XPI bytes가 한 번이라도 달라지면
새 tag로 다시 시도하지 않고 원인을 보고한다.

## UTC 일일 Release

version은 UTC 날짜를 zero padding 없이 `YY.M.D`로 사용하며 하루에 하나만
게시한다. 같은 UTC 날짜의 Release가 이미 있으면 추가 제품 변경은 version bump,
merge 또는 서명을 하지 않고 하나의 `ship-pending` PR에 대기한다. 다음 UTC
날짜에 들어온 mutating 제품 요청이 새 날짜 version으로 이어서 ship한다.

## PR 검토

`main` 변경은 native PR과 exact-head required checks
`verify`, `firefox-e2e`, `dependency-review`, `analyze`를 거친다. 마지막 source
push 뒤 operating agent가 최종 diff와 PR body의 고위험 영향을 직접 검토하고
현재 head SHA를 식별하는 COMMENT review를 `gh`로 기록한다. 이후 source push가
생기면 checks와 COMMENT review를 반복한다.

외부 Codex GitHub App, comment-triggered review, approval bot이나 custom review workflow는
필요하지 않다. sole-owner repository의 required approval count는 0이고,
unresolved conversation은 0이어야 한다.

## 게시 후

`gh release verify`가 성공한 immutable Release만 `docs/UPDATES.md`의 내부
update-host 배포에 사용할 수 있다. 배포 뒤에는 이전 AMO-signed XPI에서 새
signed XPI로 가는 disposable stock-Firefox update mode를 통과시킨다.
