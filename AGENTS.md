# CHZZK project instructions

이 저장소는 CHZZK Firefox 확장 프로그램의 제품 소스다. 작업을 시작할 때
`docs/PROJECT_STATUS.md`의 현재 상태와 작업 지도를 먼저 읽고, 시간에 따라 바뀔 수
있는 상태는 반드시 실제 시스템에서 다시 확인한다.

## 소스 지도

- 제품 코드·테스트·릴리스 파이프라인: `C:\Users\Alpha\CHZZK`
- 현재 NixOS 서버 설정: `C:\Users\Alpha\server-config`
- 운영 업데이트 트리: 서버의 `/srv/admin/chzzk-updates`
- Firefox 업데이트 주소: `https://chzzk.home.arpa:8443/updates.json`
- 서명·릴리스 절차: `docs/SIGNING.md`, `docs/OPERATIONS.md`
- 업데이트 서버 배포 절차: `docs/UPDATES.md`

날짜가 붙은 `server-chzzk-*` 폴더는 과거 후보 또는 참고자료다. 현재 서버 설정에
변경이 필요하면 깨끗한 `server-config`를 기준으로 최소 변경만 한다.

## 요청 분류와 운영 권한

- 설명, 상태 확인, 조사, 검토처럼 읽기 전용인 요청은 파일, 브랜치, PR, Release,
  Actions run, 서버, Firefox를 변경하지 않는다. `npm run chzzk -- status --json`과
  필요한 readback만 수행한다.
- 확장 프로그램의 동작, 권한, manifest 또는 배포 산출물이 달라지는 제품 변경은
  사용자의 변경 요청 자체를 전체 `ship` 권한으로 본다. 깨끗한 `agent/*` 브랜치에서
  구현과 검증을 마친 뒤 `npm run chzzk -- ship --json`으로 보호 PR, squash merge,
  Mozilla 서명, immutable Release, 내부 서버 배포와 disposable Firefox 검증까지
  진행하며 단계별 재승인을 요구하지 않는다.
- 문서, 테스트 인프라, 운영 도구, workflow pin처럼 제품 산출물을 바꾸지 않는
  변경은 보호 PR 병합까지만 진행하고 Release나 서버 배포를 만들지 않는다.
- 운영 버전은 UTC 날짜의 `YY.M.D` 형식이며 하루에 하나만 게시한다. 그날의
  immutable Release가 이미 존재하면 두 번째 제품 변경은 버전을 올리거나 병합하지
  않고 정확히 하나의 `ship-pending` PR에 합친다. UTC 날짜가 바뀐 뒤 들어온 다음
  mutating 제품 요청에서 이 PR을 이어받아 새 날짜 버전으로 ship한다.
- rollback은 별도의 운영 변경이다. 사용자가 대상 버전과 rollback 의도를 명시했을
  때만 `npm run chzzk -- rollback <version> --json`을 실행한다.

## 작업 규칙

- 제품 변경 요청은 바로 구현하고, 가장 좁은 회귀 테스트와 실제 Firefox 흐름을
  확인한다.
- `background.js`, `diagnostics.js`, `player-controller.js`, `site-observer.js`는 생성
  산출물이다. `src/` 또는 `policy/`를 수정한 뒤 `npm run build:runtime`을 실행한다.
- 릴리스는 Mozilla unlisted 서명과 immutable GitHub Release를 거친 뒤에만 내부
  업데이트 서버에 배포한다. 서명되지 않은 XPI를 운영 경로에 올리지 않는다.
- GitHub 운영은 이 PC의 `gh` keyring 인증으로 수행한다. 토큰을 환경 변수, 명령행,
  파일, 로그 또는 서버에 복사하지 않는다. 서버에는 검증된 고유 SCP bundle만 보내고
  내부 `ssh server` 경로의 트랜잭션 activation을 사용한다.
- CI, CodeQL, Dependency review, Build signed Firefox release의 네 Actions만
  유지한다. 외부 Codex GitHub App, comment-triggered review, bot approval은 merge gate가
  아니다. 마지막 source push 뒤 현재 PR head를 직접 검토하고 `gh`로 그 exact head의
  COMMENT review를 기록하며, 이후 push가 생기면 checks와 review를 다시 수행한다.
- 사용자의 Firefox 프로필을 닫거나 XPI를 덮어쓰거나 업데이트 버튼을 누르지
  않는다. 자동 ship 검증은 disposable profile만 사용하며, 사용자가 브라우저 설치
  또는 실제 프로필 업데이트까지 명시했을 때만 해당 프로필을 변경한다.
- 0.1.22의 과거 공개 업데이트 도메인은 폐기됐다. 사용자는 0.1.23을 수동 설치해
  `home.arpa:8443` 채널로 이전을 완료했으므로 호환용 도메인이나 443 리스너를
  추가하지 않는다.
- 정상 운영 서버 경로는 Router를 경유하는 내부 `ssh server`다. 접근 불가 시 PC와
  Router의 정상 경로를 먼저 확인한다. OCI는 PC와 Router 양쪽에서 기존 서버 SSH가
  모두 불가능한 긴급 복구에만 사용하며, 별도 승인 없이 접근하거나 변경하지 않는다.
- 토큰, 개인키, 서명된 미디어 URL, 쿠키, 계정 식별자를 출력하거나 문서화하지
  않는다.

## 완료 기준

제품 변경은 테스트 통과만으로 끝내지 않는다. 해당 작업 범위에 따라 다음 실제
흐름을 확인한다.

1. 확장 프로그램 동작
2. Mozilla 서명, build provenance 및 immutable Release
3. 내부 `updates.json`과 서명 XPI의 버전·MIME·SHA-256 readback
4. disposable Firefox가 내장 `update_url`을 통해 이전 서명본에서 새 서명본으로
   업데이트되는 흐름

사용자가 일부 단계만 요청한 경우 그 범위만 수행하고, 수행하지 않은 단계를
완료했다고 보고하지 않는다.
