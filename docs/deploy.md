# 실행과 HTTPS 배포

이 문서는 일반 Node/Docker 서버 배포 안내입니다. 사용자가 선택한 **Cloudflare 무료 배포**는 [별도 안내](cloudflare.md)를 사용하세요. Cloudflare 구현은 상시 프로세스 대신 Workers/D1/Cron을 사용합니다.

이 앱은 React 화면, Node 24 API, 별도 Node 예약 발송 worker로 구성됩니다. Vite 정적 파일만 배포하면 예약 푸시가 동작하지 않습니다. 브라우저나 iPhone 화면이 닫혀도 **서버와 worker가 계속 실행**되어야 합니다. 외부 HTTPS 배포와 실제 iPhone 수신 검증은 배포 계정·DNS·기기가 필요한 후속 단계이며, 코드 테스트 통과만으로 완료되지 않습니다.

## 로컬 실행

Node.js 24와 npm을 설치하고 저장소 루트에서 실행합니다.

```sh
npm ci
npm run keys -- --origin http://localhost:5173
npm run dev
```

기본 데이터는 `shared/starter-config.json`입니다. 화면의 가입 폼으로 계정을 만듭니다. `npm run keys`는 `.env`에 VAPID 쌍, 32바이트 구독 암호화키, 세션 비밀을 생성하며 기존의 비어 있지 않은 값을 보존합니다. 비밀값은 콘솔에 출력하지 않습니다. `.env`는 Git에서 제외되고 파일 권한은 600으로 설정됩니다. 개발용 `VAPID_SUBJECT=mailto:local-test@example.invalid`는 공개 배포 전에 실제 연락 이메일로 바꿉니다.

`npm run dev`는 API, Vite 개발 서버, worker를 함께 실행합니다. 기본 브라우저 주소는 `http://localhost:5173`입니다. 이 포트가 이미 사용 중이면 Vite 안내 포트에 맞춰 `.env`의 `PUBLIC_ORIGIN`을 바꾸고 개발 서버를 다시 시작합니다. `PUBLIC_ORIGIN`은 실제 브라우저 origin과 맞추어야 합니다. 이미 생성된 `.env`에서 origin이 3000이면 직접 5173으로 편집합니다. 로컬 개발 HTTP는 데스크톱 확인용입니다. iPhone에서는 HTTPS 배포 후 홈 화면에 설치하여 푸시를 검증합니다.

```sh
npm run lint
npm test
npm run build
```

빌드한 앱은 기본 `http://localhost:3000`에서 API와 함께 제공됩니다. **빌드 결과 실행 전 `.env`의 `PUBLIC_ORIGIN`을 `http://localhost:3000`으로 바꾸고** `npm start`를 실행합니다. 별도 터미널에서 `npm run worker:prod`도 실행합니다. 운영에서는 아래 Compose가 두 프로세스를 자동 재시작합니다.

```sh
npm start
```

## 필요한 운영 설정

| 이름 | 의미 | 보관/변경 규칙 |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | 실제 `https://앱도메인` | 경로·끝 슬래시 없이 지정; 인증과 API origin 검사에 사용 |
| `APP_DOMAIN` | 소유한 DNS 이름 | Compose/Caddy용; `https://` 제외 |
| `ACME_EMAIL` | TLS 인증서 연락 이메일 | Compose/Caddy용 |
| `VAPID_SUBJECT` | `mailto:실제연락이메일` | Web Push 발송자 연락처 |
| `VAPID_PUBLIC_KEY` | 공개 VAPID 키 | 브라우저에 제공됨 |
| `VAPID_PRIVATE_KEY` | VAPID 비밀키 | 서버에만 보관; 교체 시 기존 기기 재구독 필요 |
| `DATA_ENCRYPTION_KEY` | base64 32바이트 | 구독 endpoint/키 암호화; 기존 데이터 복호화를 위해 유지 |
| `SESSION_SECRET` | 32바이트 이상 랜덤 비밀 | web/worker가 같은 값 사용; 교체 시 세션 영향 |
| `DATA_DIR` | DB 저장 위치 | 로컬 `./data`; Compose는 `/data` 영구 볼륨으로 고정 |
| `NODE_ENV` | 실행 모드 | Compose는 `production`으로 고정 |
| `PORT` | 내부 HTTP 포트 | Compose는 3000; 인터넷에 직접 공개하지 않음 |
| `TRUST_PROXY` | 단일 신뢰 reverse proxy | Compose는 1; 직접 API에 접속할 수 있는 구성에서 임의 사용 금지 |

