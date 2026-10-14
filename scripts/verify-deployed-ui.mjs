// Read-only readiness check: wait for the spending missions and temporary budget UI to reach the public site.
const origin = new URL(process.argv[2] ?? 'https://money-safe.ttlikim16.workers.dev').origin;
let ready = false;
for (let attempt = 0; attempt < 12; attempt++) {
  try {
    const options = { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000) };
    const response = await fetch(`${origin}/`, options);
    if (!response.ok) throw new Error('App shell unavailable');
    const html = await response.text();
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)];
    for (const [, path] of scripts) {
      const url = new URL(path, origin);
      if (url.origin !== origin || !url.pathname.startsWith('/assets/') || !url.pathname.endsWith('.js')) continue;
      const asset = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
      if (!asset.ok) continue;
      const text = await asset.text();
      if (text.includes('저축 계좌 잔액 저장') && text.includes('오늘의 절약 미션') && text.includes('소비 몹을 막아라!') && text.includes('정기지출 6개 불러오기') && text.includes('오늘 비정기 소비') && text.includes('24시간 보류 시작') && text.includes('월급 전 예산으로 시작')) ready = true;
    }
    if (ready) break;
  } catch { /* A Git-triggered deployment may still be updating its assets. */ }
  if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 5_000));
}
if (ready) console.log('::notice title=Deployed spending tools::정기·비정기 카테고리 화면의 공개 배포를 확인했습니다.');
else {
  console.error('::error title=Deployed spending tools::새 정기·비정기 카테고리 화면의 배포를 확인하지 못했습니다. Cloudflare 빌드 결과를 확인해 주세요.');
  process.exitCode = 1;
}
