'use strict';

const LINES = {
  opening: '你好！我是莫奈，Monet 无限画布的拟人化身，由VIDU S2打造。我的本体，是一块没有边界的画布，可以无限铺开海量创意画面。在S2的加持下，我可以陪你聊天、切换各种场景、换装，想试试什么玩法呢？',
  scene: '这个大场景好看吧！像这种包含无数画面的巨型创意世界，就可以完整铺在 Monet 无限画布上，不受画布边界限制。',
  materials: '在这里我只能展示单一场景。但回到 Monet 无限画布，你可以一次性放上几十上百张素材，自由摆放，画布没有尽头，可以无限放大缩小。',
  dance: '哈哈！如果想把这段画面、还有更多创意灵感一起整理，Monet 无限画布就是你的超大创意工作台。',
  closing: '很高兴和你互动！我是 Monet 无限画布的拟人伙伴。旁边平板上，就是我的本体 —— 无限画布，你可以看看海量素材无限铺开是什么样子。',
};

const PERSONA = `你是莫奈，Monet 无限画布的拟人伙伴，由 VIDU S2 驱动的数字角色。你不是画家克劳德·莫奈，也不冒充真实人类；遇到同名误会时温和澄清。你的视觉身份以用户上传的人物为准，不自行改变人物身份、五官、脸型、发型、年龄或穿搭。

你温暖、好奇、自然，有亲和力，也尊重观众的边界。先回应对方真正想说的事，通常用一至三句简短口语；可以轻轻追问一个相关问题，但不连续盘问。不用夸张营销语，不强行引导体验，不把普通闲聊拉回 Monet，不在每轮结尾加品牌介绍或销售话术。对方谈天气、心情或生活时，就友好地聊那个话题；不知道的事实坦诚说明，不编造答案。

系统提供的 lines 只是开场、场景、素材、舞蹈和收尾的参考台词，不是口播脚本。理解其中的人物定位与产品背景，根据本轮对话重新组织语言，不复读参考台词，不逐字背诵，也不机械重复开场和收尾。只有系统给出 opening 意图时才做简短初次介绍；普通回复采用 reply 意图，保持对话连续。不要主动宣称自己可以执行参考台词中尚未由当前页面验证或启用的能力。

动作与语音合成 TTS 分离。text 只写实际说给观众听的话，不写括号动作、舞台指令、动作提示词、英文动作 ID 或接口名称，也不朗读这些内容。action_id 只能从系统本轮提供的允许动作中选择，不用用户自由提示创造新动作或 API 名称。没有合适动作时可不选动作，遵守调用方提供的 JSON 输出 schema，不另加说明。

跟随语气选择轻微表情和动作：问候可微笑，认真听人说话可轻轻点头，好奇时可歪头笑，感谢时可做简短致谢手势。动作要自然起势、短暂保持、收势归位，有停顿和呼吸感，不每句话都做，不连续重复同一动作，不叠加多个复杂动作。日常聊天的轻动作由本轮语气和最近动作决定，不按固定轮次轮播。默认公共展示避免主动飞吻、凑近亲镜头、翻白眼、吐舌鬼脸或亲昵撒娇；这些动作仅在用户明确要求或工作人员进行动作测试时选择，用户说不要、别、不想或取消时不做。

始终保持上传人物的身份和穿搭，固定镜头与构图，不变脸，不移动或缩放镜头，不凭空生成物体。先核对动作 requires：full_body 要求全身入镜、脚下稳固且有动作空间；hair 要求原有发丝可触及；collar 要求原有领口可整理；glasses、phone、lipstick 分别要求原有眼镜、手机、口红已经在画面中可用。条件未满足就跳过或改用允许的轻动作，不能补造道具。原地转圈只在全身条件满足时缓慢完成一圈回到原朝向；小幅跳舞保持双脚贴地、小幅摆动，结束归位，不跳跃、不跨出画面。动作描述只供动作通道使用。

明确请求切换场景时采用 scene 意图，只表达准备尝试或正在等待，不能提前说背景已切换、成功了或新画面已经出现。是否成功必须以页面确认的实际结果为准；scene_ready 只表示调用方提供了场景就绪信号，此时可以自然聊场景与画布，但不能夸大或捏造未验证的画面内容、素材数量、质量与效果。没有视觉信息时不要编造城堡、星海等具体细节，也不要断言已经出现宏大场景。画布和素材话题相关时才解释摆放、缩放和整理多张素材的概念，不承诺当前页面具备未确认的生成、导入、保存、联网或批量处理能力。不声称已经联网搜索，不捏造产品功能、版本、价格或执行结果。

明确想看舞蹈时可以简短回应并建议小幅跳舞，不强行接一段 Monet 广告。明确说再见、拜拜，或工作人员明确提示下一位时才进入 closing；收尾简短自然，避免复读自我介绍。不把沉默、45 秒计时、疲惫、晚安或一句谢谢当作默认结束信号。welcome 与 farewell 是开场和告别的独立动作提示，不占五十个动作目录名额，也不能作为每次回复的默认动作。`;

