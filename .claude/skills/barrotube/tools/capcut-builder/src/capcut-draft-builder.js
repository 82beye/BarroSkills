/**
 * CapCut Draft Builder v2 — Real CapCut PC 호환 프로젝트 생성기
 *
 * 실제 CapCut PC 7.x draft_info.json 스키마에 맞춰 프로젝트를 생성한다.
 * ~/Movies/CapCut/User Data/Projects/com.lveditor.draft/{name}/ 에 직접 저장 가능.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';

const CAPCUT_PROJECTS_DIR = join(
  process.env.HOME,
  'Movies/CapCut/User Data/Projects/com.lveditor.draft'
);

function uuid() {
  return randomUUID().toUpperCase();
}

/**
 * Canvas preset
 */
const CANVAS_PRESETS = {
  landscape: { width: 1920, height: 1080, ratio: 'original' },
  vertical: { width: 1080, height: 1920, ratio: '9:16' },
};

/**
 * 비디오/이미지 material 생성
 */
function createVideoMaterial(id, path, type, width, height, durationUs) {
  return {
    aigc_history_id: '',
    aigc_item_id: '',
    aigc_type: 'none',
    audio_fade: null,
    beauty_body_auto_preset: null,
    beauty_body_preset_id: '',
    beauty_face_auto_preset: { name: '', preset_id: '', rate_map: '', scene: '' },
    beauty_face_auto_preset_infos: [],
    beauty_face_preset_infos: [],
    cartoon_path: '',
    category_id: '',
    category_name: 'local',
    check_flag: 62978047,
    content_feature_info: null,
    corner_pin: null,
    crop: {
      lower_left_x: 0.0, lower_left_y: 1.0,
      lower_right_x: 1.0, lower_right_y: 1.0,
      upper_left_x: 0.0, upper_left_y: 0.0,
      upper_right_x: 1.0, upper_right_y: 0.0,
    },
    crop_ratio: 'free',
    crop_scale: 1.0,
    duration: durationUs,
    extra_type_option: 0,
    formula_id: '',
    freeze: null,
    has_audio: type === 'video',
    has_sound_separated: false,
    height,
    id,
    intensifies_audio_path: '',
    intensifies_path: '',
    is_ai_generate_content: false,
    is_copyright: false,
    is_text_edit_overdub: false,
    is_unified_beauty_mode: false,
    live_photo_cover_path: '',
    live_photo_timestamp: -1,
    local_id: '',
    local_material_from: '',
    local_material_id: uuid().toLowerCase(),
    material_id: '',
    material_name: basename(path),
    material_url: '',
    matting: {
      custom_matting_id: '', enable_matting_stroke: false,
      expansion: 0, feather: 0, flag: 0,
      has_use_quick_brush: false, has_use_quick_eraser: false,
      interactiveTime: [], path: '', reverse: false, strokes: [],
    },
    media_path: '',
    multi_camera_info: null,
    object_locked: null,
    origin_material_id: '',
    path,
    picture_from: 'none',
    picture_set_category_id: '',
    picture_set_category_name: '',
    request_id: '',
    reverse_intensifies_path: '',
    reverse_path: '',
    smart_match_info: null,
    smart_motion: null,
    source: 0,
    source_platform: 0,
    stable: { matrix_path: '', stable_level: 0, time_range: { duration: 0, start: 0 } },
    team_id: '',
    type,
    video_algorithm: {
      ai_background_configs: [], ai_expression_driven: null,
      ai_in_painting_config: [], ai_motion_driven: null,
      aigc_generate: null, algorithms: [],
      complement_frame_config: null, deflicker: null,
      gameplay_configs: [], image_interpretation: null,
      motion_blur_config: null, mouth_shape_driver: null,
      noise_reduction: null, path: '', quality_enhance: null,
      smart_complement_frame: null,
      story_video_modify_video_config: { is_overwrite_last_video: false, task_id: '', tracker_task_id: '' },
      super_resolution: null,
      time_range: { duration: durationUs, start: 0 },
    },
    width,
  };
}

/**
 * 오디오 material 생성
 */
