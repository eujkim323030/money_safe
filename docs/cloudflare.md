# 무료 Cloudflare 배포

1. 현재 Cloudflare의 **money-safe → Settings → Build → Build Configuration**을 엽니다.
2. Build command를 `npm run build`, Deploy command를 `npm run cf:deploy:dashboard`로 저장합니다.
3. 최신 `main`의 복구 코드가 반영된 빌드에서 **Retry build**를 누릅니다.
4. D1 권한 오류가 나오면 기존 빌드 토큰에 해당 계정의 **D1 Edit**를 추가하고 재시도합니다.
5. 아래 실제 앱 주소에서 가입을 다시 확인한 뒤 iPhone 종료 상태 푸시를 검증합니다.

월급수비대는 **Workers + D1 + Cron**의 무료 범위를 사용합니다. Cloudflare가 GitHub 소스를 가져와 자체 빌드 서버에서 배포하며 개인용 `workers.dev` HTTPS 주소를 제공합니다. 서버 비밀키와 DB 설정은 자동 배포 helper가 처리합니다. 사용자는 API 토큰·OAuth 토큰·비밀번호·앱 비밀키를 채팅에 전달하지 않습니다.

실행 코드는 [eujkim323030/money_safe](https://github.com/eujkim323030/money_safe)의 `main` 브랜치에 업로드했습니다. 실제 앱 주소는 **[https://money-safe.ttlikim16.workers.dev](https://money-safe.ttlikim16.workers.dev)**이며 사용자가 홈 화면 설치 후 로그인 화면을 확인했습니다. 회원가입에는 **`서버 세션 비밀키 설정이 필요합니다.`** 오류가 발생했습니다. 이후 사용자가 초기화 완료 로그와 공개 `/api/auth/me`의 `로그인이 필요합니다.` 응답을 확인했습니다. 현재 세션 키 검사는 통과하며 가입·실제 iPhone 푸시 수신은 재검증 중입니다.

## 현재 회원가입 오류 복구

확인된 오류는 서버의 `SESSION_SECRET` 설정이 없거나 32바이트보다 짧다는 뜻입니다. 현재 앱 `money-safe`의 **Settings → Build → Build Configuration**에서 위의 빌드·배포 명령을 저장하고 최신 복구 코드가 반영된 `main` 빌드를 재시도합니다. [공식 Build 설정](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#build-settings)에 따르면 저장된 변경은 다음 빌드에 적용되며, Retry도 재시도 시점의 설정을 사용합니다.

복구 helper는 현재 Worker와 연결된 기존 D1을 먼저 확인합니다. 서버 초기 설정 완료 기록이 없는 첫 설치이고 서버 비밀 5개가 모두 없으며 DB가 비어 있다는 검증을 통과한 경우에만 migrations와 새 비밀 초기화를 진행합니다. 기존 계정·기록·구독·초기 설정 완료 기록이 있거나 비밀 일부만 없어졌다면 원래 키 복구를 요구하고 중단합니다. 비밀값을 로그나 채팅에 출력하지 않습니다. 사용자가 초기화 완료 로그와 공개 로그인 API 응답을 확인했습니다. 새 helper는 배포 후 인증정보 없이 `/api/auth/me`를 조회하여 예상한 401 JSON 응답을 확인해야 완료 로그를 출력합니다. 최대 여섯 번의 제한된 재시도 후에도 실패하면 빌드를 실패 처리하며 기존 비밀값을 바꾸지 않습니다. 이 검사는 가입·DB 저장·실기기 푸시 검증을 대신하지 않습니다.

재시도에서 D1 권한 오류가 나타난 경우에는 아래의 **D1 Edit** 권한 조정을 적용합니다. 완료 후 실제 앱에서 가입·로그인·저장과 CPU 한도를 검증하고, 마지막으로 iPhone 푸시를 확인합니다. 비밀번호나 API 토큰은 채팅에 보내지 않습니다.

## 현재 Cloudflare 프로젝트 설정

이미 만들어진 `money-safe` 프로젝트에서 다음 값을 사용합니다. GitHub 연결과 배포 브랜치는 현재 프로젝트의 설정을 확인합니다.

처음 연결할 때 GitHub 권한 승인이 나타나면 **Cloudflare Workers & Pages** 앱에 필요한 `money_safe` 저장소를 선택하여 접근을 허용합니다. 공식 GitHub 연동 안내는 **Only select repositories**로 필요한 저장소에 접근을 제한하도록 권장합니다. 기존 저장소를 연결하는 일반 Git import 방식입니다.

| 프로젝트 설정 | 값 |
| --- | --- |
| Worker 이름 | `money-safe` (현재 앱 이름 유지; CI 이름 override 사용) |
| 배포 브랜치 | `main` |
| Root directory | 저장소 루트 |
| Build command | `npm run build` |
| Deploy command | `npm run cf:deploy:dashboard` |

`.node-version`에 Node 24를 지정했으므로 사용자에게 Node 버전 값을 따로 입력하도록 요구하지 않습니다. 공식 빌드 이미지는 현재 Node 24.18.0을 기본으로 제공하며 `.node-version`과 `.nvmrc`를 읽어 버전을 선택합니다.

자동 배포 helper는 CI에 연결된 앱의 이름·태그·계정을 확인하고 해당 앱의 D1 DB를 생성하거나 재사용하여 migrations를 적용합니다. 현재 프로젝트에서는 `money-safe`를 대상으로 합니다. 서버 비밀과 기존 데이터가 없는 최초 설치에서 필요한 키를 생성하며, 이후 배포에서는 기존 키를 유지합니다. VAPID 쌍이나 암호화키·세션 비밀이 부분적으로 없거나 기존 데이터에 필요한 키가 사라졌다면 작업을 중단합니다. 빌드 로그에 키 값을 출력하지 않습니다. 최초 설정은 하나의 빌드로 진행하며, 실제 빌드·배포 성공과 원격 검증을 확인하기 전에는 자동 설정이 완료됐다고 표시하지 않습니다.

### D1 권한을 한 번 추가해야 하는 경우

[공식 Build 설정](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)에 따르면 **Create new token**의 기본 권한에는 Workers Scripts Edit가 포함되지만 D1 Edit는 포함되어 있지 않습니다. 따라서 DB 생성·migrations 단계에서 D1 권한 부족으로 실패할 수 있습니다. 자동 발급된 기존 토큰을 수정하여 해결하며 비밀 토큰 문자열을 복사할 필요가 없습니다.

Cloudflare의 [My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens)에서 이 Worker의 빌드에 사용 중인 토큰을 선택하여, **Account → D1 → Edit**를 앱을 배포한 해당 계정에 추가합니다. 기존 Workers Scripts 권한은 유지합니다. 권한을 저장한 뒤 Worker의 빌드를 재시도합니다. 토큰 이름이나 편집 버튼 위치는 실제 화면에서 확인하며, 확인하지 않은 이름·화면 좌표를 가정하지 않습니다.

Build 설정의 **Build variables and secrets**는 빌드 때만 사용하는 값입니다. 앱 런타임 비밀 5개는 자동 helper가 Worker secrets로 저장하므로 해당 입력란에 수동으로 붙여 넣지 않습니다. 서버 비밀이 준비됐다는 로그만으로 가입·로그인이나 푸시가 실환경에서 검증된 것은 아닙니다.

### 배포 후 확인

[실제 앱](https://money-safe.ttlikim16.workers.dev)에서 health, 가입·로그인·지출 저장·새로고침·내보내기를 확인합니다. 현재 가입 오류가 해결된 뒤 진행합니다. 무료 플랜의 실제 CPU 사용량과 오류도 확인합니다. 특히 보안 해싱과 예약 발송이 로컬에서 통과했더라도 실제 Workers의 10ms CPU 한도 검증은 배포 후 별도입니다.

iPhone Safari에서 실제 주소를 열고 공유 → 홈 화면에 추가 → 설치 아이콘으로 실행합니다. **이 기기 알림 켜기**를 누른 뒤 권한을 허용합니다. 앱이 이미 종료된 상태에서 다른 브라우저의 같은 사용자 계정으로 **테스트 푸시 보내기**를 눌러 잠금화면 수신을 확인합니다. [iPhone 테스트 기록](iphone-test.md)을 실제 관찰로 채웁니다.

## 로컬 Cloudflare 실행 (개발자)

Node.js 24에서 저장소 루트 기준으로 실행합니다.

```sh
npm ci
npm run keys
npm run cf:prepare
npm run build
npm run cf:migrate:local
npm run cf:dev
```

`http://127.0.0.1:8787`에서 앱을 확인합니다. `cf:prepare`는 `.env`의 VAPID 공개·비밀키, VAPID 연락처, 구독 암호화키, 세션 비밀만 `.dev.vars`로 옮기고 새 파일의 origin을 `http://127.0.0.1:8787`로 지정합니다. 파일 권한은 600이며 기존의 비어 있지 않은 값은 보존합니다. 기존 `.dev.vars`가 `http://localhost:8787` 또는 다른 포트이면 `PUBLIC_ORIGIN`만 접속 주소와 일치하게 편집합니다. 키 값은 터미널에 출력하지 않습니다. Cloudflare 인증 정보는 복사 대상이 아닙니다.

로컬 D1은 원격 D1과 별개입니다. 로컬 계정·지출·구독이 원격 앱으로 자동 이전되지 않습니다. 로컬 HTTP는 데스크톱 개발 확인용이며 실제 iPhone은 공개 HTTPS 앱을 홈 화면에 설치하여 검증합니다.

검증 명령은 다음과 같습니다. dry run은 배포 파일을 준비할 뿐 공개 URL을 발급하거나 예약 알림을 실행하지 않습니다.

```sh
npm run lint
npm test
npm run build
npm run cf:dry-run
npm run test:e2e:cloudflare
```

로컬 예약 handler는 개발 서버의 테스트용 주소로 호출할 수 있습니다. 운영 시각이나 사용자 데이터를 임의로 바꾸지 않습니다.

```sh
curl --fail 'http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*'
```

## 개발자 CLI 대안

다음은 Cloudflare API에 접속할 수 있는 개발 환경에서 사용하는 CLI 절차입니다. 현재 Codex 머신에서는 Cloudflare 인증·API 접근이 HTTP 403으로 차단되어 있어 이 경로의 원격 작업이 진행되지 않았습니다. 앞의 GitHub import 방식은 Cloudflare 자체 빌드 서버에서 수행합니다.

CLI를 사용하는 개발자는 별도로 Wrangler 계정을 연결합니다. [공식 device 승인 방식](https://developers.cloudflare.com/workers/wrangler/commands/general/#use-wrangler-login-without-a-local-callback-server)은 다른 컴퓨터의 브라우저로도 가능하며 코드는 보통 5분 후 만료됩니다.

```sh
npm run cf:login
npm run cf:whoami
```

인증 정보는 저장소 밖의 Wrangler 설정 디렉터리에 보관합니다. CLI helper는 HOME을 바꾸지 않고 XDG 설정 경로를 사용하며, 기존 홈의 `.wrangler`가 있으면 Wrangler는 그 경로를 우선합니다. OAuth/API 자격증명을 `.env`, `.dev.vars`, 앱 코드에 복사하지 않습니다.

### 새 Worker의 수동 초기 설정

**자동 배포로 이미 만들어진 Worker에는 아래의 로컬 secret bulk 절차를 실행하지 않습니다.** Cloudflare에서 처음 생성된 키는 로컬 `.env`의 키와 다를 수 있고, `secret list`로 기존 비밀값을 회수할 수 없습니다. 기존 키가 있는 Worker의 업데이트는 키를 보존하는 자동 helper로 진행합니다. 키 일부가 없어졌다면 임의 재생성 대신 원래 값으로 일관성을 복구해야 합니다.

다음은 비밀이 아직 없는 새 Worker를 수동 초기 설정하는 경우의 참고 절차입니다. 계정 연결·네트워크 접근을 먼저 확인합니다. 원격 인증 실패 중에는 D1 생성이나 배포가 완료됐다고 표시하지 않습니다.

1. 기존 D1 목록을 확인합니다. 같은 이름의 올바른 DB가 이미 있으면 재사용하고, 없을 때만 생성합니다.

```sh
node scripts/cloudflare-cli.mjs d1 list
node scripts/cloudflare-cli.mjs d1 create salary-guardians-db
```

생성 결과나 기존 DB 목록에서 **실제 database_id**를 확인하여 `wrangler.jsonc`의 해당 D1 binding에 추가합니다. 임의 UUID나 예시 ID로 원격 배포하지 않습니다. DB binding 이름은 `DB`, DB 이름은 `salary-guardians-db`입니다.

2. 실제 원격 DB에 migrations를 적용합니다. 새 DB에 테이블을 생성하는 절차이며, 기존 운영 DB를 삭제하거나 덮어쓰는 명령을 추가하지 않습니다.

```sh
node scripts/cloudflare-cli.mjs d1 migrations apply salary-guardians-db --remote
npm run build
npm run cf:deploy
```

처음 배포에서 발급된 **실제 HTTPS 주소**를 기록합니다. 아직 서버 비밀 설정이 없다면 로그인·푸시는 준비되지 않은 상태입니다. URL 출력이나 앱 화면 표시만으로 완료라고 표시하지 않습니다.

3. `salary_app_url` 변수에 Cloudflare가 실제로 반환한 HTTPS 주소를 지정합니다. 이 공개 주소는 비밀이 아닙니다. 다음 helper로 운영 비밀 파일을 준비합니다.

```sh
npm run cf:prepare -- --secrets-out .cloudflare-secrets.json --subject "$salary_app_url"
node scripts/cloudflare-cli.mjs secret bulk .cloudflare-secrets.json
npm run cf:deploy
```

운영 JSON에는 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `DATA_ENCRYPTION_KEY`, `SESSION_SECRET`만 들어갑니다. `PUBLIC_ORIGIN`, API/OAuth 인증 정보, 거래 기록은 넣지 않습니다. 파일 권한은 600이고 Git·Docker build context에서 제외해야 합니다. helper는 기존 VAPID 쌍·암호화키·세션 비밀을 유지하며 명시한 연락 URL만 갱신할 수 있습니다. 원래 키를 잃으면 기존 구독 복호화나 발송이 영향을 받으므로 접근을 제한한 비밀 보관소에 백업합니다. JSON 내용을 터미널이나 채팅에 출력하지 않습니다.

Wrangler의 [secret bulk](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk)는 파일에서 직접 값을 가져옵니다. 파일에 없는 기존 비밀은 보존되지만 이름이 같은 값을 넣으면 갱신하므로 위의 새 Worker 조건을 지킵니다. 파일을 삭제하기 전 안전한 비밀 백업을 확보합니다.

4. 실제 주소에서 상태·설치 파일을 검사하고 가입·저장·새로고침·내보내기를 확인합니다.

```sh
curl --fail "$salary_app_url/api/health"
curl --fail "$salary_app_url/manifest.webmanifest"
curl --fail "$salary_app_url/sw.js"
node scripts/cloudflare-cli.mjs tail salary-guardians
```

실제 iPhone Safari에서 주소를 열고 공유 → 홈 화면에 추가 → 설치 아이콘으로 실행합니다. **이 기기 알림 켜기**를 직접 누르고 권한을 허용합니다. 앱이 이미 종료된 뒤 다른 브라우저의 같은 테스트 계정에서 **테스트 푸시 보내기**를 눌러 실제 잠금화면 수신을 확인합니다. 상세 기록은 [iPhone 검증 절차](iphone-test.md)를 따릅니다. 이 배포에서는 Docker worker 로그 대신 Wrangler tail/Cloudflare Worker 로그를 사용합니다.

## 무료 한도와 예약 푸시

이 구성은 1분마다 실행되는 Cron 하나를 사용합니다. KST 급여일·일요일·주기 마지막 날, 80% 첫 도달, 미기록 조건을 서버 데이터로 확인하고 저장된 발송 이력으로 중복을 억제합니다. 알림 대상 사용자를 오래 기다린 순서로 최대 2명 확인하고, 전달 작업은 최대 8건 처리합니다. batch 안의 문장까지 포함하여 호출당 D1 쿼리 50개 한도를 계산하므로 남은 예산에 따라 8건보다 적게 처리할 수 있습니다. 밀린 사용자·작업은 DB에 남겨 다음 분에 처리합니다. 여러 기기·사용자가 많아지면 발송 지연과 쿼리/CPU 사용량을 확인해야 합니다.

재시도는 30초부터 지수 지연하고 기본 최대 1시간 간격·8회 시도하며 실제 다음 1분 Cron에서 처리합니다. push 서비스의 `Retry-After`는 최대 24시간 범위에서 따릅니다. 정기 일정 누락은 12시간 범위에서 보완하고 예정 시각으로부터 24시간 후 만료합니다. 조건부 작업도 생성 후 24시간에 만료하며, 새 지출이 저장되면 오래된 미기록 작업은 취소합니다. 404/410 구독은 제거하고 테스트 푸시는 사용자별 1분에 최대 5회입니다. 발송 로그의 `deliveryId`, UTC `timestamp`, `attempt`, `result`, 가능한 경우 `statusCode`를 기기 관찰과 함께 기록합니다.

무료 Workers의 CPU 한도는 HTTP·Cron 모두 호출당 10ms입니다. 네트워크·D1 응답을 기다리는 시간은 CPU 시간에 포함되지 않지만 암호화 계산이 자동 제외된다고 가정하지 않습니다. 비밀번호 해싱의 보안을 낮춰 한도에 맞추지 않으며 실제 배포 로그의 CPU와 오류를 확인해야 합니다. 로컬 성능이나 모의 발송 통과만으로 실제 무료 플랜 실행을 입증하지 않습니다.

| 항목 | 공식 무료 한도 |
| --- | --- |
| 동적 Workers 요청 | 하루 100,000회 |
| 정적 파일 요청 | 무료·무제한 |
| Cron | 계정당 5개; 이 앱은 1개 사용 |
| D1 읽기 / 쓰기 | 하루 500만 행 / 10만 행 |
| D1 저장 | 계정 합계 5GB; DB 하나 최대 500MB |
| D1 Time Travel | 7일 |

한도 초과 시 API·DB 작업이 실패할 수 있습니다. Cron은 앱 방문과 별개로 실행되지만 실행 중단에 대비한 저장된 재시도와 멱등 처리가 필요합니다. 무료 플랜은 유료 서비스 가입 없이 사용하고, 현재 계정에서 유료 제품을 활성화하거나 자동 유료 전환을 설정하지 않습니다.

서버가 푸시 서비스에 발송을 접수했다는 로그는 iPhone 표시 증거가 아닙니다. iOS 집중 모드, 알림 요약, 네트워크 상태에 따라 표시 시간이 달라집니다. **공개 HTTPS 배포·실기기 종료 상태 수신·클릭 이동·해제까지 검증한 뒤에만 푸시 완료를 표시합니다.**

## 백업과 업데이트

Cloudflare 대시보드의 D1 Time Travel은 무료 플랜에서 7일 복구를 제공합니다. 별도 DB export도 보관합니다. 내보낸 DB에는 계정과 금융 기록이 포함되므로 공개 파일 경로에 두지 않습니다.

```sh
mkdir -p backups
chmod 700 backups
salary_backup="./backups/cloudflare-$(date -u +%Y%m%dT%H%M%SZ).sql"
umask 077
node scripts/cloudflare-cli.mjs d1 export salary-guardians-db --remote --output "$salary_backup"
chmod 600 "$salary_backup"
```

백업은 위처럼 날짜별 새 파일명을 사용하고 별도의 암호화된 저장소에 보관합니다. DB 백업과 별도로 원래 서버 비밀 5개를 안전하게 보관합니다. 운영 키를 바꾸지 않고 업데이트할 때는 빌드·필요한 migrations·배포를 수행합니다. 계정의 전체 D1 DB나 Worker 삭제는 사용자 데이터가 사라지는 별도 작업이므로 일반 업데이트 절차에 넣지 않습니다.

공식 참고: [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/) · [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/) · [Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/) · [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 한도](https://developers.cloudflare.com/d1/platform/limits/) · [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
