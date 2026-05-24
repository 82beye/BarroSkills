#!/usr/bin/env node

/**
 * build-distribution.js
 *
 * 에피소드 렌더링 완료 후, 3개 플랫폼용 배포 패키지를 생성한다.
 * - distribution/youtube/    : API 자동 업로드용
 * - distribution/tiktok/     : 수동 업로드용 (체크리스트 포함)
 * - distribution/reels/      : 수동 업로드용 (체크리스트 포함)
 *
 * 각 디렉토리에는:
 *   - video.mp4        (원본 렌더 영상 심볼릭 링크)
 *   - caption.txt      (플랫폼별 캡션)
 *   - hashtags.txt     (플랫폼별 해시태그)
 *   - checklist.md     (수동 업로드 체크리스트 — TikTok/Reels만)
 *   - thumbnail.jpg    (YouTube만)
 */

import { mkdirSync, writeFileSync, symlinkSync, existsSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const PLATFORMS = ['youtube', 'tiktok', 'reels'];

/**
 * 플랫폼별 캡션/해시태그 생성 기본값
 * 메타데이터(70_publish_meta.json)에 플랫폼별 필드가 없으면 제목+요약으로 폴백
 */
function buildCaption(meta, platform) {
  const platformMeta = meta.platforms?.[platform];
  if (platformMeta?.caption) return platformMeta.caption;

  const base = `${meta.title || ''}\n\n${meta.summary || ''}`.trim();
  if (platform === 'youtube') {
    const desc = meta.description || base;
    return `${desc}\n\n${meta.chapters ? meta.chapters.map(c => `${c.timestamp} ${c.title}`).join('\n') : ''}`.trim();
  }
  if (platform === 'tiktok' || platform === 'reels') {
    return base.slice(0, 2000);
  }
  return base;
}

function buildHashtags(meta, platform) {
  const platformMeta = meta.platforms?.[platform];
  if (platformMeta?.hashtags?.length) return platformMeta.hashtags;

  const defaults = {
    youtube: ['#Shorts', ...(meta.tags || []).slice(0, 5).map(t => `#${t}`)],
    tiktok: (meta.tags || []).slice(0, 5).map(t => `#${t}`),
    reels: (meta.tags || []).slice(0, 8).map(t => `#${t}`),
  };
  return defaults[platform] || [];
}

const CHECKLIST_TEMPLATES = {
  tiktok: `# TikTok 업로드 체크리스트

## 업로드 전 확인
- [ ] 비즈니스 계정인지 확인 (개인 계정은 일부 상업용 음원 제한)
- [ ] 영상 길이 10분 이하 (Shorts 호환 60초 이하 권장)
- [ ] 세로 포맷 1080x1920, MP4/MOV
- [ ] BGM이 3rd-party 저작물이면 Commercial Music Library 음원으로 교체

## 업로드 단계
1. TikTok 앱 or 웹(tiktok.com/upload) 접속
2. \`video.mp4\` 업로드
3. 캡션: \`caption.txt\` 내용 복사 + 해시태그 말미 추가
4. 커버 이미지: 자동 or 직접 지정 (Reels와 동일 썸네일 재사용 가능)
5. 공개 설정: Public / Everyone
6. 예약 게시 시간: {{publish_at}}
7. 업로드 확인 후 URL 복사

## 업로드 후
- [ ] Paperclip 티켓에 URL 회신: \`paperclip ticket update {{ticket_id}} --tiktok-url <URL>\`
- [ ] Telegram 알림 확인
`,

  reels: `# Instagram Reels 업로드 체크리스트

## 업로드 전 확인
- [ ] Instagram 비즈니스 or 크리에이터 계정인지 확인
- [ ] Facebook 페이지와 연결되어 있는지 (API 확장 대비)
- [ ] 영상 길이 90초 이하
- [ ] 세로 포맷 1080x1920, MP4 (H.264), 30fps
- [ ] 음원: 인스타 오디오 라이브러리 or 저작권 문제 없는 원본 사용

## 업로드 단계
1. Instagram 앱(모바일 권장) or 웹(instagram.com/create) 접속
2. \`video.mp4\` 업로드
3. 커버 프레임 선택 (앱: Cover 메뉴)
4. 캡션: \`caption.txt\` 내용 복사
5. 해시태그: \`hashtags.txt\` 말미 또는 첫 댓글에 추가
6. 공개 설정: Public / Everyone
7. 음원 크레딧 표기 (원본 BGM 사용 시)
8. 업로드 확인 후 URL 복사 (instagram.com/reel/XXXX)

## 업로드 후
- [ ] Paperclip 티켓에 URL 회신: \`paperclip ticket update {{ticket_id}} --reels-url <URL>\`
- [ ] Telegram 알림 확인
`,
};

export function buildDistributionPackage({ episodeDir, videoPath, thumbnailPath, meta, ticketId }) {
  const distDir = join(episodeDir, 'distribution');
  mkdirSync(distDir, { recursive: true });

  const results = {};

  for (const platform of PLATFORMS) {
    const targetDir = join(distDir, platform);
    mkdirSync(targetDir, { recursive: true });

    // 영상 심볼릭 링크
    const videoLink = join(targetDir, 'video.mp4');
    if (existsSync(videoLink)) unlinkSync(videoLink);
    if (videoPath && existsSync(videoPath)) {
      try {
        symlinkSync(resolve(videoPath), videoLink);
      } catch {
        copyFileSync(videoPath, videoLink);
      }
    }

    // 캡션
    const caption = buildCaption(meta, platform);
    writeFileSync(join(targetDir, 'caption.txt'), caption, 'utf-8');

    // 해시태그
    const hashtags = buildHashtags(meta, platform);
    writeFileSync(join(targetDir, 'hashtags.txt'), hashtags.join(' '), 'utf-8');

    // 썸네일 (YouTube만)
    if (platform === 'youtube' && thumbnailPath && existsSync(thumbnailPath)) {
      copyFileSync(thumbnailPath, join(targetDir, 'thumbnail.jpg'));
    }

    // 체크리스트 (TikTok/Reels만)
    if (CHECKLIST_TEMPLATES[platform]) {
      const checklist = CHECKLIST_TEMPLATES[platform]
        .replace(/\{\{publish_at\}\}/g, meta.publish_at || 'ASAP')
        .replace(/\{\{ticket_id\}\}/g, ticketId || 'N/A');
      writeFileSync(join(targetDir, 'checklist.md'), checklist, 'utf-8');
    }

    results[platform] = {
      path: targetDir,
      hasVideo: existsSync(videoLink),
      hasCaption: true,
      hasHashtags: true,
      hasChecklist: Boolean(CHECKLIST_TEMPLATES[platform]),
      hasThumbnail: platform === 'youtube' && existsSync(join(targetDir, 'thumbnail.jpg')),
    };
  }

  return { distDir, platforms: results };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i += 2) {
    opts[args[i].replace(/^--/, '')] = args[i + 1];
  }

  if (!opts.episode || !opts.video || !opts.meta) {
    console.error('Usage: build-distribution.js --episode <dir> --video <path> --meta <path> [--thumbnail <path>] [--ticket <id>]');
    process.exit(1);
  }

  const { readFileSync } = await import('node:fs');
  const meta = JSON.parse(readFileSync(opts.meta, 'utf-8'));
  const result = buildDistributionPackage({
    episodeDir: opts.episode,
    videoPath: opts.video,
    thumbnailPath: opts.thumbnail,
    meta,
    ticketId: opts.ticket,
  });

  console.log('✅ Distribution packages created:');
  console.log(`   📁 ${result.distDir}`);
  for (const [platform, info] of Object.entries(result.platforms)) {
    console.log(`   • ${platform.padEnd(8)} ${info.hasVideo ? '🎬' : '❌'} video ${info.hasThumbnail ? '🖼' : ''} ${info.hasChecklist ? '📋' : ''}`);
  }
}
