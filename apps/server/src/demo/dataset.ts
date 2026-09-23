import { echoPayload, historyPayload, inboundPayload, type InboundSpec, type PhoneMeta } from './payloads.ts';

// Fictional demo customers of the example restaurant in business-profile.example.md.
// Covers Gulf, Egyptian and Levantine Arabic, Arabizi, English, a voice note,
// replies typed on the phone (coexistence echoes) and synced chat history.

type Step =
  | { minutesAgo: number; from: string; msg: InboundSpec }
  | { minutesAgo: number; echoTo: string; text: string }
  | { history: string; lines: { from: 'customer' | 'business'; text: string; minutesAgo: number }[] };

export const CONTACTS: Record<string, { waId: string; name: string }> = {
  khalid: { waId: '971501110001', name: 'Khalid Al Mansoori' },
  sarah: { waId: '447700900123', name: 'Sarah Thompson' },
  mona: { waId: '201001234567', name: 'Mona Adel' },
  omar: { waId: '971552220002', name: 'Omar B.' },
  layla: { waId: '96170123456', name: 'Layla Haddad' },
  james: { waId: '971503334444', name: 'James Wilson' },
  fatima: { waId: '971504445555', name: 'Fatima Al Zaabi' },
  ahmed: { waId: '966501231234', name: 'Ahmed Hassan' },
  spam: { waId: '15550001111', name: 'Global Invest' },
};

const H = 60;
const D = 24 * H;

export const DEMO_STEPS: Step[] = [
  // Synced from the phone at onboarding: an older catering enquiry, window now closed.
  {
    history: 'fatima',
    lines: [
      { from: 'customer', text: 'مساء الخير، عندكم خدمة كيترنج لعزومة ٣٠ شخص يوم الخميس الجاي؟', minutesAgo: 3 * D + 40 },
      { from: 'business', text: 'مساء النور! أكيد، نحتاج إشعار قبل ٤٨ ساعة وعربون ٣٠٪. أرسل لك المنيو؟', minutesAgo: 3 * D + 25 },
      { from: 'customer', text: 'ايه ارسليه لو سمحتي، وكم تقريباً السعر للشخص؟', minutesAgo: 3 * D + 20 },
      { from: 'business', text: 'بين ٩٥ و١٤٠ درهم للشخص حسب الاختيارات 🌿', minutesAgo: 3 * D + 5 },
      { from: 'customer', text: 'تمام، بفكر وأرد عليكم', minutesAgo: 3 * D },
    ],
  },

  // English feedback thread: answered earlier via the phone app, then a thank-you.
  { minutesAgo: 20 * H, from: 'james', msg: { kind: 'text', text: 'Hey, do you deliver to Palm Jumeirah? Would love the mixed grill for 2' } },
  { minutesAgo: 20 * H - 12, echoTo: 'james', text: 'Hi James! Yes we do, about 40 minutes. Shall I place the order?' },
  { minutesAgo: 20 * H - 10, from: 'james', msg: { kind: 'text', text: 'Yes please, cash on delivery' } },
  { minutesAgo: 20 * H - 8, echoTo: 'james', text: 'Done ✅ order #5512 is on its way.' },
  { minutesAgo: 9 * H, from: 'james', msg: { kind: 'text', text: 'The mixed grill last night was amazing, thanks guys!' } },

  // Saudi customer chasing a late order; the team replied from the phone, then he follows up.
  { minutesAgo: 95, from: 'ahmed', msg: { kind: 'text', text: 'Hi, I ordered 40 minutes ago, order #5530. Any update?' } },
  { minutesAgo: 88, echoTo: 'ahmed', text: 'Hi Ahmed, checking with the kitchen now 🙏' },
  { minutesAgo: 25, from: 'ahmed', msg: { kind: 'text', text: "It's been 70 minutes and it still hasn't arrived. Where is my order #5530?" } },

  // Gulf Arabic, angry complaint -> urgent.
  { minutesAgo: 130, from: 'khalid', msg: { kind: 'text', text: 'السلام عليكم، طلبت أمس من عندكم مشاوي' } },
  {
    minutesAgo: 42,
    from: 'khalid',
    msg: { kind: 'text', text: 'طلبي رقم 4821 تأخر ساعة ونص والأكل وصل بارد 😡 خدمة سيئة جداً وهذي آخر مرة أطلب منكم' },
  },
  { minutesAgo: 41, from: 'khalid', msg: { kind: 'image', caption: 'شوف الأكل كيف وصل' } },

  // Levantine voice note about a double charge -> urgent payment issue.
  {
    minutesAgo: 33,
    from: 'layla',
    msg: { kind: 'voice', transcript: 'مرحبا، انخصم مني المبلغ مرتين على البطاقة لطلب مبارح، بدي حدا يرجعلي المصاري بأسرع وقت لو سمحتوا' },
  },

  // English booking with an allergy question.
  {
    minutesAgo: 27,
    from: 'sarah',
    msg: { kind: 'text', text: 'Hi! Can I book a table for 8 this Friday at 8pm? One of us is allergic to nuts, is that ok?' },
  },

  // Egyptian Arabic catering price question.
  {
    minutesAgo: 18,
    from: 'mona',
    msg: { kind: 'text', text: 'لو سمحت عايزة أعرف سعر صينية الكبة لـ ٢٠ شخص وهل في توصيل للمارينا؟' },
  },

  // Arabizi booking.
  { minutesAgo: 12, from: 'omar', msg: { kind: 'text', text: 'Salam, ana 3ayez a7gez table l 4 bokra el sa3a 9 bel leil' } },

  // Spam.
  { minutesAgo: 7, from: 'spam', msg: { kind: 'text', text: 'Earn 300% monthly with our crypto investment opportunity!! click here bit.ly/xx' } },
];

