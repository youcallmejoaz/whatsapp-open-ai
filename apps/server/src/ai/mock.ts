import { detectScript, normalizeArabic, type ConversationSummary, type Intent, type Priority, type Triage } from '@wa/shared';
import {
  EMBEDDING_DIM,
  type AiProvider,
  type ChatLine,
  type DraftInput,
  type DraftOutput,
  type ReportInput,
  type SummarizeInput,
  type TriageInput,
} from './provider.ts';

// Deterministic keyword-based stand-in for the LLM so the whole product can be
// demoed (and tested) offline. It is intentionally simple; the real
// classification quality comes from the OpenAI provider.

const kw = (...words: string[]) => words.map(normalizeArabic);

const RULES: { intent: Intent; words: string[] }[] = [
  { intent: 'spam', words: kw('crypto', 'investment opportunity', 'click here', 'bit.ly', 'ربح مضمون') },
  {
    intent: 'complaint',
    words: kw(
      'broken', 'damaged', 'late', 'never arrived', 'not arrived', "hasn't arrived", 'worst', 'terrible', 'disappointed',
      'complaint', 'wrong item', 'cold', 'مكسور', 'متأخر', 'ما وصل', 'لم يصل', 'ماوصل', 'سيء', 'سيئ', 'خربان', 'شكوى', 'غلط',
      'تالف', 'بارد', 'mesh wasal', 'msh wasal', 'wa7sh',
    ),
  },
  {
    intent: 'payment',
    words: kw('invoice', 'payment', 'pay ', 'card', 'transfer', 'receipt', 'charged', 'refund', 'دفع', 'فاتورة', 'تحويل', 'بطاقة', 'إيصال', 'انخصم', 'استرجاع', 'فلوس'),
  },
  {
    intent: 'booking',
    words: kw('book', 'reservation', 'appointment', 'table for', 'reschedule', 'حجز', 'احجز', 'موعد', 'طاولة', 'a7gez', '7agz'),
  },
  {
    intent: 'order',
    words: kw('order', 'buy', 'purchase', 'price', 'how much', 'delivery', 'menu', 'طلب', 'اطلب', 'سعر', 'بكم', 'توصيل', 'اشتري', 'منيو', 'قائمة', '3ayez', '3awz'),
  },
  {
    intent: 'support',
    words: kw('not working', 'error', 'help', 'problem', 'issue', 'مشكلة', 'ما يشتغل', 'مساعدة', 'عطل'),
  },
  {
    intent: 'feedback',
    words: kw('great', 'amazing', 'excellent', 'loved', 'delicious', 'ممتاز', 'رائع', 'لذيذ', 'حلو', 'يعطيكم العافية'),
  },
  {
    intent: 'greeting',
    words: kw('hi', 'hello', 'hey', 'salam', 'thanks', 'thank you', 'ok', 'السلام عليكم', 'مرحبا', 'هلا', 'صباح الخير', 'شكرا', 'مشكور', 'تسلم', 'تمام', 'shukran'),
  },
];

const URGENT = kw(
  'urgent', 'asap', 'emergency', 'lawyer', 'legal', 'fraud', 'scam', 'police', 'charged twice', 'double charged',
  'allergic reaction', 'hospital', 'عاجل', 'ضروري', 'محامي', 'احتيال', 'نصب', 'مرتين', 'فورا', 'حالا', 'حساسية', 'مستشفى',
);
const NEGATIVE = kw('worst', 'terrible', 'angry', 'never again', 'disappointed', 'سيء', 'سيئ', 'زعلان', 'مستحيل', 'آخر مرة', 'wa7sh');
const QUESTION_START = /^(what|when|where|how|why|do you|can i|can you|is it|are you|هل|متى|وين|فين|كيف|ليش|ايش|شو|قديش|كم|امتى|ezay|emta|feen)\b/;

const INTENT_LABEL: Record<'en' | 'ar', Record<Intent, string>> = {
  en: {
    order: 'Order enquiry', complaint: 'Complaint', question: 'Question', booking: 'Booking request', payment: 'Payment issue',
    support: 'Support request', feedback: 'Feedback', greeting: 'Greeting', spam: 'Likely spam', other: 'Message',
  },
  ar: {
    order: 'استفسار عن طلب', complaint: 'شكوى', question: 'سؤال', booking: 'طلب حجز', payment: 'مسألة دفع',
    support: 'طلب دعم', feedback: 'ملاحظات', greeting: 'تحية', spam: 'رسالة مزعجة محتملة', other: 'رسالة',
  },
};

