/**
 * Caption Reel Builder — 영상 클립 + 자막 + (선택)인-애니메이션 CapCut 드래프트 생성기.
 *
 * 기존 capcut-draft-builder.js(이미지+TTS 슬라이드쇼)와 별개로, 이미 만들어진
 * 영상 클립들을 세로 릴스로 이어 붙이고 컷별 자막 + CapCut 네이티브 인-애니메이션을
 * JSON에 직접 주입한다. 애니메이션 resource는 animations.json 레지스트리에서 가져오며,
 * 새 스타일은 CapCut에서 1회 시드 후 scripts/capture-animation.mjs 로 등록한다.
 */
import { uuid, createVideoMaterial, createAudioMaterial, createTextMaterial,
         createSupportMaterials, createSegment, CANVAS_PRESETS, CAPCUT_PROJECTS_DIR }
  from './capcut-draft-builder.js';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dir = dirname(fileURLToPath(import.meta.url));

export function loadAnimations() {
  const p = join(__dir, '..', 'animations.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : {};
}

/** ffprobe로 길이(us) 계산 — 실패 시 null */
export function probeDurationUs(path) {
  try {
    const s = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`, { encoding: 'utf-8' }).trim();
    return Math.round(parseFloat(s) * 1_000_000);
  } catch { return null; }
}

function makeAnimationMaterial(animEntry) {
  return {
    id: uuid(),
    type: 'sticker_animation',
    animations: [ JSON.parse(JSON.stringify(animEntry)) ],
    multi_language_current: 'none',
  };
}

/**
 * @param {object} o
 * @param {string} o.projectName
 * @param {Array<{videoPath:string, caption:string, durationUs?:number}>} o.clips
 * @param {string} [o.bgmPath]
 * @param {string} [o.animation]  animations.json 키 (예: 'chalk_in'); null이면 애니메이션 없음
 * @param {'vertical'|'landscape'} [o.canvas]
 * @param {object} [o.textStyle] { fontSize, fontColor, transformY, shadow, border }
 * @param {boolean} [o.muteClipAudio] 클립 원음 음소거(기본 true)
 * @param {string} [o.outputDir]
 */
export function buildCaptionReel(o) {
  const {
    projectName, clips, bgmPath = null, animation = null,
    canvas = 'vertical', muteClipAudio = true, outputDir = null,
  } = o;
  const ts = Object.assign({ fontSize: 15, fontColor: '#FFFFFF', transformY: -0.72, shadow: true, border: true }, o.textStyle || {});
  const cv = CANVAS_PRESETS[canvas];
  if (!cv) throw new Error(`unknown canvas: ${canvas}`);
  if (!clips?.length) throw new Error('clips required');

  const registry = loadAnimations();
  const animEntry = animation ? registry[animation]?.entry : null;
  if (animation && !animEntry) throw new Error(`animation '${animation}' not in animations.json (keys: ${Object.keys(registry).join(', ')})`);

  const projectDir = outputDir || join(CAPCUT_PROJECTS_DIR, projectName);
  ['Resources','adjust_mask','matting','smart_crop','subdraft','qr_upload','common_attachment']
    .forEach(d => mkdirSync(join(projectDir, d), { recursive: true }));

  const videoMaterials=[], textMaterials=[], audioMaterials=[];
  const speeds=[], canvases=[], animations=[], soundChannels=[], placeholders=[], colors=[], vocalSeps=[];
  const videoSegments=[], textSegments=[], bgmSegments=[];

  let t = 0;
  clips.forEach((c, i) => {
    const durUs = c.durationUs || probeDurationUs(c.videoPath);
    if (!durUs) throw new Error(`duration unknown for ${c.videoPath} (ffprobe 실패 → durationUs 명시)`);

    const vId = uuid();
    videoMaterials.push(createVideoMaterial(vId, c.videoPath, 'video', cv.width, cv.height, durUs));
    const sup = createSupportMaterials();
    speeds.push(sup.speed); canvases.push(sup.canvas); animations.push(sup.animation);
    soundChannels.push(sup.soundChannel); placeholders.push(sup.placeholder); colors.push(sup.color); vocalSeps.push(sup.vocalSep);
    const vSeg = createSegment(vId, t, durUs, sup.refs, i);
    if (muteClipAudio) { vSeg.volume = 0; vSeg.last_nonzero_volume = 1.0; }
    videoSegments.push(vSeg);

    const tId = uuid();
    const tm = createTextMaterial(tId, c.caption, '', ts.fontSize, ts.fontColor);
    if (ts.shadow) { tm.has_shadow = true; tm.shadow_color = '#000000'; tm.shadow_alpha = 0.8; }
    if (ts.border) { tm.border_color = '#000000'; tm.border_width = 0.06; tm.border_alpha = 1.0; }
    textMaterials.push(tm);
    const refs = [];
    if (animEntry) { const ma = makeAnimationMaterial(animEntry); animations.push(ma); refs.push(ma.id); }
    textSegments.push(createSegment(tId, t, durUs, refs, i, 1.0, ts.transformY));

    t += durUs;
  });
  const total = t;

  if (bgmPath && existsSync(bgmPath)) {
    const bId = uuid();
    audioMaterials.push(createAudioMaterial(bId, bgmPath, 'bgm.wav', total));
    bgmSegments.push(createSegment(bId, 0, total, [], 0, 1.0));
  }

  const draftId = uuid();
  const plat = { app_id:359289, app_source:'cc', app_version:'7.6.0', device_id:'', hard_disk_id:'', mac_address:'', os:'mac', os_version:'' };
  const draft = {
    canvas_config:{ background:null, height:cv.height, ratio:cv.ratio, width:cv.width }, color_space:-1,
    config:{ adjust_max_index:1, attachment_info:[], combination_max_index:1, export_range:null, extract_audio_last_index:1,
      lyrics_recognition_id:'', lyrics_sync:true, lyrics_taskinfo:[], maintrack_adsorb:true, material_save_mode:0,
      multi_language_current:'none', multi_language_list:[], multi_language_main:'none', multi_language_mode:'none',
      original_sound_last_index:1, record_audio_last_index:1, sticker_max_index:1, subtitle_keywords_config:null,
      subtitle_recognition_id:'', subtitle_sync:true, subtitle_taskinfo:[], system_font_list:[], use_float_render:false, video_mute:false, zoom_info_params:null },
    cover:null, create_time:0, draft_type:'video', duration:total, extra_info:null, fps:30.0, free_render_index_mode_on:false,
    function_assistant_info:{ audio_noise_segid_list:[], auto_adjust:false, auto_adjust_fixed:false, auto_adjust_fixed_value:50.0, auto_adjust_segid_list:[],
      auto_caption:false, auto_caption_segid_list:[], auto_caption_template_id:'', caption_opt:false, caption_opt_segid_list:[], color_correction:false,
      color_correction_fixed:false, color_correction_fixed_value:50.0, color_correction_segid_list:[], deflicker_segid_list:[], enhance_quality:false,
      enhance_quality_fixed:false, enhance_quality_segid_list:[], enhance_voice_segid_list:[], enhande_voice:false, enhande_voice_fixed:false,
      eye_correction:false, eye_correction_segid_list:[], fixed_rec_applied:false, fps:{den:1,num:0}, normalize_loudness:false,
      normalize_loudness_audio_denoise_segid_list:[], normalize_loudness_fixed:false, normalize_loudness_segid_list:[], retouch:false, retouch_fixed:false,
      retouch_segid_list:[], smart_rec_applied:false, smart_segid_list:[], smooth_slow_motion:false, smooth_slow_motion_fixed:false, video_noise_segid_list:[] },
    group_container:null, id:draftId, is_drop_frame_timecode:false, keyframe_graph_list:[],
    keyframes:{ adjusts:[], audios:[], effects:[], filters:[], handwrites:[], stickers:[], texts:[], videos:[] },
    last_modified_platform:plat, lyrics_effects:[],
    materials:{ ai_translates:[], audio_balances:[], audio_effects:[], audio_fades:[], audio_pannings:[], audio_pitch_shifts:[], audio_track_indexes:[],
      audios:audioMaterials, beats:[], canvases, chromas:[], color_curves:[], common_mask:[], digital_human_model_dressing:[], digital_humans:[], drafts:[],
      effects:[], flowers:[], green_screens:[], handwrites:[], hsl:[], hsl_curves:[], images:[], log_color_wheels:[], loudnesses:[], manual_beautys:[],
      manual_deformations:[], material_animations:animations, material_colors:colors, multi_language_refs:[], placeholder_infos:placeholders, placeholders:[],
      plugin_effects:[], primary_color_wheels:[], realtime_denoises:[], shapes:[], smart_crops:[], smart_relights:[], sound_channel_mappings:soundChannels,
      speeds, stickers:[], tail_leaders:[], text_templates:[], texts:textMaterials, time_marks:[], transitions:[], video_effects:[], video_radius:[],
      video_shadows:[], video_strokes:[], video_trackings:[], videos:videoMaterials, vocal_beautifys:[], vocal_separations:vocalSeps },
    mutable_config:null, name:'', new_version:'149.0.0', path:'', platform:plat, relationships:[], render_index_track_mode_on:true, retouch_cover:null,
    smart_ads_info:{ draft_url:'', page_from:'', routine:'' }, source:'default', static_cover_image_path:'', time_marks:null,
    tracks:[
      { attribute:0, flag:0, id:uuid(), is_default_name:true, name:'', segments:videoSegments, type:'video' },
      ...(bgmSegments.length ? [{ attribute:0, flag:0, id:uuid(), is_default_name:true, name:'', segments:bgmSegments, type:'audio' }] : []),
      { attribute:0, flag:0, id:uuid(), is_default_name:true, name:'', segments:textSegments, type:'text' },
    ],
    uneven_animation_template_info:{ composition:'', content:'', order:'', sub_template_info_list:[] }, update_time:0, version:360000,
  };

  const now = Date.now() * 1000;
  const metaInfo = { cloud_draft_cover:false, cloud_draft_sync:false, cloud_package_completed_time:'', draft_cloud_capcut_purchase_info:'',
    draft_cloud_last_action_download:false, draft_cloud_package_type:'', draft_cloud_purchase_info:'', draft_cloud_template_id:'',
    draft_cloud_tutorial_info:'', draft_cloud_videocut_purchase_info:'', draft_cover:'', draft_deeplink_url:'',
    draft_enterprise_info:{ draft_enterprise_extra:'', draft_enterprise_id:'', draft_enterprise_name:'', enterprise_material:[] },
    draft_fold_path:projectDir, draft_id:draftId, draft_is_ae_produce:false, draft_is_ai_packaging_used:false, draft_is_ai_shorts:false,
    draft_is_ai_translate:false, draft_is_article_video_draft:false, draft_is_cloud_temp_draft:false, draft_is_from_deeplink:'false',
    draft_is_invisible:false, draft_is_web_article_video:false, draft_materials_copied_info:[], draft_name:projectName, draft_need_rename_folder:false,
    draft_new_version:'', draft_removable_storage_device:'', draft_root_path:CAPCUT_PROJECTS_DIR, draft_segment_extra_info:[],
    draft_timeline_materials_size_:0, draft_type:'', tm_draft_cloud_completed:'', tm_draft_cloud_entry_id:-1, tm_draft_cloud_modified:0,
    tm_draft_cloud_parent_entry_id:-1, tm_draft_cloud_space_id:-1, tm_draft_cloud_user_id:-1, tm_draft_create:now, tm_draft_modified:now,
    tm_draft_removed:0, tm_duration:total };
  const agencyConfig = { is_auto_agency_enabled:false, is_auto_agency_popup:false, is_single_agency_mode:false, marterials:null, use_converter:false, video_resolution:1080 };

  writeFileSync(join(projectDir,'draft_info.json'), JSON.stringify(draft), 'utf-8');
  writeFileSync(join(projectDir,'draft_info.json.bak'), JSON.stringify(draft), 'utf-8');
  writeFileSync(join(projectDir,'draft_meta_info.json'), JSON.stringify(metaInfo), 'utf-8');
  writeFileSync(join(projectDir,'draft_agency_config.json'), JSON.stringify(agencyConfig), 'utf-8');
  writeFileSync(join(projectDir,'draft_biz_config.json'), '', 'utf-8');
  writeFileSync(join(projectDir,'draft_settings'), '', 'utf-8');
  writeFileSync(join(projectDir,'performance_opt_info.json'), JSON.stringify({ performance_suggest_mode:0 }), 'utf-8');

  return { projectDir, durationUs: total, clips: clips.length, animation: animation || 'none' };
}