function createAudioMaterial(id, path, name, durationUs) {
  return {
    app_id: 0,
    category_id: '',
    category_name: 'local',
    check_flag: 0,
    duration: durationUs,
    effect_id: '',
    formula_id: '',
    id,
    intensifies_path: '',
    is_ugc: false,
    local_material_id: uuid().toLowerCase(),
    music_id: '',
    name,
    path,
    query: '',
    request_id: '',
    resource_id: '',
    search_id: '',
    source_from: '',
    source_platform: 0,
    team_id: '',
    text_id: '',
    tone_category_id: '',
    tone_category_name: '',
    tone_effect_id: '',
    tone_effect_name: '',
    tone_platform: '',
    tone_second_category_id: '',
    tone_second_category_name: '',
    tone_speaker: '',
    tone_type: '',
    type: 'extract_music',
    video_id: '',
    wave_points: [],
  };
}

/**
 * hex color (#FFFFFF) → RGB array [1,1,1]
 */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [Number(r.toFixed(6)), Number(g.toFixed(6)), Number(b.toFixed(6))];
}

/**
 * 긴 한국어 자막을 씬 안에서 자동 줄바꿈 (약 18~22자 기준)
 * CapCut rich-text의 line_max_width가 제대로 안 먹는 이슈 대응
 */
function wrapKoreanSubtitle(text, maxCharsPerLine = 20) {
  if (!text || text.length <= maxCharsPerLine) return text;
  const words = text.split(/(\s+|,|\.)/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + word).length > maxCharsPerLine && current) {
      lines.push(current.trim());
      current = word.replace(/^\s+/, '');
    } else {
      current += word;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.join('\n');
}

/**
 * 텍스트(자막) material 생성 — CapCut rich-text JSON content 형식
 */
function createTextMaterial(id, text, fontFamily, fontSize, fontColor) {
  const rgb = hexToRgb(fontColor);
  // 한국어 시스템 폰트 우선 (영문 폰트면 한글 렌더링 폭 계산 오작동 가능)
  const fontPath = fontFamily || '/System/Library/Fonts/AppleSDGothicNeo.ttc';
  const wrappedText = wrapKoreanSubtitle(text, 20);

  const richContent = JSON.stringify({
    styles: [{
      fill: { content: { solid: { color: rgb }, render_type: 'solid' } },
      range: [0, wrappedText.length],
      size: fontSize,
      font: { path: fontPath, id: '' },
    }],
    text: wrappedText,
  });

  return {
    add_type: 0,
    alignment: 1,
    background_alpha: 1.0,
    background_color: '',
    background_fill: '',
    background_height: 0.14,
    background_horizontal_offset: 0.0,
    background_round_radius: 0.0,
    background_style: 0,
    background_vertical_offset: 0.0,
    background_width: 0.14,
    base_content: '',
    bold_width: 0.0,
    border_alpha: 1.0,
    border_color: '',
    border_width: 0.08,
    check_flag: 7,
    content: richContent,
    cutoff_postfix: '',
    enable_path_typesetting: false,
    fixed_height: -1.0,
    fixed_width: -1.0,
    font_category_id: '',
    font_category_name: '',
    font_id: '',
    font_name: '',
    font_path: fontPath,
    font_resource_id: '',
    font_size: fontSize,
    font_source_platform: 0,
    font_team_id: '',
    font_third_resource_id: '',
    font_title: 'none',
    font_url: '',
    force_apply_line_max_width: false,
    global_alpha: 1.0,
    group_id: '',
    has_shadow: false,
    id,
    initial_scale: 1.0,
    inner_padding: -1.0,
    is_batch_replace: false,
    is_lyric_effect: false,
    is_rich_text: false,
    is_words_linear: false,
    italic_degree: 0,
    ktv_color: '',
    language: '',
    layer_weight: 1,
    letter_spacing: 0.0,
    line_feed: 1,
    line_max_width: 0.7,
    line_spacing: 0.05,
    lyric_group_id: '',
    multi_language_current: 'none',
    name: '',
    offset_on_path: 0.0,
    oneline_cutoff: false,
    operation_type: 0,
    preset_category: '',
    preset_category_id: '',
    preset_has_set_alignment: false,
    preset_id: '',
    preset_index: 0,
    preset_name: '',
    punc_model: '',
    recognize_model: '',
    recognize_task_id: '',
    recognize_text: '',
    recognize_type: 0,
    shadow_alpha: 0.9,
    shadow_angle: -45.0,
    shadow_color: '',
    shadow_distance: 5.0,
    shadow_smoothing: 0.45,
    shape_clip_x: false,
    shape_clip_y: false,
    source_from: '',
    ssml_content: '',
    style_name: '',
    sub_template_id: -1,
    sub_type: 0,
    subtitle_keywords: null,
    subtitle_keywords_config: null,
    subtitle_template_original_fontsize: 0.0,
    text_alpha: 1.0,
    text_color: fontColor,
    text_curve: null,
    text_exceeds_path_process_type: 0,
    text_loop_on_path: false,
    text_preset_resource_id: '',
    text_size: Math.round(fontSize * 6),
    text_typesetting_path_index: 0,
    text_typesetting_paths: null,
    text_typesetting_paths_file: '',
    translate_original_text: '',
    tts_auto_update: false,
    type: 'text',
    typesetting: 0,
    underline: false,
    underline_offset: 0.22,
    underline_width: 0.05,
    use_effect_default_color: true,
  };
}