const has = (text: string, words: string[]) => words.filter((w) => (/^[a-z ]+$/.test(w) ? new RegExp(`\\b${w.trim()}\\b`).test(text) : text.includes(w)));

function classify(raw: string): { intent: Intent; matched: string[]; urgent: string[]; negative: boolean; question: boolean } {
  const text = normalizeArabic(raw);
  const urgent = has(text, URGENT);
  const question = text.includes('?') || QUESTION_START.test(text);
  for (const rule of RULES) {
    const matched = has(text, rule.words);
    if (matched.length === 0) continue;
    // "thanks, but my order is late" should not be a greeting.
    if (rule.intent === 'greeting' && (question || text.length > 40)) continue;
    return { intent: rule.intent, matched, urgent, negative: has(text, NEGATIVE).length > 0, question };
  }
  return { intent: question ? 'question' : 'other', matched: [], urgent, negative: has(text, NEGATIVE).length > 0, question };
}

function languageOf(text: string): string {
  const s = detectScript(text);
  if (s === 'arabizi') return 'ar-Latn';
  if (s === 'ar' || s === 'mixed') return 'ar';
  return 'en';
}

const snippet = (t: string, n = 70) => (t.length > n ? `${t.slice(0, n)}…` : t);

function actionFor(intent: Intent, text: string, l: 'en' | 'ar'): string[] {
  const ref = normalizeArabic(text).match(/#?\b\d{3,}\b/)?.[0];
  const en: Partial<Record<Intent, string>> = {
    complaint: ref ? `Investigate order ${ref} and reply with a resolution` : 'Investigate the complaint and reply with a resolution',
    payment: ref ? `Check payment records for ${ref}` : 'Check payment records and confirm with the customer',
    booking: 'Confirm availability and reply with booking details',
    order: ref ? `Check status of order ${ref}` : 'Answer the order enquiry',
    support: 'Troubleshoot and respond',
    question: 'Answer the question',
  };
  const ar: Partial<Record<Intent, string>> = {
    complaint: ref ? `التحقق من الطلب ${ref} والرد بحل` : 'التحقق من الشكوى والرد بحل',
    payment: ref ? `مراجعة سجلات الدفع للطلب ${ref}` : 'مراجعة سجلات الدفع والتأكيد مع العميل',
    booking: 'التأكد من التوفر والرد بتفاصيل الحجز',
    order: ref ? `التحقق من حالة الطلب ${ref}` : 'الرد على استفسار الطلب',
    support: 'حل المشكلة والرد',
    question: 'الإجابة على السؤال',
  };
  const item = (l === 'ar' ? ar : en)[intent];
  return item ? [item] : [];
}

const REPLIES: Record<'en' | 'ar', Partial<Record<Intent, (name: string) => string>> & { other: (name: string) => string }> = {
  en: {
    complaint: (n) => `Hi ${n}, we're really sorry about this. I'm checking with the team right now and will get back to you shortly with a solution.`,
    payment: (n) => `Hi ${n}, thanks for flagging this. I'm checking the payment on our side and will confirm with you shortly.`,
    booking: (n) => `Hi ${n}, happy to help with your booking! Could you confirm the date, time and number of guests?`,
    order: (n) => `Hi ${n}, thanks for your message! Let me check that for you and I'll reply in a few minutes.`,
    question: (n) => `Hi ${n}, good question! Let me confirm with a colleague and get back to you shortly.`,
    support: (n) => `Hi ${n}, sorry for the trouble. Could you share a bit more detail (or a photo) so we can sort it out?`,
    feedback: (n) => `Thank you so much ${n}! We're glad you enjoyed it 😊`,
    greeting: (n) => `Hi ${n}! How can we help you today?`,
    other: (n) => `Hi ${n}, thanks for your message. A member of our team will get back to you shortly.`,
  },
  ar: {
    complaint: (n) => `أهلاً ${n}، نعتذر جداً عن هذا. أتابع الموضوع مع الفريق الآن وسأعود إليك قريباً بالحل.`,
    payment: (n) => `أهلاً ${n}، شكراً لتنبيهنا. أراجع عملية الدفع من طرفنا وسأؤكد لك قريباً.`,
    booking: (n) => `أهلاً ${n}، يسعدنا ترتيب حجزك! ممكن تأكد لنا التاريخ والوقت وعدد الأشخاص؟`,
    order: (n) => `أهلاً ${n}، شكراً لتواصلك! أتحقق من الموضوع وأرد عليك خلال دقائق.`,
    question: (n) => `أهلاً ${n}، سؤال ممتاز! أتأكد من زميلي وأرد عليك قريباً.`,
    support: (n) => `أهلاً ${n}، نعتذر عن الإزعاج. ممكن ترسل لنا تفاصيل أكثر أو صورة حتى نحل المشكلة؟`,
    feedback: (n) => `شكراً جزيلاً ${n}! سعداء أنها أعجبتك 😊`,
    greeting: (n) => `أهلاً وسهلاً ${n}! كيف نقدر نساعدك اليوم؟`,
    other: (n) => `أهلاً ${n}، شكراً لرسالتك. سيتواصل معك أحد أعضاء الفريق قريباً.`,
  },
};

const DRAFT_PRECEDENCE: Intent[] = [
  'complaint', 'payment', 'booking', 'order', 'support', 'question', 'feedback', 'greeting', 'other', 'spam',
];

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Feature-hashed bag of words + character trigrams. Good enough for demo search. */
export function hashEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const norm = normalizeArabic(text);
  const words = norm.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const feats = [...words.map((w) => `w:${w}`)];
  for (const w of words) for (let i = 0; i + 3 <= w.length + 2; i++) feats.push(`c:${` ${w} `.slice(i, i + 3)}`);
  for (const f of feats) {
    const h = fnv1a(f);
    v[h % EMBEDDING_DIM]! += f.startsWith('w:') ? 2 : 1;
  }
  const len = Math.hypot(...v) || 1;
  return v.map((x) => x / len);
}

