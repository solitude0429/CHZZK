# CHZZK 운영

## 단일 운영 인터페이스

GitHub와 내부 업데이트 서버의 공개 운영 인터페이스는 다음 명령뿐이다.

```powershell
npm run chzzk -- status --json
npm run chzzk -- ship --json
npm run chzzk -- release --json
npm run chzzk -- deploy [version] --json
npm run chzzk -- rollback <version> --json
```

- `status`는 GitHub, 로컬 checkout, Release와 서버를 읽기만 한다.
- `ship`은 제품 변경의 PR부터 검증, merge, Release, 서버 배포와 disposable
  Firefox 업데이트 검증까지 수행한다.
- `release`는 이미 보호된 `main`에 병합된 canonical version을 서명하고 immutable
  GitHub Release로 게시한다.
- `deploy`는 생략한 경우 현재 canonical Release를, 지정한 경우 해당 immutable
  Release를 내부 서버에 배포한다.
- `rollback`은 사용자가 명시한 이전 immutable version으로 stable link를 되돌린다.

모든 GitHub 호출은 이 PC의 GitHub CLI keyring 인증을 사용한다. raw token을 환경
변수, argv, 파일, log, artifact 또는 서버에 전달하지 않는다. 서버는 GitHub에
인증하지 않으며, 로컬에서 검증한 고유 SCP bundle만 받는다.

## 요청 분류

- 설명, 조사, 상태 확인, 검토 등 읽기 전용 요청은 `status`와 필요한 readback만
  수행한다. branch, commit, PR, Actions run, Release, 서버와 Firefox를 변경하지
  않는다.
- 확장 동작, manifest, 권한 또는 배포 산출물이 바뀌는 제품 변경은 사용자의 변경
  요청 자체가 전체 `ship`을 승인한다. checks가 통과하면 단계별 재승인 없이
  squash merge, 서명, 게시와 서버 배포까지 끝낸다.
- 문서, 운영 도구, 테스트 인프라와 workflow pin처럼 제품 산출물을 바꾸지 않는
  변경은 보호 PR merge까지만 진행한다. 버전, Release와 서버는 바꾸지 않는다.
- rollback은 자동 판단하지 않는다. 사용자가 대상 version과 rollback 의도를
  명시한 경우에만 수행한다.

사용자의 설치된 Firefox profile은 별도 경계다. 자동 ship은 새 disposable
profile만 사용하고, 사용자가 설치 또는 실제 profile 업데이트를 명시하지 않으면
실행 중인 Firefox를 닫거나 설치 XPI를 덮어쓰거나 업데이트 버튼을 누르지 않는다.

## UTC 일일 Release queue

운영 version은 UTC 날짜를 zero padding 없이 `YY.M.D`로 표현한다. 예를 들어
2026-08-30 UTC의 version은 `26.8.30`이다.

- UTC 하루에 immutable Release는 하나만 게시한다.
- 그날 slot이 비어 있으면 `ship`이 `manifest.json`, `package.json`과
  `package-lock.json`의 top-level/root package version을 같은 날짜로 맞춘다.
- 그날 Release가 이미 게시됐다면 새 제품 변경은 version을 올리거나 merge하지
  않는다. 정확히 하나의 `ship-pending` PR을 생성하거나 기존 PR에 합친다.
- UTC 날짜가 바뀐 뒤 들어온 다음 mutating 제품 요청이 `ship-pending`을 이어받아
  새 날짜 version으로 검증하고 ship한다. 별도 scheduler나 다섯 번째 Action은
  두지 않는다.
- 같은 tag, source SHA와 asset이 이미 정확하면 release와 deploy는 idempotent
  no-op이다. 같은 SHA의 진행 중 workflow run이나 compatible draft는 resume한다.
  다른 SHA의 같은 tag, 예상 밖 asset 또는 중복 run은 변경 전에 fail-closed한다.

## 제품 변경과 merge

1. remote `main`을 readback하고 현재 작업이 clean `agent/*` branch인지 확인한다.
2. 실제 제품 결함에는 회귀 테스트를 추가하고 생성 runtime을 갱신한다.
3. 가장 좁은 관련 테스트를 먼저 실행한 뒤 `npm run verify`와 적용 가능한 실제
   Firefox E2E를 실행한다.