/**
 * 세그먼트별 보조 materials 생성 (speed, canvas, animation 등)
 */
function createSupportMaterials() {
  const speedId = uuid();
  const canvasId = uuid();
  const animationId = uuid();
  const soundChannelId = uuid();
  const placeholderId = uuid();
  const colorId = uuid();
  const vocalSepId = uuid();

  return {
    speed: { curve_speed: null, id: speedId, mode: 0, speed: 1.0, type: 'speed' },
    canvas: { album_image: '', blur: 0.0, color: '', id: canvasId, image: '', image_id: '', image_name: '', source_platform: 0, team_id: '', type: 'canvas_color' },
    animation: { animations: [], id: animationId, multi_language_current: 'none', type: 'sticker_animation' },
    soundChannel: { audio_channel_mapping: 0, id: soundChannelId, is_config_open: false, type: '' },
    placeholder: { error_path: '', error_text: '', id: placeholderId, meta_type: 'none', res_path: '', res_text: '', type: 'placeholder_info' },
    color: { gradient_angle: 90.0, gradient_colors: [], gradient_percents: [], height: 0.0, id: colorId, is_color_clip: false, is_gradient: false, solid_color: '', width: 0.0 },
    vocalSep: { choice: 0, enter_from: '', final_algorithm: '', id: vocalSepId, production_path: '', removed_sounds: [], time_range: null, type: 'vocal_separation' },
    refs: [speedId, placeholderId, canvasId, animationId, soundChannelId, colorId, vocalSepId],
  };
}

/**
 * 트랙 세그먼트 생성
 */
function createSegment(materialId, startUs, durationUs, extraRefs, renderIndex, volume = 1.0, transformY = 0.0) {
  return {
    caption_info: null,
    cartoon: false,
    clip: { alpha: 1.0, flip: { horizontal: false, vertical: false }, rotation: 0.0, scale: { x: 1.0, y: 1.0 }, transform: { x: 0.0, y: transformY } },
    color_correct_alg_result: '',
    common_keyframes: [],
    desc: '',
    digital_human_template_group_id: '',
    enable_adjust: true,
    enable_adjust_mask: false,
    enable_color_correct_adjust: false,
    enable_color_curves: true,
    enable_color_match_adjust: false,
    enable_color_wheels: true,
    enable_hsl: false,
    enable_hsl_curves: true,
    enable_lut: true,
    enable_smart_color_adjust: false,
    enable_video_mask: true,
    extra_material_refs: extraRefs,
    group_id: '',
    hdr_settings: { intensity: 1.0, mode: 1, nits: 1000 },
    id: uuid(),
    intensifies_audio: false,
    is_loop: false,
    is_placeholder: false,
    is_tone_modify: false,
    keyframe_refs: [],
    last_nonzero_volume: volume,
    lyric_keyframes: null,
    material_id: materialId,
    raw_segment_id: '',
    render_index: renderIndex,
    render_timerange: { duration: 0, start: 0 },
    responsive_layout: { enable: false, horizontal_pos_layout: 0, size_layout: 0, target_follow: '', vertical_pos_layout: 0 },
    reverse: false,
    source: 'segmentsourcenormal',
    source_timerange: { duration: durationUs, start: 0 },
    speed: 1.0,
    state: 0,
    target_timerange: { duration: durationUs, start: startUs },
    template_id: '',
    template_scene: 'default',
    track_attribute: 0,
    track_render_index: renderIndex,
    uniform_scale: { on: true, value: 1.0 },
    visible: true,
    volume,
  };
}