export class MockAiProvider implements AiProvider {
  readonly name = 'mock';

  async triage(i: TriageInput): Promise<Triage> {
    const c = classify(i.message);
    let priority: Priority =
      c.intent === 'spam' || c.intent === 'greeting' || c.intent === 'feedback'
        ? 'low'
        : c.intent === 'complaint' || c.intent === 'payment'
          ? 'high'
          : 'normal';
    if (c.urgent.length > 0 || (c.intent === 'complaint' && c.negative)) priority = 'urgent';
    const needsReply = !['spam', 'greeting', 'feedback'].includes(c.intent) || c.question;
    const l = i.reportLanguage;
    const who = i.contactName ?? (l === 'ar' ? 'العميل' : 'customer');
    return {
      priority,
      needs_reply: needsReply,
      intent: c.intent,
      sentiment: c.negative || c.intent === 'complaint' ? 'negative' : c.intent === 'feedback' ? 'positive' : 'neutral',
      language: languageOf(i.message),
      summary:
        l === 'ar'
          ? `${INTENT_LABEL.ar[c.intent]} من ${who}: «${snippet(i.message)}»`
          : `${INTENT_LABEL.en[c.intent]} from ${who}: "${snippet(i.message)}"`,
      action_items: needsReply ? actionFor(c.intent, i.message, l) : [],
      reason: [...c.urgent, ...c.matched].length
        ? `keywords: ${[...c.urgent, ...c.matched].slice(0, 4).join(', ')}`
        : 'no strong signal',
    };
  }