4. 당일 slot이 비어 있으면 `manifest.json`, `package.json`, `package-lock.json`
   top-level과 root package의 네 version field를 함께 맞추고 다시 검증한 뒤 source
   변경을 commit한다.
5. `gh`로 PR을 만들고 마지막 source push 뒤 PR body와 고위험 권한, 개인정보,
   릴리스 및 배포 영향을 확정한다.
6. exact PR head에서 `verify`, `firefox-e2e`, `dependency-review`, `analyze`가
   모두 성공하고 unresolved conversation이 0개인지 확인한다.
7. operating agent가 최종 diff를 직접 검토하고 현재 head SHA를 식별하는 COMMENT
   review를 `gh`로 기록한다. approval이나 외부 comment-triggered review는 요구하지
   않는다.
   이후 source push가 생기면 네 checks와 exact-head COMMENT review를 반복한다.
8. base와 head를 다시 읽고 squash merge한다. GitHub auto-merge나 generic
   unattended merge는 사용하지 않는다.
9. 제품 변경이면 이어서 `release`와 `deploy`를 실행하고 배포 검증까지 끝낸다.

sole-owner 저장소이므로 required approval count는 0이다. 대신 native PR, strict
required checks, administrator enforcement와 conversation resolution은 유지한다.

## Release

`npm run chzzk -- release --json`은 다음 순서를 한 작업으로 수행한다.

1. local `gh` identity, repository ID, protected remote `main`, canonical UTC version,
   immutable-release 설정과 tag/Release 충돌을 확인한다.
2. 예측 불가능한 nonce와 exact `source_sha`, `version`으로
   `Build signed Firefox release`의 `workflow_dispatch`를 호출한다.
3. exact workflow ID, source SHA와 nonce의 run 하나만 bounded polling한다.
4. 성공 run의 `chzzk-release-assets-<source_sha>` artifact를 private local
   temporary directory에 내려받는다.
5. canonical source ZIP, metadata와 AMO-signed XPI의 byte identity, add-on ID,
   version, update URL, stock-Firefox signed state와 build provenance를 검증한다.
6. exact tag와 세 asset으로 Release를 게시하고 immutable post-state를 readback한다.
7. `gh release verify`로 Release attestation과 asset digest를 다시 확인한다.

Actions는 Release를 draft로 만들거나 게시하지 않는다. 관리자 권한은 로컬 `gh`
process에만 있고, Actions는 AMO secret을 사용하는 서명 job과 secret 없는
검증·attestation job을 분리한다.

## 내부 서버 배포

정상 운영 경로는 Router를 경유하는 `ssh server`다. `deploy`는 로컬 `gh`로
immutable Release와 attestation을 검증하고 세 canonical asset을 private temporary
directory에 받은 뒤, exact protected source의 activator와 전체 import graph 및
`jszip`을 esbuild로 하나의 self-contained ESM file로 묶는다. 이 activator와 세
asset을 고유 이름의 bounded bundle로 SCP 전송한다. 서버에는 checkout,
`node_modules`나 GitHub token이 필요 없다. 서버의 hidden activation은 다음을
강제한다.

- 고정 target `/srv/admin/chzzk-updates`와 예상 owner/mode;
- symlink ancestor, foreign ownership와 group/world-writable managed path 거부;
- process-bound lock과 fsync된 rollback journal;
- immutable version directory 작성 후 `current`와 stable link의 원자적 전환;
- backend와 Caddy의 version, MIME, JSON, link와 SHA-256 readback;
- activation 실패나 중단 시 이전 link 복구.

성공 후 로컬 operator는 PowerShell HTTPS 경로로 `updates.json`과 XPI를 다시
검증한다. Router gate를 통과하지 못할 수 있는 `curl.exe` 실패만으로 장애를
판정하지 않는다.

