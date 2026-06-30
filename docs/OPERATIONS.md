# CHZZK 운영 Runbook

## Release checklist

1. `git status --short --branch`로 작업 상태 확인
2. `npm ci`로 clean install 확인
3. `npm run format:check` 통과
4. `npm run verify` 통과
5. `unzip -l dist/chzzk-<version>.zip`로 runtime 파일만 포함되는지 확인
6. GitHub PR 생성 후 CI 통과 확인
7. merge 후 tag/release 생성
8. AMO unlisted signing이 필요하면 `docs/SIGNING.md` 절차 수행

## Patch 대응 절차

CHZZK/NAVER 변경으로 동작이 깨지면 다음 순서로 처리합니다.

1. 확장 popup에서 diagnostics JSON 복사
2. 민감정보 재검토
   - query/hash 없음
   - cookie/header 없음
   - 계정/세션/키/UUID/connection identifier 없음
3. collector 기반 분석이 필요하면 popup에서 필요한 telemetry category만 명시적으로 켠 뒤 재현
4. `npm run diagnostics:analyze -- diagnostics.json` 실행
5. URL shape 변경이면 test-first로 fixture 추가
6. `src/shared/quality.js` 또는 `src/shared/session-rules.js` 수정
7. `npm run verify` 통과 후 PR

## Telemetry 운영

- 기본값은 local-only입니다.
- 외부 collector 전송은 popup의 `collector 전송 사용`을 켠 뒤 category별로 다시 켜야 합니다.
- diagnostics, structure, errors는 독립적으로 제어합니다.
- 오류 보고를 `force`로 호출해도 collector opt-in gate를 우회하지 않습니다.
- collector에서 `rate_limited`가 보이면 nginx limit와 collector limit을 함께 확인합니다.

## Incident response

### 증상: unrelated CDN traffic이 diagnostics에 보임

1. 즉시 해당 diagnostics 공유 중단
2. collector 전송을 local-only로 전환
3. `shouldRecordDiagnostics` 테스트 추가
4. `src/shared/session-rules.js`에서 context gate 강화
5. `npm run verify`
6. 새 release 생성 전 기존 release note에 privacy caveat 추가

### 증상: playback이 전부 깨짐

1. extension disable로 원복 확인
2. popup `lastDecision` 확인
3. DevTools Network에서 redacted URL shape만 기록
4. `unknown-quality-shape`면 parser fixture 추가
5. `untrusted-request-domain`이면 domain 확대 전에 실제 CHZZK live 요청인지 확인

### 증상: targetQuality보다 높은 화질 관측

1. diagnostics analyzer 실행
2. `needsPolicyUpdate`가 true면 `--apply`
3. 수동 확인 후 target 상향 PR

### 증상: collector report가 과도하게 많음

1. popup에서 collector 전송을 끄고 local-only로 전환
2. collector service log에서 `rate_limited`와 client key 확인
3. nginx/access log와 `/var/lib/chzzk-telemetry/reports-*.ndjson` 증가량 확인
4. 필요한 경우 `CHZZK_TELEMETRY_RATE_WINDOW_SECONDS` / `CHZZK_TELEMETRY_RATE_MAX_REPORTS` 조정
5. 반복되면 update host/collector 접근 경로를 WireGuard-only로 재확인

## Operational boundaries

- DOM selector를 통한 가짜 메뉴 표시를 재도입하지 않습니다.
- global static DNR ruleset을 재도입하지 않습니다.
- unrelated page/CDN traffic을 저장하지 않습니다.
- signed media URL의 query/hash를 저장하지 않습니다.
- collector 전송을 기본 활성화하지 않습니다.
- 네이버 공식 승인/허가 프로그램이라고 표현하지 않습니다.
