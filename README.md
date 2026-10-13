# 월급수비대

돈은 지키고, 인생은 즐긴다. iPhone 홈 화면에 설치하는 한국어 PWA와 실제 서버 Web Push 백엔드입니다. Cloudflare 무료 환경용 Workers/D1/Cron 구현과 일반 서버용 Node/SQLite 구현을 제공합니다. 첨부 PRD와 [starter-config.json](shared/starter-config.json)을 사용하며, 첫 실행의 지출·상환·적립 기록은 모두 비어 있습니다. 픽셀 캐릭터는 참고 시안의 파스텔 RPG 분위기를 반영해 앱용 SVG로 제작했습니다.

실제 앱은 [money-safe.ttlikim16.workers.dev](https://money-safe.ttlikim16.workers.dev)에 배포됐고, 사용자가 iPhone 홈 화면 설치 후 로그인 화면을 확인했습니다. **현재 회원가입의 서버 세션 키 설정 오류를 복구 중이며, 실제 iPhone 종료 상태의 푸시 수신은 미검증입니다.** 자동 테스트나 푸시 서비스의 접수 응답을 실기기 수신으로 간주하지 않습니다.

## Cloudflare 무료 환경

[무료 배포·현재 오류 복구](docs/cloudflare.md)의 Cloudflare 대시보드 절차를 사용합니다. 기존 프로젝트는 `money-safe`, 빌드 명령은 `npm run build`, 배포 명령은 `npm run cf:deploy:dashboard`입니다. 기본 `npx wrangler deploy`로는 서버 키와 DB 초기화가 실행되지 않습니다. 대시보드 전용 명령은 기존 키를 유지하며, 데이터와 키가 없는 최초 설치만 안전하게 초기화합니다. Codex의 별도 로그인이나 네트워크 설정 변경 없이 Cloudflare 자체 빌드 서버에서 실행합니다.

아래는 로컬 Cloudflare 런타임을 검증하는 명령입니다. 공개 배포가 아닙니다.

```sh
npm ci
npm run cf:prepare
npm run build
npm run cf:migrate:local
npm run cf:dev
```

브라우저 검증은 `npm run test:e2e:cloudflare`, 배포 형식 검증은 `npm run cf:dry-run`입니다. 무료 요금제는 D1 쿼리·CPU 한도가 있으므로 원격 배포 뒤 실제 CPU 사용량을 확인해야 합니다. 비밀번호 해싱 강도를 낮춰 한도를 맞추지 않습니다. 예약 발송은 1분 간격 Cron에서 영구 큐를 처리하므로 앱 실행 상태에 의존하지 않습니다.

## 일반 서버에서 실행

Node.js 24 이상이 필요합니다. 아래 명령은 저장소 루트에서 실행합니다.

```sh
npm ci
npm run keys -- --origin http://localhost:5173
npm run dev
```

웹 개발 서버는 5173번, API는 3000번 포트를 사용합니다. API와 30초 간격의 예약 작업이 함께 시작합니다. `keys`는 `.env`에 VAPID 키쌍, 구독 암호화 키, 세션 비밀키를 만들고 기존 비어 있지 않은 값을 보존합니다. 기존 `.env`가 있다면 `PUBLIC_ORIGIN`을 개발 서버의 origin으로 설정하세요. 비밀키를 Git에 커밋하지 마세요.

빌드한 앱으로 실행하려면 `.env`의 `PUBLIC_ORIGIN`을 `http://localhost:3000`으로 설정한 뒤:

```sh
npm run build
npm start
# 다른 터미널에서 실행
npm run worker
```

설정은 [.env.example](.env.example)에 있습니다. 로컬 HTTP는 개발용입니다. 실제 iPhone에서는 공개 HTTPS가 필요합니다. 이 클라우드의 쓰기 제한으로 npm 캐시 오류가 발생하면 `npm ci --cache /tmp/money-safe-npm`을 사용하세요.

## 검증

```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

E2E는 이 환경의 `/usr/bin/chromium`을 사용합니다. 다른 컴퓨터는 `npx playwright install chromium`을 실행하거나 `CHROMIUM_PATH`에 설치된 Chromium 실행 파일을 지정하세요. 테스트 계정과 데이터는 `/tmp`의 분리된 SQLite에 저장됩니다.

공개 앱은 `npm run test:deployed -- --url https://money-safe.ttlikim16.workers.dev`로 검사합니다. 새 임시 계정으로 가입·저장·조회·내보내기·서버 푸시 설정을 확인하고 계정을 삭제합니다. 비밀번호·쿠키·거래 내용은 보고서에 출력하지 않습니다. 이 검사는 실제 iPhone 수신을 검증하지 않습니다.

## 포함된 기능

- 급여 주기 25일~다음 달 24일, 정수 원화, 서울 시간대. 초기 월급 3,650,000원·생활비 1,368,000원 자동 검산 및 예산 편집
- 수동 지출 추가·수정·삭제, 카테고리·메모·감정 기록과 예산 통계
- 대출 원금·이자 분리, 실제 원금만 반영하는 보스 HP, 가정을 명시한 상환 시뮬레이션과 별도 대출 기록
- 비상금·큰지출 준비금 적립/인출/잔액 조정, 기록을 근거로 완료·취소하는 XP 미션
- 이메일/비밀번호 인증, 사용자별 데이터, 내보내기·비밀번호 확인 계정 삭제
- manifest·서비스 워커·아이콘·safe-area, 계정별 오프라인 기록과 동기화 충돌 안내
- 사용자 클릭으로 푸시 동의 및 구독, 월급일/일요일/주기말 서버 예약, 주기별 80% 최초 도달 및 설정 가능한 미기록 알림
- 구독 AES-GCM 암호화, 영구 발송 이력, 재시도·만료 구독 정리·알림 딥링크·구독 해제

은행 연결과 실제 송금 기능은 없습니다. 알림에는 거래 메모나 금액을 포함하지 않습니다. 실제 지출은 직접 기록한 내역만 알 수 있습니다.

## 배포와 iPhone

[HTTPS 배포 안내](docs/deploy.md)에 Caddy + Docker Compose, 영속 DB 볼륨, 키 관리, 예약 작업과 백업 절차가 있습니다. [iPhone 설치·종료 상태 푸시 테스트](docs/iphone-test.md)의 실기기 확인을 완료한 뒤 출시 여부를 판단하세요. 완료 조건별 자동 검증과 남은 항목은 [검증 결과](docs/acceptance-results.md)에 기록합니다.

현재 클라우드 환경의 설치·시작 지침과 푸시 서비스 접속 허용 목록은 환경 설정 초안에 저장되었습니다. 재사용하려면 환경 설정에서 검토·저장 후 게시하세요. 초안 저장만으로 공개 앱 배포나 iPhone 수신 검증이 이루어지지는 않습니다.

SQLite는 서버·worker가 같은 영속 디스크를 쓰는 단일 인스턴스 배포용입니다. 일반 serverless 함수나 여러 호스트의 임시 파일시스템에서는 이 구성을 그대로 사용하지 마세요. 서버 운영 중단 후의 예약 catch-up은 12시간이며, 기기 수신과 OS 표시 시각은 네트워크·iOS 상태에 따라 달라집니다. 프로세스가 푸시 접수 후 DB 기록 전 중단되면 재발송 가능성이 있어 안정된 tag와 Topic으로 중복 표시를 줄입니다.

오프라인 수정은 기기별 최신 전체 스냅샷을 보관합니다. 서버 revision이 바뀌면 자동으로 덮어쓰지 않고, 기기 기록 내보내기와 서버 기록 다시 불러오기를 제공합니다. 거래 메모는 서버 DB와 기기 캐시에 저장되므로 기기 잠금, 제한된 디스크 권한과 백업 관리가 필요합니다. 구독 키는 암호화하며 비밀번호는 scrypt, 세션은 해시로 보관합니다.