`.env`, DB와 백업에는 비밀 또는 금융 기록이 포함됩니다. Git·공개 정적 폴더·오류 보고에 넣지 말고 접근을 제한합니다. 운영 서버의 디스크 암호화와 암호화된 백업도 활성화합니다. `VITE_*` 변수에 서버 비밀을 넣으면 브라우저 빌드에 노출되므로 사용하지 않습니다.

## Docker Compose + Caddy 운영 배포

24시간 켜지는 Linux 서버, Docker Engine/Compose, 실제 소유 도메인이 필요합니다. 이 구성은 **web 1개 + worker 1개**가 같은 SQLite 볼륨을 공유합니다. 다중 서버/복제본으로 확장하기 전에는 공유 PostgreSQL 및 작업 큐로 이전해야 합니다. 서버리스 요청 처리나 잠드는 무료 인스턴스는 이 예약 worker를 실행할 수 없습니다.

1. 소유한 도메인의 A/AAAA 레코드를 서버의 공인 IP로 설정합니다. IPv6를 사용하지 않으면 잘못된 AAAA 레코드를 남기지 않습니다. 서버로 TCP 80/443, 선택적으로 UDP 443을 허용합니다. Node 3000 포트는 공개하지 않습니다.
2. 저장소를 서버에 복사하고 Docker Engine/Compose를 준비합니다. Node 24도 설치하여 `npm ci`를 실행하고 아래 명령의 예시 인자를 **실제 도메인과 이메일로 교체**합니다.

```sh
npm ci
npm run keys -- --origin https://YOUR_REAL_DOMAIN --domain YOUR_REAL_DOMAIN --email YOUR_REAL_EMAIL --subject mailto:YOUR_REAL_EMAIL
```

이 명령은 처음 생성하거나 비어 있는 값을 채웁니다. 이미 로컬 `.env`가 있으면 비어 있지 않은 `PUBLIC_ORIGIN`과 `VAPID_SUBJECT`는 유지되므로, 안전한 편집기로 위 표의 운영 설정을 수정합니다. 기존 키는 재생성하지 않습니다. `APP_DOMAIN`과 `PUBLIC_ORIGIN`은 같은 실제 도메인을 가리켜야 합니다. `.env.example`만 복사한 상태로 배포하지 않습니다.