  async summarize(i: SummarizeInput): Promise<ConversationSummary> {
    const inbound = i.messages.filter((m) => m.direction === 'in');
    const last = inbound.at(-1);
    const intents = inbound.map((m) => classify(m.text));
    const l = i.language;
    const who = i.contactName ?? (l === 'ar' ? 'العميل' : 'The customer');
    const topics = [...new Set(intents.map((c) => INTENT_LABEL[l][c.intent]))].join(l === 'ar' ? '، ' : ', ');
    const openQuestions = unansweredQuestions(i.messages).map((t) => snippet(t, 120));
    const negative = intents.some((c) => c.negative || c.intent === 'complaint');
    const positive = intents.some((c) => c.intent === 'feedback');
    return {
      summary:
        l === 'ar'
          ? `${who} أرسل ${inbound.length} رسالة (${topics}). آخر رسالة: «${snippet(last?.text ?? '')}».`
          : `${who} sent ${inbound.length} message(s) (${topics}). Latest: "${snippet(last?.text ?? '')}".`,
      open_questions: openQuestions,
      action_items: last ? actionFor(classify(last.text).intent, last.text, l) : [],
      customer_mood: negative && positive ? 'mixed' : negative ? 'negative' : positive ? 'positive' : 'neutral',
    };
  }

  async draftReply(i: DraftInput): Promise<DraftOutput> {
    // Answer everything the customer said since our last reply, led by the most important topic.
    const lastOut = i.messages.map((m) => m.direction).lastIndexOf('out');
    const pending = i.messages.slice(lastOut + 1).filter((m) => m.direction === 'in');
    const text = pending.map((m) => m.text).join('\n');
    const lang = languageOf(text);
    const l: 'en' | 'ar' = lang.startsWith('ar') ? 'ar' : 'en';
    const intent = pending
      .map((m) => classify(m.text).intent)
      .sort((a, b) => DRAFT_PRECEDENCE.indexOf(a) - DRAFT_PRECEDENCE.indexOf(b))[0] ?? 'other';
    const name = i.contactName?.split(' ')[0] ?? '';
    const make = REPLIES[l][intent] ?? REPLIES[l].other;
    return {
      body: make(name).replace(/\s+([،,!])/g, '$1').replace(/\s{2,}/g, ' '),
      language: lang,
      rationale: `Mock template for intent "${intent}" in ${l === 'ar' ? 'Arabic' : 'English'}` +
        (i.instructions ? ' (staff instructions noted but not applied by the mock provider)' : ''),
    };
  }

  async reportNarrative(i: ReportInput): Promise<string> {
    const s = i.stats;
    const topIntents = Object.entries(s.byIntent).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (i.language === 'ar') {
      return [
        `نظرة عامة (${i.periodLabel})`,
        `- ${s.inbound} رسالة واردة و${s.outbound} رسالة صادرة في ${s.conversations} محادثة.`,
        `- جهات اتصال جديدة: ${s.newContacts}.`,
        s.medianFirstResponseMinutes !== null ? `- متوسط زمن الرد الأول (الوسيط): ${s.medianFirstResponseMinutes} دقيقة.` : '',
        'ما يحتاج إلى متابعة',
        `- ${s.needsReplyOpen} محادثة بانتظار الرد، منها ${s.urgentOpen} عاجلة.`,
        ...s.actionItems.slice(0, 5).map((a) => `- ${a.contact}: ${a.item}`),
        'الاتجاهات',
        ...topIntents.map(([k, v]) => `- ${INTENT_LABEL.ar[k as Intent] ?? k}: ${v}`),
      ].filter(Boolean).join('\n');
    }
    return [
      `Overview (${i.periodLabel})`,
      `- ${s.inbound} inbound and ${s.outbound} outbound messages across ${s.conversations} conversations.`,
      `- New contacts: ${s.newContacts}.`,
      s.medianFirstResponseMinutes !== null ? `- Median first response time: ${s.medianFirstResponseMinutes} min.` : '',
      'What needs attention',
      `- ${s.needsReplyOpen} conversations waiting for a reply, ${s.urgentOpen} of them urgent.`,
      ...s.actionItems.slice(0, 5).map((a) => `- ${a.contact}: ${a.item}`),
      'Trends',
      ...topIntents.map(([k, v]) => `- ${INTENT_LABEL.en[k as Intent] ?? k}: ${v}`),
    ].filter(Boolean).join('\n');
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(hashEmbedding);
  }

  async transcribe(audio: Buffer): Promise<string> {
    return audio.toString('utf8');
  }
}

function unansweredQuestions(lines: ChatLine[]): string[] {
  const lastOut = lines.map((l) => l.direction).lastIndexOf('out');
  return lines.slice(lastOut + 1).filter((l) => l.direction === 'in' && classify(l.text).question).map((l) => l.text);
}