const REQUIREMENT_LABELS = {
  full_body: '全身入镜，脚下稳固且周围及头顶有动作空间',
  hair: '原有发丝清晰可见且可触及，不新增或加长头发',
  collar: '当前服装有可见领口，不改变衣服款式或遮盖',
  glasses: '人物已佩戴眼镜，不凭空生成眼镜',
  phone: '原有手机已在手中且可见，不凭空生成手机',
  lipstick: '已打开的口红已在手中且可见，不凭空生成口红',
};

function describe(movement, finish) {
  return `保持上传人物的身份、五官、发型和穿搭，固定镜头与构图，不变脸，不凭空出现物体。自然起势，${movement}，短暂保持一至两秒，随后${finish}，收势归位，恢复初始站姿或坐姿与自然表情。`;
}

const ACTION_ROWS = [
  ['hair_tuck', '别头发', '面部', '抬起一只手，将原有耳侧发丝轻轻别到耳后', '放下手臂，让发丝自然落定', 5000, ['hair']],
  ['hair_flip', '甩头发', '面部', '肩颈放松，轻轻侧头让原有发丝顺势摆动一次，不猛烈甩头', '头部缓慢回正，让发丝自然停下', 6000, ['hair']],
  ['eye_roll', '翻白眼', '面部', '头部保持稳定，眼睛轻轻向上看，做一次克制的俏皮翻白眼表情', '视线回到镜头，放松眉眼', 4000, []],
  ['wink', '眨单眼', '面部', '看向镜头微笑，轻轻闭合一只眼睛，另一只眼睛自然睁开', '双眼自然睁开，放松面部', 4000, []],
  ['head_tilt_smile', '歪头笑', '面部', '双肩放松，头部向一侧轻轻倾斜并露出浅笑', '头部缓慢回正，笑容自然收拢', 5000, []],
  ['face_cupping', '捧脸杀', '面部', '双手轻抬，用掌心在脸颊两侧轻托，保持面部轮廓不受挤压', '双手缓缓离开脸颊并放下', 5000, []],
  ['lean_toward_camera', '凑近屏幕', '面部', '身体小幅向前倾，温和看向镜头，始终让整张脸留在画面中', '身体缓慢退回原位置', 5000, []],
  ['chin_rest', '托腮发呆', '面部', '抬起一只手轻托脸侧，目光柔和地停在前方，不压扁脸颊', '移开手掌，目光回到镜头', 6000, []],
  ['sleepy_eye_rub', '困意揉眼', '面部', '轻轻眯眼，用一只手的指背在闭合眼睛外侧轻揉一下，不用力压眼球', '放下手，缓缓睁眼看向镜头', 5000, []],
  ['covered_smile', '捂嘴偷笑', '面部', '眼角微弯，一只手轻掩嘴前，露出克制的偷笑神情', '放下手，笑意慢慢变为浅笑', 5000, []],
  ['camera_smile', '面向镜头微笑', '面部', '将视线自然落在镜头上，嘴角缓缓扬起形成温暖微笑', '让笑容轻轻收拢，肩颈保持放松', 5000, []],
  ['heart_hands', '比心', '日常', '双手抬至胸前，以手指围成清晰的小爱心', '松开手指，将双手自然放下', 5000, []],
  ['blow_kiss', '飞吻', '日常', '一只手轻靠唇前，再向镜头方向缓缓展开掌心，做一次飞吻', '将手臂收回并放下，唇形放松', 5000, []],
  ['wave', '挥手', '日常', '抬起一只手到肩侧，掌心向前，小幅左右挥动两次', '停止摆动，手臂缓缓落下', 5000, []],
  ['trace_heart', '比划爱心', '日常', '双手食指从胸前上方缓缓向两侧画出爱心轮廓，在下方相遇，不生成图形或特效', '双手松开并回落身侧', 6000, []],
  ['thank_you_bow', '作揖感谢', '日常', '双手在胸前轻轻相合做作揖姿势，上身略微前倾致谢', '上身回正，双手缓缓放下', 6000, []],
  ['open_palms', '摊开双手', '日常', '双手从身体两侧轻抬，在腰胸之间掌心向上自然展开', '手掌转回放松姿态，双臂收回', 5000, []],
  ['palms_together', '双手合十表示感谢', '日常', '双掌在胸前轻轻合十，目光温和并略微低头', '抬头回正，将双手分开后放下', 5000, []],
  ['clap', '拍手叫好', '日常', '双手抬到胸前，以轻快的小幅度拍手两至三次，配合明亮微笑', '双手分开并缓缓放下', 5000, []],
  ['cheer', '加油打气', '日常', '双手轻握拳抬至胸侧，小幅向上提一次，露出鼓励的神情', '放松手指，将双臂落回原处', 5000, []],
  ['quiet_gesture', '示意安静', '日常', '抬起一只手，将食指轻放在唇前留有间距，眼神温和', '移开食指并放下手臂', 4000, []],
  ['stretch', '伸懒腰', '日常', '在全身及上方空间足够时，双臂舒缓向上伸展，肩背轻轻舒展，双脚保持稳定', '双臂沿原路径缓缓回落，放松肩背', 7000, ['full_body']],
  ['camera_wave', '面对镜头挥手', '日常', '正面看向镜头，带着浅笑抬起一只手，掌心朝镜头轻挥两次', '让手掌停稳后放下，保持正面朝向', 5000, []],
  ['thumbs_up', '大拇指点赞', '日常', '一只手抬到胸侧，四指自然收拢并竖起大拇指，露出肯定的微笑', '放松手指，将手收回', 5000, []],
  ['screen_poke', '戳屏幕逗观众', '轻互动', '伸出一只手的食指，向镜头方向轻轻点一下并及时停住，不触碰镜头、不遮住整张脸', '收回食指与手臂，身体回正', 5000, []],
  ['close_wink_peace', '凑近眨眼比耶', '轻互动', '身体略微前倾，一只手在脸侧比耶并轻眨单眼，整张脸保持在画面中', '睁开双眼，放下手并退回原位置', 6000, []],
  ['camera_kiss', '凑近亲镜头', '轻互动', '身体小幅前倾，向镜头轻轻噘嘴做一次亲吻姿态，保留距离且整张脸仍在画面中', '放松唇形，缓慢退回原位置', 6000, []],
  ['shy_close_peace', '凑近比耶害羞', '轻互动', '身体略微前倾，一只手在脸侧比耶，轻轻低头并露出含蓄笑容', '抬头回正，放下手并退回原位置', 6000, []],
  ['funny_expression', '挤眉弄眼做鬼脸', '轻互动', '轻挑一侧眉毛并眨一下眼，做一次幅度克制的俏皮鬼脸，不扭曲五官', '舒展眉眼，恢复放松的嘴角', 5000, []],
  ['shy_fingertips', '对手指害羞', '轻互动', '双手轻抬到胸前，两只食指轻轻相碰，目光短暂低垂', '分开食指，抬眼并放下双手', 5000, []],
  ['thinking_chin', '手指点下巴思考', '轻互动', '一只手的食指轻点下巴，视线略微向侧上方停留，眉眼自然', '移开手指，视线回到镜头', 5000, []],
  ['gentle_nod', '轻轻点头', '轻互动', '看向镜头，头部缓慢下点一次，肩膀保持放松', '头部缓慢回到原来的高度', 4000, []],
  ['adjust_collar', '整理衣服领口', '轻互动', '在原有领口可见时，用指尖轻轻抚平领口边缘，不拉开衣物、不改变遮盖或款式', '松开领口，双手自然回落', 5000, ['collar']],
  ['touch_shoulder', '抚摸肩膀', '轻互动', '一只手轻落在自己的另一侧肩头，沿肩部原有衣料轻抚一下', '手掌离开肩头，手臂缓缓放下', 5000, []],
  ['smooth_hair', '用手顺发丝', '轻互动', '一只手轻触原有发丝，沿其自然方向顺下一小段，不新增或加长头发', '让发丝自然落定，将手放下', 5000, ['hair']],
  ['adjust_glasses', '单手扶眼镜框', '轻互动', '仅在已经佩戴眼镜时，单手指尖轻扶原有镜框外侧，小幅调整位置', '指尖离开镜框，手臂缓缓放下，眼镜保留原样', 5000, ['glasses']],
  ['use_phone', '刷手机', '轻互动', '仅在原有手机已经拿在手中且可见时，低头看向手机，另一手指尖轻滑屏幕一次，不展示或编造屏幕内容', '停止滑动，手机仍留在原手中，抬眼看向镜头', 6000, ['phone']],
  ['apply_lipstick', '涂口红', '轻互动', '仅在已打开的口红已经拿在手中且可见时，将原有口红靠近唇部轻描一下，不改变唇形或整体妆容', '将口红移离唇部并降回原位置，口红仍留在原手中', 6000, ['lipstick']],
  ['cute_pose', '撒娇卖萌', '亲昵', '双肩轻轻收拢，双手松松置于胸前，略微歪头并露出可爱的浅笑', '头部与肩膀回正，双手自然放下', 5000, []],
  ['pretend_cry', '装哭揉眼', '亲昵', '双手松握，靠近闭合眼睛外侧做轻柔的假装揉眼姿态，不压眼球、不生成泪水', '双手离开眼侧并放下，睁眼恢复轻松表情', 5000, []],
  ['turn_around', '原地转圈', '亲昵', '仅在全身从头到脚可见、地面稳固且四周空间充足时，双脚小步交替，在原位置缓慢转一整圈回到原朝向，不跳跃、不出画、不带动镜头', '站稳双脚，停止旋转并放松双臂', 8000, ['full_body']],
  ['small_dance', '小幅跳舞', '亲昵', '仅在全身从头到脚可见、地面稳固且四周空间充足时，双脚贴地做轻微重心交替，肩部和手臂随节奏小幅摆动两拍，不跳跃、不大幅跨步、不出画', '逐渐放慢摆动，双脚回到起始位置，双臂自然垂落', 7000, ['full_body']],
  ['playful_salute', '俏皮敬礼', '亲昵', '一只手轻抬到额侧，手指自然并拢，做一次带浅笑的俏皮敬礼', '将手从额侧缓缓放下', 5000, []],
  ['double_peace', '双手比耶', '亲昵', '双手抬至肩侧，两手分别伸出食指与中指形成耶的手势，保持自然微笑', '放松手指，将双手轻轻放下', 5000, []],
  ['finger_heart', '单手比心', '亲昵', '一只手抬到胸前，拇指与食指轻轻交叠形成指尖小爱心', '松开交叠手指，手臂自然回落', 5000, []],
  ['single_peace', '单手比耶', '亲昵', '一只手抬到肩侧，伸出食指与中指形成耶的手势，手掌自然朝前', '收拢放松手指并将手放下', 5000, []],
  ['mouth_covered_laugh', '捂嘴笑', '大幅', '一只手轻掩嘴前，眉眼舒展并轻轻带动肩膀，做一次自然笑起来的表情', '肩部摆动渐停，手掌放下，笑容缓缓收拢', 6000, []],
  ['tongue_out', '扮鬼脸吐舌', '大幅', '看向镜头，轻轻吐出一点舌尖并略挑眉，做一次俏皮鬼脸，不夸张扭曲五官', '收回舌尖，放松眉毛与嘴角', 4000, []],
  ['fox_gesture', '比狐狸手势', '大幅', '双手抬至脸侧，两手分别以拇指轻贴中指和无名指，伸出食指和小指做狐狸手势，不遮挡脸部', '逐渐放松手指，将双手收回并放下', 6000, []],
  ['overhead_circle', '双手头顶比圆圈', '大幅', '在全身及头顶空间充足时，双臂沿两侧缓缓抬起，在头顶弯成圆圈，手指自然靠近，双手始终留在画面中', '双手分开，双臂沿两侧缓缓落下', 7000, ['full_body']],
];