/** Expand the dataset into webhook payloads, oldest first. */
export function demoPayloads(meta: PhoneMeta, now = new Date()): unknown[] {
  const at = (m: number) => new Date(now.getTime() - m * 60_000);
  const out: { minutesAgo: number; payload: unknown }[] = [];
  for (const step of DEMO_STEPS) {
    if ('history' in step) {
      const c = CONTACTS[step.history]!;
      const lines = step.lines.map((l) => ({ from: l.from, text: l.text, at: at(l.minutesAgo) }));
      out.push({ minutesAgo: step.lines[0]!.minutesAgo, payload: historyPayload(meta, c.waId, lines) });
    } else if ('echoTo' in step) {
      out.push({ minutesAgo: step.minutesAgo, payload: echoPayload(meta, CONTACTS[step.echoTo]!.waId, step.text, at(step.minutesAgo)) });
    } else {
      out.push({ minutesAgo: step.minutesAgo, payload: inboundPayload(meta, CONTACTS[step.from]!, step.msg, at(step.minutesAgo)) });
    }
  }
  return out.sort((a, b) => b.minutesAgo - a.minutesAgo).map((o) => o.payload);
}

/** Messages the live simulator sends one by one (`pnpm simulate`). */
export const LIVE_MESSAGES: { contact: { waId: string; name: string }; msg: InboundSpec }[] = [
  { contact: { waId: '971509990001', name: 'Noura' }, msg: { kind: 'text', text: 'مرحبا، هل المطعم مفتوح الحين؟ ودي أطلب فطور' } },
  { contact: { waId: '971509990002', name: 'Daniel' }, msg: { kind: 'text', text: 'URGENT: my son had an allergic reaction after your falafel wrap, which ingredients are in it?' } },
  { contact: { waId: '201009990003', name: 'Youssef' }, msg: { kind: 'voice', transcript: 'ازيكم، عايز أغير معاد الحجز بتاعي من الساعة ٨ للساعة ١٠ لو ينفع' } },
  { contact: { waId: '971509990004', name: 'Priya' }, msg: { kind: 'text', text: 'Can I pay by bank transfer for a catering order? Need an invoice for my company.' } },
  { contact: { waId: '971509990001', name: 'Noura' }, msg: { kind: 'text', text: 'شكراً 🌸' } },
];
