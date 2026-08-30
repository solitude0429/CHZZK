# CHZZK 프로젝트 상태

마지막 실제 readback: 2026-08-30 UTC

이 문서는 다음 작업의 인계 지점이다. GitHub, Firefox와 서버처럼 시간에 따라
달라지는 상태는 `npm run chzzk -- status --json`과 실제 시스템 readback이 이
문서보다 우선한다.

## 현재 제품과 설치본

- 저장소: `C:\Users\Alpha\CHZZK`
- 원격: `solitude0429/CHZZK`
- 기본 브랜치: `main`
- 현재 배포 버전: `0.1.23`
- v0.1.23 source commit:
  `3998471fd5dcd2d29e8940427d084dc68a20aa53`
- Firefox 확장 ID: `chzzk@solitude0429.local`
- 최소 Firefox: `140.0`
- 배포 방식: Mozilla unlisted signed XPI + immutable GitHub Release + 내부 HTTPS
  update host

사용자 Firefox에는 v0.1.23이 active, Mozilla signed
(`signedState = 2`) 상태로 설치돼 있다. 내장 update URL은 다음과 같고 기본
background update policy가 활성화돼 있다.

```text
https://chzzk.home.arpa:8443/updates.json
```

0.1.22가 사용한 과거 공개 update domain은 폐기됐다. 호환 domain이나 별도 443
bridge를 다시 만들지 않는다. 자동 ship의 Firefox 검증은 disposable profile만
사용하며, 사용자의 설치 profile은 명시적인 설치/업데이트 요청이 없으면 변경하지
않는다.

## 현재 GitHub Release

- tag: `v0.1.23`
- 공개·immutable
- canonical asset 세 개와 build provenance 확인
- signed XPI size: `73753` bytes
- signed XPI SHA-256:
  `2a2af2b8487ecee615c3f6bfc87308fd47aa05fa1b0623332e95972d69fd38f9`
- `gh release verify v0.1.23 --repo solitude0429/CHZZK` 성공 확인

v0.1.23은 기존 sequential version의 마지막 배포본이다. 다음 제품 Release부터
UTC 날짜의 `YY.M.D` version을 사용하며 UTC 하루에 하나만 게시한다.

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
기록한다. 새 local-`gh` 흐름이 보호 `main`에 병합된 뒤 사용자가 기존 외부 Codex
GitHub App을 한 번 disable하는 수동 정리가 남아 있다.

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
- `current -> releases/0.1.23`
- stable `updates.json`, `index.html`, `provenance.json` links: current generation
- live `updates.json`: 200, JSON, version 0.1.23
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
