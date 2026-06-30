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
2. Actions → `Sign Firefox add-on` → Run workflow
3. artifact `chzzk-signed-xpi`를 내려받아 Firefox에 설치합니다.

## 주의

- API secret은 저장소 파일, issue, 로그, README, 채팅에 적지 마세요.
- `npm run verify`가 통과한 artifact만 서명합니다.
- unlisted 서명은 개인 설치용이며 AMO 검색 목록에 공개하지 않습니다.
- signing workflow는 secrets가 없으면 실패하도록 되어 있습니다. secret 값을 출력하지 않습니다.
