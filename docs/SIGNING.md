# Firefox 서명/정식 설치

Firefox Release/Beta에서 일반 프로그램처럼 설치하려면 Mozilla 서명이 필요합니다. 개인용으로 공개 목록에 올리지 않으려면 AMO의 **unlisted** 채널로 서명합니다.

## 필요한 것

1. Mozilla Add-ons 계정
2. Add-ons API credentials
   - JWT issuer → GitHub secret `AMO_JWT_ISSUER`
   - JWT secret → GitHub secret `AMO_JWT_SECRET`

## 로컬 서명

```bash
export WEB_EXT_API_KEY='JWT issuer'
export WEB_EXT_API_SECRET='JWT secret'
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

- API secret은 저장소 파일, issue, 로그, README에 적지 마세요.
- `npm run verify`가 통과한 artifact만 서명합니다.
- unlisted 서명은 개인 설치용이며 AMO 검색 목록에 공개하지 않습니다.
