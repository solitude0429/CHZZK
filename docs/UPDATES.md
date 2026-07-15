# Firefox 자동 업데이트

이 저장소는 AMO unlisted signed Firefox 확장을 내부 HTTPS update host로 self-distribute합니다. 확장 진단은 브라우저 로컬 저장소에만 남고 외부 collector를 사용하지 않습니다.

## 신뢰 체인

1. `prepare` job이 protected `main` source commit에서 정확한 runtime allowlist만 mode `0700` staging에 복사합니다.
2. staging에서 결정적 unsigned ZIP과 `release-metadata.json`을 생성합니다. metadata에는 add-on ID, 버전, 최소 Firefox 버전, runtime file digest, source commit, source repository가 들어갑니다.
3. 최소 권한 `sign` job이 ZIP/metadata/signer digest를 다시 확인한 뒤 AMO secret으로 exact ZIP만 제출합니다.
4. 별도 read-only job이 signed XPI의 runtime을 prepared ZIP과 바이트 단위로 검증합니다. `META-INF/` 서명 파일 외의 추가 파일은 허용하지 않습니다.
5. 별도 attestation job이 source ZIP, metadata, signed XPI를 같은 source commit과 signing workflow에 묶습니다.
6. publish job이 세 asset을 draft에서 재검증한 뒤 immutable GitHub Release로 공개합니다.
7. VPS deploy client가 tag commit, 정확한 asset set, 세 attestation, release metadata를 검증한 뒤 update host를 원자적으로 전환합니다.

## Update host 구조

`manifest.json`의 고정 update URL:

```text
https://chzzk-updates.alpha-apple.dedyn.io/updates.json
```

배포 layout:

```text
/var/www/chzzk-updates/
├── .deploy-state/                    # mode 0700 lock/recovery state
├── current -> releases/<version>
├── index.html -> current/index.html
├── provenance.json -> current/provenance.json
├── updates.json -> current/updates.json
└── releases/<version>/
    ├── chzzk-<version>.zip
    ├── chzzk-<version>-release-metadata.json
    ├── chzzk-<version>-signed.xpi
    ├── index.html
    ├── provenance.json
    └── updates.json
```

`updates.json`의 `update_link`는 immutable version directory의 signed XPI를 가리킵니다. `current` symlink 하나를 원자적으로 전환하므로 stable manifest와 versioned XPI가 섞이지 않습니다. 기존 target/releases directory mode는 변경하지 않습니다. `.deploy-state`는 web worker가 읽을 수 없는 mode `0700`이며 process-bound advisory lock과 fsync된 이전 link snapshot을 보관합니다. 활성화 중 일반 오류뿐 아니라 SIGKILL/재부팅으로 프로세스가 사라져도 lock은 자동 해제되고, 다음 실행이 이전 generation을 복구한 뒤 재시도합니다.

## 버전 규칙

Semantic Versioning `a.b.c`를 사용합니다.

- MAJOR: 기존 사용자에게 비호환인 변경
- MINOR: 하위 호환 기능 추가
- PATCH: 하위 호환 버그/보안 수정

```bash
npm version patch --no-git-tag-version
npm version minor --no-git-tag-version
npm version major --no-git-tag-version
npm run build:runtime
npm run verify
```

## 릴리스와 배포

1. 버전 변경과 생성 파일을 PR에 포함합니다.
2. CI의 unit/security/package gate와 실제 Firefox temporary-profile E2E를 통과시킵니다.
3. PR을 `main`에 병합합니다.
4. Actions에서 **Sign and publish unlisted Firefox release** workflow를 수동 실행합니다.
5. workflow가 성공한 뒤 clean `main` checkout에서 명시적으로 배포합니다.

```bash
CHZZK_VERSION="<version>" \
CHZZK_GITHUB_REPOSITORY="solitude0429/CHZZK" \
npm run deploy:updates:internal
```

Deploy client는 로컬 `package.json`이나 `manifest.json`으로 `updates.json`을 만들지 않습니다. attested Release metadata와 signed XPI bytes만 사용하며, tag commit과 metadata source digest가 다르면 실패합니다.

## 검증

배포 후 다음을 모두 확인합니다.

- `updates.json`: HTTP 200, `application/json`
- `update_link`: HTTP 200, `application/x-xpinstall`
- `update_hash`: hosted signed XPI SHA-256과 동일
- add-on ID, version, `strict_min_version`: release metadata/signed manifest와 동일
- update link path: `/releases/<version>/chzzk-<version>-signed.xpi`

실제 Firefox 엔진의 synthetic E2E:

```bash
npm run setup:firefox-e2e
FIREFOX_BINARY="$PWD/dist/e2e-tools/firefox/firefox" \
GECKODRIVER_BINARY="$PWD/dist/e2e-tools/geckodriver" \
npm run test:firefox-e2e
```

이 테스트는 격리된 Developer Edition profile에서 실제 `webRequestBlocking` 재생 redirect와 `AddonManager.findUpdates` 업데이트를 검증합니다. fixture XPI는 테스트 전용 unsigned artifact이므로 해당 profile에서만 signature/update certificate 검사를 끕니다. 실제 배포 artifact는 AMO 서명과 attestation 검증을 반드시 통과해야 합니다.

## 첫 설치와 사용자 확인

`update_url`이 없는 매우 오래된 설치본은 signed XPI를 한 번 수동 설치해야 합니다. 이후에는 실행 중인 Firefox에서 `about:addons`의 업데이트 확인을 사용합니다. 검증을 위해 profile XPI를 직접 덮어쓰거나 Firefox를 종료하지 않습니다.
