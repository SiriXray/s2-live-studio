'use strict';
/**
 * 音色档案：一个档案同时描述 Soul（克隆音色）与 MiniMax（官方音色）两侧的 voice_id。
 * 切换人设时两侧一起切，保证 Soul 合成失败回落 MiniMax 后仍是同性别、同风格的音色。
 *
 * 说明：Soul 账号的克隆槽位上限为 3。2026-11-05 起两条男声克隆退役腾槽位
 * （API 无删除接口，需在 Loxinity 控制台手动删除），当前仅保留女声克隆一条。
 * 对外只暴露中性别名，克隆音源对应的风格参考记录在注释里，不作为对外音色名称使用。
 */

const VOICES = [
  {
    id: 'male_low_a',
    name: '男声 A · 低音叙事',
    gender: 'male',
    soul: '', // 李现克隆 s2_lixian_v034_11 已于 2026-11-05 退役腾槽位（API 无删除接口，需在 Loxinity 控制台删除）；此档案走 MiniMax 回落
    minimax: 's2v2_male_low_a', // MiniMax 克隆（源：V034 李现候选 15s，与 Soul 克隆同源）
    hint: '语速稳、句子长，适合长段讲解与冷场救场',
  },
  {
    id: 'male_low_b',
    name: '男声 B · 低音快节奏',
    gender: 'male',
    soul: '', // 李现克隆 s2_lixian_v034_12 同步退役；此档案走 MiniMax 回落
    minimax: 's2v2_male_low_a', // MiniMax 克隆（与男声A同源；B 档语速由人设与 speed 决定）
    hint: '语速快、情绪高，适合带货与 PK 拉票',
  },
  {
    id: 'female_clear_a',
    name: '女声 A · 清透知性',
    gender: 'female',
    soul: 's2_liuyifei_v030_11', // 克隆音源 V030 · 1.1 倍速（清透女声风格参考）
    minimax: 's2v2_female_clear_a', // MiniMax 克隆（同源 V030，回落时音色一致）
    hint: '语气从容、偏知性，适合讲解与高冷人设',
  },
  {
    id: 'female_sweet_b',
    name: '女声 B · 甜美元气',
    gender: 'female',
    soul: 's2_liuyifei_v030_11',
    minimax: 's2v2_female_sweet_b', // MiniMax 克隆（源：V007 少女风女声，明亮贴甜美）
    hint: '音色更亮，适合甜美元气人设',
  },
  {
    id: 'female_gentle_c',
    name: '女声 C · 随和小禾（官方预置）',
    gender: 'female',
    soul: 'xiaohe', // ⚠️ 官网展示短名，TTS API 实测 2013 不认——API 只接受完整 LOXI_{F|M}_{档}_{ZH}_{风格}_hash 格式（如砚川 a7c0）。拿到小禾完整 ID 后替换，当前选择此档案会回落 MiniMax
    minimax: 'female-chengshu',
    hint: '随和温润、家常聊天感，适合陪伴感与日常互动',
  },
  {
    id: 'female_lively_d',
    name: '女声 D · 活泼小榆（官方预置）',
    gender: 'female',
    soul: 'LOXI_F_Y_ZH_Lively-Natural_Dialog_3abe', // 用户提供的完整预置 ID
    minimax: 'female-tianmei',
    hint: '明快有活力、生活烟火气，适合生活分享与轻松唠嗑',
  },
  {
    id: 'female_tender_e',
    name: '女声 E · 温柔书瑶（官方预置）',
    gender: 'female',
    soul: 'LOXI_F_Y_ZH_Tender-Natural_Dialog_d6c6',
    minimax: 's2v2_female_tender_e', // MiniMax 克隆（源：V018 柔和沉稳叙述女声）
    hint: '柔和体贴、深夜电台感，适合陪伴倾诉与慢节奏直播',
  },
  {
    id: 'male_velvety_f',
    name: '男声 C · 磁性砚川（官方预置）',
    gender: 'male',
    soul: 'LOXI_M_A_ZH_Velvety-Mature_Dialog_a7c0',
    minimax: 's2v2_male_velvety_f', // MiniMax 克隆（源：V012 中低音温厚磁性青年）
    hint: '低磁性沉稳、音乐电台感，适合深夜音乐与叙事场景',
  },
  {
    id: 'female_scholar_g',
    name: '女声 G · 知性书禾（官方预置）',
    gender: 'female',
    soul: 'LOXI_F_Y_ZH_Tender-Natural_Podcast_9dfb', // 2026-11-05 用户提供的完整预置 ID，实测 8.8s
    minimax: 'female-chengshu',
    hint: '知性电台感、条理清晰，适合知识分享与书评荐读',
  },
  {
    id: 'female_bright_h',
    name: '女声 H · 知性小夏（官方预置）',
    gender: 'female',
    soul: 'LOXI_F_Y_ZH_Lively-Natural_Podcast_1459', // 实测 6.6s
    minimax: 'female-tianmei',
    hint: '明快中带知性、播客叙事感，适合观点输出与轻松访谈',
  },
  {
    id: 'female_cheery_i',
    name: '女声 I · 开朗映岚（官方预置）',
    gender: 'female',
    soul: 'LOXI_F_Y_ZH_Lively-Natural_Dialog_7ea6', // 实测 9.6s
    minimax: 'female-tianmei',
    hint: '开朗热情、互动感强，适合暖场唠嗑与活跃气氛',
  },
];

function listVoices() {
  return VOICES.map(({ id, name, gender, hint, soul, minimax }) => ({ id, name, gender, hint, soul, minimax }));
}

function getVoice(id) {
  return VOICES.find(voice => voice.id === id) || null;
}

/** 人设 → 音色档案：按性别取人设对应的音色（每个人设都配有女声/男声两条），缺失时按性别取默认 */
function voiceForPersona(persona, gender) {
  if (!persona) return null;
  const wanted = gender || persona.gender;
  const direct = getVoice(persona.voices?.[wanted]) || getVoice(persona.voice);
  if (direct && (!gender || direct.gender === wanted)) return direct;
  return VOICES.find(voice => voice.gender === (wanted || persona.gender)) || VOICES[0];
}

/** 当前配置对应哪个音色档案（Soul 优先匹配，其次 MiniMax） */
function activeVoiceFrom(config) {
  const soul = config?.soul?.voice_id;
  const minimax = config?.minimax?.voice_id;
  return (
    VOICES.find(voice => voice.soul === soul && voice.minimax === minimax) ||
    VOICES.find(voice => voice.soul === soul) ||
    VOICES.find(voice => voice.minimax === minimax) ||
    null
  );
}

/** 生成写入配置的补丁：Soul 与 MiniMax 两侧音色同时切换 */
function patchForVoice(voice) {
  if (!voice) return {};
  return { soul: { voice_id: voice.soul }, minimax: { voice_id: voice.minimax } };
}

module.exports = { VOICES, listVoices, getVoice, voiceForPersona, activeVoiceFrom, patchForVoice };