`rollback <version>`도 대상 immutable Release와 서버 generation을 검증한 뒤 같은
lock/journal/link 전환을 사용한다. release directory를 자동 삭제하지 않는다.
이전 generation은 rollback과 old-signed-to-new-signed smoke를 위해 유지한다.

## 배포 후 Firefox 검증

Release 이전 signed XPI, 새 metadata와 signed XPI를 GitHub에서 검증해 내려받고
실제 Windows PC의 Firefox ESR, 정상 DNS/TLS와 새 disposable profile로 update
mode를 실행한다.

이 PC의 Firefox는 public name에는 기존 locked DoH 정책을 유지하고, RFC 8375
내부 이름인 `*.home.arpa`만 native DNS로 보낸다. Scoop이 유지하는
`C:\Users\Alpha\scoop\persist\firefox-esr\distribution\policies.json`의
`Preferences` 정책은 `network.trr.excluded-domains`에 `home.arpa`를 포함하고 해당
preference를 lock해야 한다. signed update smoke는 파일 존재가 아니라 disposable
Firefox에서 이 effective 값과 lock 상태를 직접 확인한다. 정책을 새로 쓰거나
바꾼 뒤에는 실행 중인 Firefox를 완전히 종료하고 다시 시작해야 실제 사용자
profile에도 적용된다. `scoop update`와 `scoop reset`에는 이 distribution 설정이
유지되지만 `scoop uninstall -p firefox-esr` 또는 persist directory 삭제 시에는
다시 설정해야 한다.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
  -File .\scripts\firefox-signed-smoke.windows.ps1 `
  -NodeBinary "<absolute-node.exe>" `
  -FirefoxBinary "<absolute-firefox.exe>" `
  -GeckodriverBinary "<absolute-geckodriver.exe>" `
  -ReleaseMetadata "<absolute-chzzk-YY.M.D-release-metadata.json>" `
  -SignedXpi "<absolute-chzzk-YY.M.D-signed.xpi>" `
  -OldSignedXpi "<absolute-previous-signed.xpi>" `
  -ResultPath "<new-private-result.json>"
```

결과는 exact Firefox/extension version, `permanent-signed-active`와
`none-found`를 요구한다. task가 만든 input, result, profile과 process만 제거하며
사용자 profile은 열지 않는다.

## GitHub 설정

활성 workflow는 다음 네 개만 유지한다.

- CI
- CodeQL
- Dependency review
- Build signed Firefox release

`main`은 strict required checks `verify`, `firefox-e2e`,
`dependency-review`, `analyze`, native PR, administrator enforcement와
conversation resolution을 요구한다. squash merge만 허용하며 Actions 기본 권한은
read-only다.

외부 Codex GitHub App은 사용자가 웹 GPT Pro의 GitHub 연동을 위해 유지한다. App이
작성하는 PR review나 comment는 보조 신호일 뿐 required check, approval 또는 merge
gate가 아니다. App이 unresolved conversation을 만들면 운영 agent가 내용을 검토하고
응답·해결한 뒤 병합한다. PR comment trigger, bot approval이나 별도 review workflow는
사용하지 않는다.

## 장애 경계

- 내부 `ssh server`가 실패하면 먼저 PC→Router와 Router→Server 경로, DNS, VPN,
  key와 client 설정을 readback한다.
- 공개 SSH timeout은 내부 경로가 정상인 동안 CHZZK 배포 blocker가 아니다.
- OCI는 PC와 Router 양쪽에서 기존 서버 SSH가 불가능한 긴급 복구에만 사용한다.
  자동 status, release, deploy 또는 rollback command는 OCI에 접근하지 않는다.
- AMO, GitHub, SCP, activation 또는 readback이 불완전하면 성공으로 보고하지 않고
  재실행 가능한 exact state를 남긴다.

## CHZZK 변경 대응

NAVER 변경으로 playback이 깨지면 redacted diagnostics를 분석하고 실제 결함을
재현하는 fixture를 먼저 추가한다.

```bash
npm run diagnostics:analyze -- diagnostics.json
npm run verify
```

query/hash, cookie, header, account/session identifier, key, UUID와 complete signed
media URL은 issue, PR, fixture와 log에 남기지 않는다.