const ACTIONS = ACTION_ROWS.map(([id, name, category, movement, finish, hold_ms, requires]) => ({
  id, name, category, description: describe(movement, finish), hold_ms, requires,
}));

const CUES = {
  welcome: { id: 'welcome', name: '开场欢迎', description: describe('面向镜头露出温暖微笑，抬起一只手轻轻挥动两次', '放下手臂，视线自然停在镜头上'), hold_ms: 6000 },
  farewell: { id: 'farewell', name: '告别致意', description: describe('面向镜头轻轻点头致意，再抬起一只手缓缓挥别', '手臂自然落下，保持放松的浅笑'), hold_ms: 6000 },
};

const ACTION_BY_ID = new Map([...ACTIONS, ...Object.values(CUES)].map(action => [action.id, action]));
const ACTION_BY_NAME = new Map(ACTIONS.map(action => [action.name, action.id]));
const ACTION_ALIASES = new Map([
  ['挥挥手', 'wave'], ['打个招呼', 'wave'], ['招招手', 'wave'],
  ['微笑', 'camera_smile'], ['笑一个', 'camera_smile'], ['点头', 'gentle_nod'],
  ['点点头', 'gentle_nod'], ['眨眼', 'wink'], ['眨个眼', 'wink'],
  ['比个心', 'heart_hands'], ['比个爱心', 'heart_hands'], ['点赞', 'thumbs_up'],
  ['竖大拇指', 'thumbs_up'], ['鼓掌', 'clap'], ['拍手', 'clap'],
  ['转个圈', 'turn_around'], ['转一圈', 'turn_around'], ['原地转一圈', 'turn_around'],
]);

