# CHZZK 프로젝트 상태

마지막 실제 readback: 2026-08-30 UTC

이 문서는 다음 작업의 인계 지점이다. GitHub, Firefox와 서버처럼 시간에 따라
달라지는 상태는 `npm run chzzk -- status --json`과 실제 시스템 readback이 이
문서보다 우선한다.

## 현재 제품과 설치본

- 저장소: `C:\Users\Alpha\CHZZK`
- 원격: `solitude0429/CHZZK`
- 기본 브랜치: `main`
- 현재 배포 버전: `26.8.30`
- v26.8.30 source commit:
  `b1d2c413794ca61a9fb8c21fdfbeaf67344fd937`
- Firefox 확장 ID: `chzzk@solitude0429.local`
- 최소 Firefox: `140.0`
- 배포 방식: Mozilla unlisted signed XPI + immutable GitHub Release + 내부 HTTPS
  update host

마지막 사용자 설치 readback은 v0.1.23 active, Mozilla signed
(`signedState = 2`) 상태다. 사용자 profile의 업데이트 버튼은 아래 내장 URL에서
현재 v26.8.30을 받는다. 자동 검증은 사용자 profile을 바꾸지 않았다.

```text
https://chzzk.home.arpa:8443/updates.json
```

0.1.22가 사용한 과거 공개 update domain은 폐기됐다. 호환 domain이나 별도 443
bridge를 다시 만들지 않는다. 자동 ship의 Firefox 검증은 disposable profile만
사용하며, 사용자의 설치 profile은 명시적인 설치/업데이트 요청이 없으면 변경하지
않는다.

Scoop Firefox ESR의 persisted distribution policy는
`network.trr.excluded-domains = home.arpa`를 lock한다. public domain의 기존 DoH
정책은 유지하면서 `*.home.arpa`만 PC native DNS를 사용한다. 정책 적용 뒤 새
disposable Firefox에서 v0.1.23 → v26.8.30의 실제 `about:addons` 수동·자동 update,
Mozilla signed state 2, `permanent-signed-active`와 최종 `none-found`를 확인했다.
정책 작성 전에 열려 있던 사용자 Firefox에는 완전 종료 후 재시작이 한 번 필요하다.

## 현재 GitHub Release

- tag: `v26.8.30`
- 공개·immutable
- canonical asset 세 개와 build provenance 확인
- signed XPI SHA-256:
  `688124ec05938332c1929cd7d6fb13eab18c45fd9a1f6cd1445b60c96ffa2715`
- source ZIP SHA-256:
  `6b4921211ec36d14fa4fbef27f31f786a066cf9cda87ecdd08003ebfb6724648`
- release metadata SHA-256:
  `782ad7a2f47d1e906730c07c41a32164bfb77505e2e5d6dd8012c049faa0341b`
- `gh release verify v26.8.30 --repo solitude0429/CHZZK` 성공 확인

v0.1.23은 기존 sequential version의 마지막 배포본이고 v26.8.30부터 UTC 날짜의
`YY.M.D` version을 사용한다. UTC 하루에 하나만 게시한다.

## GitHub 운영 상태

- GitHub CLI `2.98.0`이 이 PC keyring의 `solitude0429` 계정으로 인증돼 있고
  repository ADMIN readback이 가능하다.
- `main`은 native PR, strict required checks `verify`, `firefox-e2e`,
  `dependency-review`, `analyze`, administrator enforcement와 conversation
  resolution을 요구한다.
- required approval count는 0, squash merge만 허용, auto-merge는 비활성이다.
- 활성 Actions는 CI, CodeQL, Dependency review, Build signed Firefox release
  네 개다.
- AMO credential pair는 Actions secret에 있고 `firefox-signing` environment는
  protected branches로 제한돼 있다.

새 흐름은 외부 comment-triggered review나 GitHub App review에 의존하지 않는다. 운영
agent가 마지막 source push의 exact head를 직접 검토하고 `gh` COMMENT review를
기록한다. 외부 Codex GitHub App은 사용자가 웹 GPT Pro의 GitHub 연동을 위해 유지하며,
App review는 보조 신호로만 취급한다. App이 만든 unresolved conversation은 내용을
검토하고 응답·해결한 뒤 병합한다.

## 서버 실제 상태

2026-08-30 UTC readback에서 정상 운영 경로는 건강하다.

- PC DNS: `chzzk.home.arpa -> 100.64.0.1`
- PC PowerShell HTTPS `/health`: 200
- Router→Server WireGuard reachability: 정상
- 내부 `ssh server` ProxyJump: 정상
- `protected-services.target`, `chzzk-updates.service`, `caddy.service`: active
- backend: `127.0.0.1:18082`
- Caddy SNI: `chzzk.home.arpa:8443`
- update tree: `/srv/admin/chzzk-updates`
- `current -> releases/26.8.30`
- stable `updates.json`, `index.html`, `provenance.json` links: current generation
- live `updates.json`: 200, JSON, version 26.8.30
- live signed XPI SHA-256: GitHub immutable Release와 일치
- unresolved deployment journal: 없음

서버 public SSH listener는 존재하지만 PC에서 public `server-recovery` 접속은
timeout이다. 내부 `ssh server` 경로가 정상이라 CHZZK 운영 blocker나 OCI 긴급
복구 조건이 아니다. 정상 status, release, deploy와 rollback은 OCI에 접근하지
않는다.

현재 NixOS 설정 source는 `C:\Users\Alpha\server-config`이며 HEAD는 `be54e6a`다.
`deployment-identities.nix`에 Router WireGuard public key 변경이 미커밋 상태로
남아 있다. 이는 현재 연결에 관련된 별도 서버 작업이므로 CHZZK content 배포가
덮어쓰거나 정리하지 않는다. 날짜가 붙은 `server-chzzk-*` 폴더는 배포 source가
아니다.

## 새 운영 흐름

공개 operator command는 다음과 같다.

```powershell
npm run chzzk -- status --json
npm run chzzk -- ship --json
npm run chzzk -- release --json
npm run chzzk -- deploy [version] --json
npm run chzzk -- rollback <version> --json
```

- 읽기 전용 요청은 `status`와 readback만 하고 아무것도 변경하지 않는다.
- 제품 변경 요청은 clean `agent/*` branch에서 검증, 보호 PR, exact-head COMMENT
  review, squash merge, 서명 Release, SCP 배포와 disposable Firefox update
  verification까지 자동 ship한다.
- 문서·운영 도구·workflow pin 변경은 merge까지만 하고 Release하지 않는다.
- 그 UTC 날짜의 Release가 이미 있으면 새 제품 변경은 version bump나 merge 없이
  정확히 하나의 `ship-pending` PR에 합친다. 다음 UTC 날짜의 mutating 제품
  요청이 이어서 ship한다.
- server에는 GitHub credential, checkout이나 `node_modules`를 두지 않는다. 로컬
  `gh`가 Release/attestation을 검증하고 import graph와 `jszip`을 포함한
  self-contained ESM activator 및 세 asset의 unique bounded bundle만 내부 SSH/SCP로
  보낸다.
- rollback은 사용자가 대상 version과 의도를 명시한 경우에만 실행한다.

상세 계약은 `docs/OPERATIONS.md`, `docs/SIGNING.md`와 `docs/UPDATES.md`를
기준으로 한다.
