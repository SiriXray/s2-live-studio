'use strict';
/**
 * 音色目录：豆包 / MiniMax / Soul / 讯飞。
 * 只描述音色与凭据就绪状态，不包含任何密钥；试听走 /api/voice/catalog/preview。
 */
const PROVIDERS = [
  {
    id: 'doubao',
    name: '豆包',
    vendor: '火山引擎',
    color: '#5b8cff',
    hint: '需要 App ID + Access Token + cluster=volcano_tts；BV 系走 HTTP v1。',
    ready: config => Boolean(config.doubao?.app_id && config.doubao?.access_token),
    voices: [
      { id: 'BV700_streaming', name: '灿灿', gender: 'female', tags: ['通用', '22 情感'] },
      { id: 'BV009_streaming', name: '知性女声', gender: 'female', tags: ['知性', '讲解'] },
      { id: 'BV056_streaming', name: '阳光男声', gender: 'male', tags: ['阳光', '通用'] },
      { id: 'BV004_streaming', name: '开朗青年', gender: 'male', tags: ['青年', '活力'] },
      { id: 'BV102_streaming', name: '儒雅青年', gender: 'male', tags: ['儒雅', '叙事'] },
      { id: 'BV411_streaming', name: '影视解说小帅', gender: 'male', tags: ['解说', '抖音'] },
      { id: 'BV412_streaming', name: '影视解说小美', gender: 'female', tags: ['解说', '女声'] },
      { id: 'BV410_streaming', name: '活力解说男', gender: 'male', tags: ['解说', '活力'] },
      { id: 'BV142_streaming', name: '沉稳解说男', gender: 'male', tags: ['沉稳', '低音'] },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    color: '#ff8a5c',
    hint: '使用现有 MiniMax Key；系统音色与克隆 voice_id 都可直接试听。',
    ready: config => Boolean(config.minimax?.api_key),
    voices: [
      { id: 'female-shaonv', name: '少女', gender: 'female', tags: ['系统', '甜'] },
      { id: 'female-yujie', name: '御姐', gender: 'female', tags: ['系统', '成熟'] },
      { id: 'female-chengshu', name: '成熟女声', gender: 'female', tags: ['系统', '知性'] },
      { id: 'female-tianmei', name: '甜美', gender: 'female', tags: ['系统', '元气'] },
      { id: 'male-qn-qingse', name: '青涩青年', gender: 'male', tags: ['系统', '青年'] },
      { id: 'male-qn-jingying', name: '精英青年', gender: 'male', tags: ['系统', '商务'] },
      { id: 'male-qn-badao', name: '霸道青年', gender: 'male', tags: ['系统', '低音'] },
      { id: 'presenter_male', name: '男性主持人', gender: 'male', tags: ['主持', '稳'] },
      { id: 'presenter_female', name: '女性主持人', gender: 'female', tags: ['主持', '清亮'] },
      { id: 'audiobook_male_1', name: '有声书男声', gender: 'male', tags: ['有声书', '叙事'] },
    ],
  },
  {
    id: 'soul',
    name: 'Soul',
    vendor: 'Loxinity',
    color: '#a78bfa',
    hint: '使用现有 Soul Key；完整 LOXI_ 音色 ID 可直接试听。',
    ready: config => Boolean(config.soul?.api_key),
    voices: [
      { id: 'LOXI_F_Y_ZH_Lively-Natural_Dialog_3abe', name: '活泼小榆', gender: 'female', tags: ['对话', '自然'] },
      { id: 'LOXI_F_Y_ZH_Tender-Natural_Dialog_d6c6', name: '温柔书瑶', gender: 'female', tags: ['对话', '温柔'] },
      { id: 'LOXI_M_A_ZH_Velvety-Mature_Dialog_a7c0', name: '磁性砚川', gender: 'male', tags: ['对话', '磁性'] },
      { id: 'LOXI_F_Y_ZH_Tender-Natural_Podcast_9dfb', name: '知性书禾', gender: 'female', tags: ['播客', '知性'] },
      { id: 'LOXI_F_Y_ZH_Lively-Natural_Podcast_1459', name: '知性小夏', gender: 'female', tags: ['播客', '明快'] },
      { id: 'LOXI_F_Y_ZH_Lively-Natural_Dialog_7ea6', name: '开朗映岚', gender: 'female', tags: ['对话', '热情'] },
    ],
  },
  {
    id: 'iflytek',
    name: '科大讯飞',
    vendor: 'iFlytek',
    color: '#46c7b8',
    hint: '需要 APPID + APIKey + APISecret；WebSocket v2 实时合成，返回 16k WAV。',
    ready: config => Boolean(config.iflytek?.app_id && config.iflytek?.api_key && config.iflytek?.api_secret),
    voices: [
      { id: 'xiaoyan', name: '小燕', gender: 'female', tags: ['普通话', '标准'] },
      { id: 'aisjiuxu', name: '许久', gender: 'male', tags: ['普通话', '沉稳'] },
      { id: 'aisxping', name: '小萍', gender: 'female', tags: ['普通话', '亲和'] },
      { id: 'aisjinger', name: '小婧', gender: 'female', tags: ['普通话', '清亮'] },
      { id: 'aisbabyxu', name: '许小宝', gender: 'male', tags: ['普通话', '少年'] },
    ],
  },
];

function catalog(config = {}) {
  return PROVIDERS.map(provider => ({
    id: provider.id,
    name: provider.name,
    vendor: provider.vendor,
    color: provider.color,
    hint: provider.hint,
    ready: Boolean(provider.ready(config)),
    voices: provider.voices,
  }));
}

function findVoice(providerId, voiceId) {
  const provider = PROVIDERS.find(item => item.id === providerId);
  return provider?.voices.find(voice => voice.id === voiceId) || null;
}

module.exports = { PROVIDERS, catalog, findVoice };