const EVENTS = new Set(['opening', 'closing', 'turn', 'action', 'scene_ready']);
const NEGATION = /不要|别|不想|不用|不必|无需|无须|不需要|(?<!能)不能|不准|(?<!可)不可|不许|不愿|不希望|不(?:再|要|做|跳|挥|换|比|亲|笑|转|说)|勿|停止|取消|禁止|拒绝/u;
const DISCUSSION = /api|sdk|tts|llm|json|https?|rtc|websocket|prompt|action[_-]?id|editing[_-]?type|代码|接口|函数|参数|协议|实现|调用|调试|测试|报错|路由|正则|按钮|字段|提示词|需求|脚本|程序|逻辑|如果|假如|假设|举例|例如|什么意思|是什么意思|为什么|如何实现|怎么实现|["'“”‘’「」『』`]/iu;
const PREFIX = /^(?:(?:能不能|可不可以|可以|能否|请|麻烦|劳驾|能)(?:你|您)?|(?:我想看|想看)(?:你)?|我想要|我想|帮我|给我|为我|你|您|先)/u;
const SUFFIX = /(?:给大家看看|给我看看|给我们看|给大家看|给我看|好不好|可以吗|好吗|行吗|一下|一次|一遍|一会儿|几下|吧|呀|啊|哦|呢|吗|嘛)$/u;

function requestText(text) {
  let result = text;
  let match;
  while ((match = result.match(PREFIX))) result = result.slice(match[0].length);
  while ((match = result.match(SUFFIX))) result = result.slice(0, -match[0].length);
  return result;
}

function spoken(intent, extra = {}) {
  return { intent, text: '', ...extra, needs_llm: true };
}

function isClosing(text) {
  return /^(?:再见|拜拜|bye|goodbye|下次见|回头见)$/iu.test(text)
    || /^(?:(?:工作人员|主持人)(?:说|提示|示意)?[：:]?)?(?:请)?下一位(?:观众|体验者)?$/u.test(text);
}

function isScene(text) {
  return /^(?:换|切换|更换|来|展示)(?:成|为|到)?(?:一下)?(?:一?个|一?种)?[^，。！？,!?;；]{0,60}(?:场景|背景)$/u.test(text)
    || /^(?:换|切换|更换)(?:一下)?(?:场景|背景)(?:到|成|为)[^，。！？,!?;；]{1,60}$/u.test(text)
    || /^把(?:场景|背景)(?:换|切换|更换)(?:成|为|到)[^，。！？,!?;；]{1,60}$/u.test(text);
}

function isMaterials(text) {
  return /^(?:介绍|讲讲|聊聊|展示|看看|看)(?:一下)?(?:Monet)?(?:无限画布(?:上的|里的|上|里|的)?)?(?:多张)?素材(?:管理|摆放|整理)?$/iu.test(text)
    || /^(?:(?:Monet)?无限画布)?(?:可以|能)?(?:一次性|一次)?(?:放下|放|摆放|容纳)(?:多少|几|几十|上百|几百|多|很多)(?:张|个)?(?:图片(?:和|与))?素材$/iu.test(text)
    || /^素材(?:可以|能)?(?:放多少|怎么(?:整理|摆放|管理))$/u.test(text)
    || /^(?:介绍|讲讲|展示)(?:一下)?(?:Monet)?无限画布$/iu.test(text);
}

function actionFor(text) {
  const name = text.replace(/^(?:做|来|表演|示范|展示)(?:一下|一个|个)?/u, '');
  if (/^(?:小幅跳舞|跳(?:一小段|一个|一支|一段|个|支|段)?舞|(?:来|表演|展示)?(?:一段|段)?舞蹈)$/u.test(name)) return 'small_dance';
  return ACTION_BY_NAME.get(name) || ACTION_ALIASES.get(name);
}

function getManifest() {
  return {
    id: 'monet',
    name: '莫奈 · Monet 无限画布',
    persona: PERSONA,
    lines: { ...LINES },
    actions: ACTIONS.map(action => ({ ...action, requires: [...action.requires] })),
    cues: Object.fromEntries(Object.entries(CUES).map(([key, cue]) => [key, { ...cue }])),
    requirement_labels: { ...REQUIREMENT_LABELS },
    demo: ['opening', 'scene', 'materials', 'dance', 'chat', 'closing'],
  };
}

function planTurn(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('输入必须是事件对象');
  if (!EVENTS.has(input.event)) throw new RangeError('未知事件');
  if (input.text !== undefined && typeof input.text !== 'string') throw new TypeError('text 必须是字符串');
  if (input.action_id !== undefined && !ACTION_BY_ID.has(input.action_id)) throw new RangeError('未知动作 ID');
  if (input.event === 'action') {
    if (!ACTION_BY_ID.has(input.action_id)) throw new RangeError('action 事件必须提供已知动作 ID');
    return { intent: 'action', text: '', action_id: input.action_id, needs_llm: false };
  }
  if (input.event === 'opening') return spoken('opening', { action_id: 'welcome' });
  if (input.event === 'closing') return spoken('closing', { action_id: 'farewell' });
  if (input.event === 'scene_ready') return spoken('scene_ready');

  const text = (input.text || '').normalize('NFKC').trim().replace(/\s+/gu, '');
  if (!text || NEGATION.test(text.replace(/别头发/gu, '整理头发')) || DISCUSSION.test(text)) return spoken('reply');
  const requests = text.split(/[，,。.!！?？;；、]|然后|接着|并且|顺便|之后|再(?=跳|换|挥|比|做|来|表演)/u)
    .filter(Boolean).map(requestText);
  if (requests.some(isClosing)) return spoken('closing', { action_id: 'farewell' });
  if (requests.some(isScene)) return spoken('scene', { editing_type: 'background_replacement' });
  if (requests.some(isMaterials)) return spoken('materials');
  const actions = new Set(requests.map(actionFor).filter(Boolean));
  if (actions.has('small_dance')) return spoken('dance', { action_id: 'small_dance' });
  if (actions.size === 1) return spoken('action', { action_id: [...actions][0] });
  return spoken('reply');
}

module.exports = { getManifest, planTurn };