3. 다음 명령으로 이미지를 빌드하고 지속 실행합니다. `docker compose config`는 비밀 환경변수를 출력할 수 있으므로 검증할 때 `--quiet`를 사용합니다.

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail 50 proxy
```

Caddy는 해당 실제 도메인에 대한 공개 TLS 인증서를 자동 발급·갱신합니다. 인증서 발급에 실패하면 DNS와 80/443 접근을 수정합니다. 자체 서명 인증서나 TLS 검증 우회로 통과시키지 않습니다.

4. 실제 도메인으로 접근하고 상태를 검사합니다.

```sh
curl --fail https://YOUR_REAL_DOMAIN/api/health
curl --fail https://YOUR_REAL_DOMAIN/manifest.webmanifest
curl --fail https://YOUR_REAL_DOMAIN/sw.js
docker compose logs --since 10m worker
```

첫 접속 후 가입·로그인, 수기 지출 저장, 새로고침 유지, 내보내기를 확인합니다. HTTPS 인증서 오류가 없어야 합니다. 프런트와 API는 같은 origin을 사용합니다. [iPhone 테스트 절차](iphone-test.md)에 따라 홈 화면 설치와 실제 알림을 확인합니다.

서버는 인증서 발급, 패키지 다운로드 및 구독 endpoint에 HTTPS로 접근해야 합니다. iPhone 구독은 Apple Web Push endpoint(예: `web.push.apple.com`)를 사용하며 다른 브라우저는 다른 push 서비스를 사용합니다. 실제 구독이 사용한 신뢰 endpoint 호스트를 기준으로 방화벽을 설정하고 외부 HTTPS 발송을 허용합니다. 구독 endpoint 전체나 인증키를 로그에 남기지 않습니다.

### 신뢰 프록시가 있는 빌드 환경

회사 또는 클라우드 환경이 자체 TLS 프록시를 사용하는 경우, 컨테이너의 `npm ci`가 `SELF_SIGNED_CERT_IN_CHAIN`으로 실패할 수 있습니다. 환경 관리자가 제공한 신뢰 CA를 사용합니다. Dockerfile은 선택적 BuildKit `build_ca` secret을 두 설치 단계에서만 사용하며 이미지에 CA를 복사하지 않습니다. 이 클라우드 환경에서는 제공된 `NODE_EXTRA_CA_CERTS` 경로로 실제 빌드와 컨테이너 실행을 검증했습니다.

```sh
docker build --secret "id=build_ca,src=$NODE_EXTRA_CA_CERTS" --tag salary-guardians:local .
docker compose up -d --no-build
```

`NODE_EXTRA_CA_CERTS`가 실제 관리자가 제공한 신뢰 CA 파일을 가리킬 때 사용합니다. `strict-ssl=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k` 등으로 검증을 끄지 않습니다. 홈 디렉터리를 쓸 수 없는 샌드박스에서 Buildx 상태 디렉터리 오류가 나면 위 빌드 명령 앞에 `BUILDX_CONFIG=/tmp/salary-guardians-buildx`를 지정할 수 있습니다. 운영 서버의 outbound TLS도 같은 프록시를 통과한다면 운영 관리자가 제공한 CA를 runtime에 읽기 전용으로 마운트하고 `NODE_EXTRA_CA_CERTS`로 설정해야 합니다. 일반적인 공개 VPS는 추가 CA가 필요하지 않습니다.

## 예약 발송과 운영 확인

worker는 약 30초마다 KST 일정과 이벤트를 확인합니다. 최초 설정은 매월 25일 09:00 월급 분배, 일요일 20:00 주간 결산, 매월 24일 20:00 급여주기 결산, 생활비 80% 첫 도달, 3일 미기록입니다. 앱에서 알림 시간·월급일·미기록 기준을 변경하면 서버 상태를 기준으로 처리합니다. 사용자 상태와 구독이 필요하며 전체 푸시가 꺼져 있으면 발송하지 않습니다.

예약과 전달 상태를 DB에 기록하여 재시작 시 중복을 억제합니다. 네트워크 실패 등 재시도 대상은 30초부터 지수 지연하며 기본 최대 1시간 간격·8회 시도합니다. push 서비스가 `Retry-After`를 반환하면 최대 24시간 범위에서 그 대기시간을 따릅니다. 정기 일정은 12시간 범위에서 누락을 보완하고 해당 예정 시각으로부터 24시간 후 만료시킵니다. 조건부 이벤트는 생성 시각으로부터 24시간 후 만료되며, 미기록 작업은 새 지출이 동기화되면 취소합니다. 장시간 서버 중단 후 과거 일정을 전부 발송하는 구성은 아닙니다. 상태 보존을 위해 볼륨과 기존 암호화키를 유지합니다.

```sh
docker compose logs --since 30m worker
```

worker는 `push_delivery` JSON 로그에 UTC `timestamp`, `deliveryId`, `attempt`, `result`, 가능한 경우 `statusCode`를 기록합니다. `accepted`/HTTP 201은 push 서비스가 발송을 접수했다는 뜻이며 **iPhone 화면에 알림이 표시됐다는 증거가 아닙니다**. 실제 수신은 기기 화면과 아래 테스트 기록으로 별도 확인합니다. 만료된 구독의 404/410은 구독을 제거하고, 권한을 다시 허용한 뒤 재구독합니다. 백오프·중복 제거도 OS가 제공하지 않는 정확히 한 번 수신 보장을 만들지는 못합니다.

iOS의 집중 모드, 알림 요약, 네트워크, 전원 상태는 표시 시간을 바꿀 수 있습니다. 금융 거래/실제 이체 완료를 푸시로 보장하는 앱이 아닙니다. 알림 본문은 지출 메모·금액 대신 일반적인 미션 안내를 사용합니다.

## 백업, 업데이트, 복구

영구 데이터는 Compose `app-data` 볼륨의 `/data/db.sqlite`와 WAL 파일에 있습니다. `docker compose down -v`나 볼륨 삭제는 계정·기록·구독·발송 이력을 제거합니다. 일반 업데이트에는 사용하지 않습니다. `.env` 키를 별도의 접근 제한·암호화된 비밀 보관소에 보관합니다. DB 백업과 함께 원래 `DATA_ENCRYPTION_KEY` 및 VAPID 키 쌍을 복구할 수 있어야 합니다.

SQLite 본체만 실행 중에 복사하면 WAL에 있는 최근 기록이 누락될 수 있습니다. 아래 예시는 쓰기를 중지하고 볼륨 전체를 백업합니다. 짧은 서비스 중단이 생깁니다. 백업 파일은 민감한 금융 데이터를 포함합니다.

```sh
mkdir -p backups
chmod 700 backups
backup_name="app-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker compose stop web worker
docker compose run --rm --no-deps --user root --volume "$PWD/backups:/backup" --env BACKUP_NAME="$backup_name" --env BACKUP_OWNER="$(id -u):$(id -g)" --entrypoint sh web -c 'umask 077; tar -C /data -czf "/backup/$BACKUP_NAME" . && chown "$BACKUP_OWNER" "/backup/$BACKUP_NAME"'
docker compose start web worker
chmod 600 "backups/$backup_name"
```

백업 명령이 실패해도 마지막 `docker compose start web worker`를 실행하여 서비스를 복구합니다. 백업을 암호화된 외부 저장소로 옮기고 주기적으로 복원 테스트를 합니다. DB 압축파일을 Git이나 정적 웹 경로에 놓지 않습니다.

업데이트 시 먼저 위 백업을 수행하고 다음 명령을 실행합니다.

```sh
docker compose up -d --build
docker compose ps
curl --fail https://YOUR_REAL_DOMAIN/api/health
```

복구는 web/worker를 중지한 상태에서 **별도로 준비한 빈 데이터 볼륨**에 백업을 풀고 원래 `.env`의 암호화키와 VAPID 키를 복원한 뒤 실행합니다. 실행 중인 데이터 위에 임의로 덮어쓰지 않습니다. 계정 로그인·기록·내보내기·현재 구독 수를 확인하고 실제 iPhone 테스트 푸시를 다시 확인합니다. 개인 계정 삭제는 앱 설정의 삭제 기능을 사용하여 해당 사용자의 기록·구독·전달 이력을 제거합니다.

## 오프라인과 동기화

앱 설치 후 서비스 워커는 앱 셸을 저장하고 로그인 사용자별 마지막 상태를 사용합니다. 오프라인 편집은 다시 연결될 때 서버 revision과 비교합니다. 다른 기기에서 이미 변경된 상태이면 충돌 화면에서 사용자가 선택해야 하며 서버를 조용히 덮어쓰지 않습니다. 로그인·가입·구독·테스트 푸시에는 서버 연결이 필요합니다. 로그아웃·계정 삭제는 해당 기기의 캐시 정리와 함께 수행합니다. DB/worker가 알 수 있는 소비는 동기화된 수기 입력뿐입니다.
