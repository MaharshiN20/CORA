// "Call 911" in the five offered languages that have no generated templates (ko, ar, pt, tl, ht).
// Short, hand-written and numeric-safe, used by i18n.localizeUrgent() before any model is asked, so an
// emergency reply reaches these patients in their own language instantly even when the model is down,
// slow or untrusted (audit 2026-10-11: they got the English text).
//
// REVIEW STATUS: written by a non-native author (AI-assisted); no native speaker has reviewed these
// sentences. They are deliberately plain. Record a review in REVIEWED below. Until then the English
// text is NOT appended, so keep each sentence unambiguous: "call 911 now".
export const REVIEWED = { ko: null, ar: null, pt: null, tl: null, ht: null };

export const URGENT_FALLBACK = {
  ko: {
    red_911: '🚨 {name}님, 말씀하신 증상은 응급일 수 있습니다. 지금 바로 911에 전화하세요. 의료진과 {caregiver}에게도 알렸습니다.',
    red_interrupt: '🚨 심각해 보입니다. 가슴 통증이나 숨쉬기 어려움이 있으면 지금 바로 911에 전화하세요. 의료진에게 알렸습니다.',
    proxy_red_911: '🚨 말씀하신 증상은 응급일 수 있습니다. {name}님을 위해 지금 바로 911에 전화하세요. 의료진에게 알렸습니다.',
    red_lock: '🚨 {name}님, 증상이 응급일 수 있습니다. 지금 바로 911에 전화하세요. 간호사에게 알렸고 곧 연락드립니다. 이미 전화하셨다면 상담원의 안내를 따르세요.',
    proxy_red_lock: '🚨 {name}님이 응급 상황일 수 있습니다. 지금 바로 {name}님을 위해 911에 전화하세요. 의료진에게 알렸습니다.',
    safety_net_911: '가슴 통증이 있거나 숨을 쉴 수 없으면 즉시 911에 전화하세요.',
  },
  ar: {
    red_911: '🚨 {name}، ما وصفتَه قد يكون حالة طارئة. اتصل بالرقم 911 الآن. وقد أبلغتُ فريقك الطبي و{caregiver}.',
    red_interrupt: '🚨 هذا يبدو خطيرًا. إذا كان لديك ألم في الصدر أو صعوبة في التنفس، اتصل بالرقم 911 الآن. وقد أبلغتُ فريقك الطبي.',
    proxy_red_911: '🚨 ما وصفتَه قد يكون حالة طارئة. اتصل بالرقم 911 الآن من أجل {name}. وقد أبلغتُ الفريق الطبي.',
    red_lock: '🚨 {name}، أعراضك قد تكون حالة طارئة. اتصل بالرقم 911 الآن. تم إبلاغ الممرضة وستتصل بك. إذا اتصلتَ بالفعل فاتبع تعليمات موظف الطوارئ.',
    proxy_red_lock: '🚨 قد يكون {name} في حالة طارئة. اتصل بالرقم 911 الآن من أجل {name}. تم إبلاغ الفريق الطبي.',
    safety_net_911: 'إذا كان لديك ألم في الصدر أو لا تستطيع التنفس، اتصل بالرقم 911 فورًا.',
  },
  pt: {
    red_911: '🚨 {name}, o que você descreveu pode ser uma emergência. LIGUE PARA O 911 AGORA. Também avisei sua equipe de saúde e {caregiver}.',
    red_interrupt: '🚨 Isso parece sério. Se você tem dor no peito ou dificuldade para respirar, LIGUE PARA O 911 AGORA. Avisei sua equipe de saúde.',
    proxy_red_911: '🚨 O que você descreveu pode ser uma emergência. LIGUE PARA O 911 AGORA para {name}. Avisei a equipe de saúde.',
    red_lock: '🚨 {name}, seus sintomas podem ser uma emergência. LIGUE PARA O 911 AGORA. Sua enfermeira foi avisada e vai ligar para você. Se você já ligou, siga as instruções do atendente.',
    proxy_red_lock: '🚨 {name} pode estar com uma emergência. LIGUE PARA O 911 AGORA para {name}. A equipe de saúde foi avisada.',
    safety_net_911: 'Se você tem dor no peito ou não consegue respirar, ligue para o 911 imediatamente.',
  },
  tl: {
    red_911: '🚨 {name}, ang inilarawan mo ay maaaring emergency. TUMAWAG SA 911 NGAYON. Inabisuhan ko na rin ang iyong care team at si {caregiver}.',
    red_interrupt: '🚨 Mukhang seryoso iyan. Kung may sakit ka sa dibdib o hirap huminga, TUMAWAG SA 911 NGAYON. Inabisuhan ko ang iyong care team.',
    proxy_red_911: '🚨 Ang inilarawan mo ay maaaring emergency. TUMAWAG SA 911 NGAYON para kay {name}. Inabisuhan ko ang care team.',
    red_lock: '🚨 {name}, ang iyong mga sintomas ay maaaring emergency. TUMAWAG SA 911 NGAYON. Inabisuhan na ang iyong nurse at tatawagan ka. Kung tumawag ka na, sundin ang sinasabi ng operator.',
    proxy_red_lock: '🚨 Maaaring may emergency si {name}. TUMAWAG SA 911 NGAYON para kay {name}. Inabisuhan na ang care team.',
    safety_net_911: 'Kung may sakit ka sa dibdib o hindi ka makahinga, tumawag agad sa 911.',
  },
  ht: {
    red_911: '🚨 {name}, sa ou dekri a ka yon ijans. RELE 911 KOUNYE A. Mwen te avèti ekip swen ou a ak {caregiver} tou.',
    red_interrupt: '🚨 Sa sanble grav. Si ou gen doulè nan pwatrin oswa ou gen difikilte pou respire, RELE 911 KOUNYE A. Mwen te avèti ekip swen ou a.',
    proxy_red_911: '🚨 Sa ou dekri a ka yon ijans. RELE 911 KOUNYE A pou {name}. Mwen te avèti ekip swen an.',
    red_lock: '🚨 {name}, sentòm ou yo ka yon ijans. RELE 911 KOUNYE A. Yo te avèti enfimyè ou a e l ap rele ou. Si ou deja rele, swiv sa operatè a di ou.',
    proxy_red_lock: '🚨 {name} ka nan yon ijans. RELE 911 KOUNYE A pou {name}. Yo te avèti ekip swen an.',
    safety_net_911: 'Si ou gen doulè nan pwatrin oswa ou pa ka respire, rele 911 touswit.',
  },
};