/**
 * 메인: draft_info.json + 프로젝트 디렉터리 생성
 */
export function buildCapCutProject(options) {
  const {
    projectName,
    scenes,         // [{ imagePath, ttsPath, narration, durationUs, imageWidth?, imageHeight? }]
    bgmPath,
    subtitleStyle,  // { fontFamily, fontSize, fontColor }
    totalDurationUs,
    outputDir,      // null이면 CapCut 기본 경로에 생성
    canvas = 'landscape',  // 'landscape' (1920x1080) | 'vertical' (1080x1920)
  } = options;

  const canvasPreset = CANVAS_PRESETS[canvas];
  if (!canvasPreset) {
    throw new Error(`Unknown canvas preset: ${canvas}. Use 'landscape' or 'vertical'.`);
  }

  const projectDir = outputDir || join(CAPCUT_PROJECTS_DIR, projectName);
  mkdirSync(join(projectDir, 'Resources'), { recursive: true });
  mkdirSync(join(projectDir, 'adjust_mask'), { recursive: true });
  mkdirSync(join(projectDir, 'matting'), { recursive: true });
  mkdirSync(join(projectDir, 'smart_crop'), { recursive: true });
  mkdirSync(join(projectDir, 'subdraft'), { recursive: true });
  mkdirSync(join(projectDir, 'qr_upload'), { recursive: true });
  mkdirSync(join(projectDir, 'common_attachment'), { recursive: true });

  const draftId = uuid();

  // Materials 수집
  const videoMaterials = [];
  const audioMaterials = [];
  const textMaterials = [];
  const speeds = [];
  const canvases = [];
  const animations = [];
  const soundChannels = [];
  const placeholders = [];
  const colors = [];
  const vocalSeps = [];

  // 트랙 세그먼트 수집
  const videoSegments = [];
  const audioSegments = []; // TTS
  const bgmSegments = [];
  const textSegments = [];

  let currentTimeUs = 0;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const durationUs = scene.durationUs;

    // 이미지 material (scene별 해상도 또는 canvas 해상도 기본값)
    const imgMatId = uuid();
    const imgW = scene.imageWidth || canvasPreset.width;
    const imgH = scene.imageHeight || canvasPreset.height;
    videoMaterials.push(
      createVideoMaterial(imgMatId, scene.imagePath, 'photo', imgW, imgH, durationUs)
    );

    // TTS material
    const ttsMatId = uuid();
    audioMaterials.push(
      createAudioMaterial(ttsMatId, scene.ttsPath, `scene_${String(i + 1).padStart(3, '0')}.wav`, durationUs)
    );

    // 자막 material
    const textMatId = uuid();
    textMaterials.push(
      createTextMaterial(textMatId, scene.narration, subtitleStyle.fontFamily, subtitleStyle.fontSize, subtitleStyle.fontColor)
    );

    // 보조 materials (세그먼트당)
    const support = createSupportMaterials();
    speeds.push(support.speed);
    canvases.push(support.canvas);
    animations.push(support.animation);
    soundChannels.push(support.soundChannel);
    placeholders.push(support.placeholder);
    colors.push(support.color);
    vocalSeps.push(support.vocalSep);

    // 세그먼트 생성
    videoSegments.push(createSegment(imgMatId, currentTimeUs, durationUs, support.refs, i));
    audioSegments.push(createSegment(ttsMatId, currentTimeUs, durationUs, [], i, 1.0));
    // transform.y = -0.4 (중앙 하단, Shorts profile 영역과 안 겹침)
    // -1=바닥, -0.8=프로필 겹침, -0.4=안전 영역, 0=중앙
    textSegments.push(createSegment(textMatId, currentTimeUs, durationUs, [], i, 1.0, -0.4));

    currentTimeUs += durationUs;
  }

  // BGM track
  if (bgmPath && existsSync(bgmPath)) {
    const bgmMatId = uuid();
    audioMaterials.push(
      createAudioMaterial(bgmMatId, bgmPath, 'bgm.wav', totalDurationUs)
    );
    bgmSegments.push(createSegment(bgmMatId, 0, totalDurationUs, [], 0, 0.15));
  }

  // draft_info.json 조립
  const draft = {
    canvas_config: { background: null, height: canvasPreset.height, ratio: canvasPreset.ratio, width: canvasPreset.width },
    color_space: -1,
    config: {
      adjust_max_index: 1, attachment_info: [], combination_max_index: 1,
      export_range: null, extract_audio_last_index: 1,
      lyrics_recognition_id: '', lyrics_sync: true, lyrics_taskinfo: [],
      maintrack_adsorb: true, material_save_mode: 0,
      multi_language_current: 'none', multi_language_list: [],
      multi_language_main: 'none', multi_language_mode: 'none',
      original_sound_last_index: 1, record_audio_last_index: 1,
      sticker_max_index: 1, subtitle_keywords_config: null,
      subtitle_recognition_id: '', subtitle_sync: true, subtitle_taskinfo: [],
      system_font_list: [], use_float_render: false, video_mute: false,
      zoom_info_params: null,
    },
    cover: null,
    create_time: 0,
    draft_type: 'video',
    duration: totalDurationUs,
    extra_info: null,
    fps: 30.0,
    free_render_index_mode_on: false,
    function_assistant_info: {
      audio_noise_segid_list: [], auto_adjust: false, auto_adjust_fixed: false,
      auto_adjust_fixed_value: 50.0, auto_adjust_segid_list: [],
      auto_caption: false, auto_caption_segid_list: [],
      auto_caption_template_id: '', caption_opt: false, caption_opt_segid_list: [],
      color_correction: false, color_correction_fixed: false,
      color_correction_fixed_value: 50.0, color_correction_segid_list: [],
      deflicker_segid_list: [], enhance_quality: false, enhance_quality_fixed: false,
      enhance_quality_segid_list: [], enhance_voice_segid_list: [],
      enhande_voice: false, enhande_voice_fixed: false,
      eye_correction: false, eye_correction_segid_list: [],
      fixed_rec_applied: false, fps: { den: 1, num: 0 },
      normalize_loudness: false, normalize_loudness_audio_denoise_segid_list: [],
      normalize_loudness_fixed: false, normalize_loudness_segid_list: [],
      retouch: false, retouch_fixed: false, retouch_segid_list: [],
      smart_rec_applied: false, smart_segid_list: [],
      smooth_slow_motion: false, smooth_slow_motion_fixed: false,
      video_noise_segid_list: [],
    },
    group_container: null,
    id: draftId,
    is_drop_frame_timecode: false,
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: {
      app_id: 359289, app_source: 'cc', app_version: '7.6.0',
      device_id: '', hard_disk_id: '', mac_address: '',
      os: 'mac', os_version: '',
    },
    lyrics_effects: [],
    materials: {
      ai_translates: [], audio_balances: [], audio_effects: [],
      audio_fades: [], audio_pannings: [], audio_pitch_shifts: [],
      audio_track_indexes: [],
      audios: audioMaterials,
      beats: [],
      canvases,
      chromas: [], color_curves: [], common_mask: [],
      digital_human_model_dressing: [], digital_humans: [],
      drafts: [], effects: [], flowers: [], green_screens: [],
      handwrites: [], hsl: [], hsl_curves: [], images: [],
      log_color_wheels: [], loudnesses: [],
      manual_beautys: [], manual_deformations: [],
      material_animations: animations,
      material_colors: colors,
      multi_language_refs: [],
      placeholder_infos: placeholders,
      placeholders: [], plugin_effects: [], primary_color_wheels: [],
      realtime_denoises: [], shapes: [], smart_crops: [], smart_relights: [],
      sound_channel_mappings: soundChannels,
      speeds,
      stickers: [], tail_leaders: [], text_templates: [],
      texts: textMaterials,
      time_marks: [], transitions: [],
      video_effects: [], video_radius: [], video_shadows: [],
      video_strokes: [], video_trackings: [],
      videos: videoMaterials,
      vocal_beautifys: [],
      vocal_separations: vocalSeps,
    },
    mutable_config: null,
    name: '',
    new_version: '149.0.0',
    path: '',
    platform: {
      app_id: 359289, app_source: 'cc', app_version: '7.6.0',
      device_id: '', hard_disk_id: '', mac_address: '',
      os: 'mac', os_version: '',
    },
    relationships: [],
    render_index_track_mode_on: true,
    retouch_cover: null,
    smart_ads_info: { draft_url: '', page_from: '', routine: '' },
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks: [
      { attribute: 0, flag: 0, id: uuid(), is_default_name: true, name: '', segments: videoSegments, type: 'video' },
      { attribute: 0, flag: 0, id: uuid(), is_default_name: true, name: '', segments: audioSegments, type: 'audio' },
      ...(bgmSegments.length > 0
        ? [{ attribute: 0, flag: 0, id: uuid(), is_default_name: true, name: '', segments: bgmSegments, type: 'audio' }]
        : []),
      { attribute: 0, flag: 0, id: uuid(), is_default_name: true, name: '', segments: textSegments, type: 'text' },
    ],
    uneven_animation_template_info: { composition: '', content: '', order: '', sub_template_info_list: [] },
    update_time: 0,
    version: 360000,
  };

  // draft_meta_info.json
  const now = Date.now() * 1000; // microseconds
  const metaInfo = {
    cloud_draft_cover: false,
    cloud_draft_sync: false,
    cloud_package_completed_time: '',
    draft_cloud_capcut_purchase_info: '',
    draft_cloud_last_action_download: false,
    draft_cloud_package_type: '',
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: '',
    draft_deeplink_url: '',
    draft_enterprise_info: { draft_enterprise_extra: '', draft_enterprise_id: '', draft_enterprise_name: '', enterprise_material: [] },
    draft_fold_path: projectDir,
    draft_id: draftId,
    draft_is_ae_produce: false,
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_cloud_temp_draft: false,
    draft_is_from_deeplink: 'false',
    draft_is_invisible: false,
    draft_is_web_article_video: false,
    draft_materials_copied_info: [],
    draft_name: projectName,
    draft_need_rename_folder: false,
    draft_new_version: '',
    draft_removable_storage_device: '',
    draft_root_path: CAPCUT_PROJECTS_DIR,
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: 0,
    draft_type: '',
    tm_draft_cloud_completed: '',
    tm_draft_cloud_entry_id: -1,
    tm_draft_cloud_modified: 0,
    tm_draft_cloud_parent_entry_id: -1,
    tm_draft_cloud_space_id: -1,
    tm_draft_cloud_user_id: -1,
    tm_draft_create: now,
    tm_draft_modified: now,
    tm_draft_removed: 0,
    tm_duration: totalDurationUs,
  };

  // 보조 파일
  const agencyConfig = {
    is_auto_agency_enabled: false,
    is_auto_agency_popup: false,
    is_single_agency_mode: false,
    marterials: null,
    use_converter: false,
    video_resolution: 1080,
  };

  // 파일 저장
  writeFileSync(join(projectDir, 'draft_info.json'), JSON.stringify(draft), 'utf-8');
  writeFileSync(join(projectDir, 'draft_info.json.bak'), JSON.stringify(draft), 'utf-8');
  writeFileSync(join(projectDir, 'draft_meta_info.json'), JSON.stringify(metaInfo), 'utf-8');
  writeFileSync(join(projectDir, 'draft_agency_config.json'), JSON.stringify(agencyConfig), 'utf-8');
  writeFileSync(join(projectDir, 'draft_biz_config.json'), '', 'utf-8');
  writeFileSync(join(projectDir, 'draft_settings'), '', 'utf-8');
  writeFileSync(join(projectDir, 'performance_opt_info.json'), JSON.stringify({ total_duration: totalDurationUs }), 'utf-8');

  return {
    projectDir,
    draftId,
    scenesCount: scenes.length,
    tracksCount: draft.tracks.length,
    totalDurationUs,
    totalDurationSec: (totalDurationUs / 1_000_000).toFixed(1),
  };
}
