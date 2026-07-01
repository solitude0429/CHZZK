# Firefox 서명/정식 설치

Firefox Release/Beta에서 일반 프로그램처럼 설치하려면 Mozilla 서명이 필요합니다. 개인용으로 공개 목록에 올리지 않으려면 AMO의 **unlisted** 채널로 서명합니다.

중요: AMO unlisted signing은 Firefox가 설치를 허용하도록 하는 Mozilla 서명입니다. 네이버가 공식 승인한 프로그램이라는 의미는 아닙니다.

## 필요한 것

1. Mozilla Add-ons 계정
2. Add-ons API credentials
   - JWT issuer → GitHub secret `AMO_JWT_ISSUER`
   - JWT secret → GitHub secret `AMO_JWT_SECRET`

## 로컬 서명

```bash
export WEB_EXT_API_KEY='<AMO JWT issuer>'
export WEB_EXT_API_SECRET='<AMO JWT secret>'
npm run verify
npm run sign:unlisted
```

서명된 XPI는 `dist/signed/` 아래에 생성됩니다.

## GitHub Actions 서명

1. repository Settings → Secrets and variables → Actions에 다음 secrets를 추가합니다.
   - `AMO_JWT_ISSUER`
   - `AMO_JWT_SECRET`
2. 다음 중 하나로 `Sign and publish Firefox add-on` workflow를 실행합니다.
   - version bump가 포함된 `manifest.json`, `package.json`, `package-lock.json` 변경을 `main`에 push
   - Actions → `Sign and publish Firefox add-on` → Run workflow
3. workflow artifact `chzzk-signed-xpi`를 내려받아 Firefox에 설치합니다.
4. push trigger 또는 `publish_release`가 켜진 수동 실행이면 해당 버전의 GitHub Release가 생성/갱신됩니다.
5. 내부 update host 배포가 필요하면 VPS에서 `npm run deploy:updates:internal`을 실행합니다.

Workflow는 `firefox-signing` GitHub Environment에서 실행되며, default branch 또는 `v*` protected tag가 아니면 AMO secret 사용 전에 실패합니다. Release asset은 재사용하지 않고 매번 현재 verified source에서 새로 서명한 뒤 GitHub artifact attestation을 생성합니다.

## 주의

- API secret은 저장소 파일, issue, 로그, README, 채팅에 적지 마세요.
- `npm run verify`가 통과한 artifact만 서명합니다.
- unlisted 서명은 개인 설치용이며 AMO 검색 목록에 공개하지 않습니다.
- signing workflow는 secrets가 없으면 실패하도록 되어 있습니다. secret 값을 출력하지 않습니다.
- signing wrapper는 AMO credential을 `web-ext` command line에 싣지 않고, 권한 `0600` 임시 config 파일로 전달한 뒤 즉시 삭제합니다.
